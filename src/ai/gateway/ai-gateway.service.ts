import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { PrismaService } from '../../prisma.service';
import { AiGatewayConfig, DRAFT_CAPABILITY_PREFIX } from './ai-gateway.config';
import { AiRedactionService, RedactionSummary } from './ai-redaction.service';
import { AiProviderRegistry } from './providers/provider-registry';
import { AiChatTurn, AiProviderResponse } from './providers/ai-provider.types';
import { ProvenanceRef } from './data-quality.types';
import {
  COACH_MESSAGE_CAPABILITY,
  assertCoachMessagePayload,
} from './materialisers/coach-message.materialiser';
import {
  ASSIGN_WORKOUT_CAPABILITY,
  assertAssignWorkoutPayload,
} from './materialisers/assign-workout.materialiser';
import {
  ASSIGN_MEAL_PLAN_CAPABILITY,
  assertAssignMealPlanPayload,
} from './materialisers/assign-meal-plan.materialiser';
import {
  SEND_NOTIFICATION_CAPABILITY,
  assertSendNotificationPayload,
} from './materialisers/send-notification.materialiser';
import { AuditService } from '../../audit/audit.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { CoachAiBudgetExhaustedException } from '../../ai-credits/budget-exhausted.exception';
import {
  COACH_AI_BUDGET_EXHAUSTED_CODE,
  COACH_AI_METERED_CAPABILITIES,
} from '../../ai-credits/ai-credits.constants';

// Caller-side surface. Controllers and services hand the gateway a
// "request" describing what they want done, plus the already-permission-
// scoped context (the gateway DOES NOT pull data from the database
// itself — context retrieval is the responsibility of capability-specific
// services so tenant boundaries stay explicit). The gateway returns the
// model output, the audit row id, and an approval draft id when the
// capability is configured to require human approval.

export interface AiGatewayRequest {
  capability: string;
  // Authenticated identity of the caller. Required — the gateway refuses
  // unauthenticated calls so audit rows always have a requester.
  requester: { id: string; role: string };
  // The client/student whose data the call concerns. Optional for
  // capabilities that operate on the requester's own scope.
  subjectUserId?: string;
  // Coach tenant the call is bound to (for owner-impersonation paths).
  tenantCoachId?: string;
  // Free-text user input (chat message, note). Will be redacted before
  // being sent to the provider.
  userMessage: string;
  // Permissioned context that an upstream service already fetched.
  // The gateway treats it as opaque text plus a list of provenance refs.
  systemPrompt: string;
  conversationHistory?: AiChatTurn[];
  provenance?: ProvenanceRef[];
  maxTokens?: number;
  temperature?: number;
  // Capability-specific proposed action; required for capabilities
  // that map to a human-approval draft (e.g. draft.coach_message).
  proposedActionPayload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AiGatewayResult {
  requestId: string;
  auditId: string;
  approvalDraftId: string | null;
  approvalRequired: boolean;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected' | 'expired';
  enabled: boolean;
  provider: string;
  model: string;
  reply: string;
  redactionsApplied: RedactionSummary;
  provenance: ProvenanceRef[];
  draftMode: boolean; // true whenever the caller must treat the output as draft (always true under stub or pending approval)
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(
    private prisma: PrismaService,
    private config: AiGatewayConfig,
    private redaction: AiRedactionService,
    private providers: AiProviderRegistry,
    // Stream 1 — combined coach+client AI budget. @Optional() so legacy
    // unit tests that construct AiGatewayService without the credits
    // module still boot. When present, every metered capability is gated
    // by canCharge() pre-call and atomically recorded via recordUsage()
    // post-call. When absent (legacy boot), the gateway behaves as
    // before — no metering, no 402.
    @Optional() private budget?: CoachAIBudgetService,
    // Stream 2 — AuditService is @Optional() so unit tests can construct
    // the gateway without booting the audit module. When present, the
    // gateway writes an audit row on every `draft.*` capability that is
    // refused because the requester role is not coach/owner — primary
    // defence for the spec §3 hard role boundary.
    @Optional() private audit?: AuditService,
  ) {}

  async invoke(req: AiGatewayRequest): Promise<AiGatewayResult> {
    if (!req.requester || !req.requester.id) {
      // Defensive: every controller calling the gateway is behind
      // JwtAuthGuard, but the gateway is also reachable from background
      // jobs and we want a hard failure rather than a logged anonymous row.
      throw new Error('AiGatewayService.invoke called without requester');
    }

    // Stream 2 §3 — hard role boundary. Any `draft.*` capability is a
    // coach/owner-only operation. The client AI surface (`/ai/chat` etc.)
    // must NEVER be able to mint a `draft.coach_message`,
    // `draft.assign_workout`, `draft.assign_meal_plan`, or
    // `draft.send_notification`. This is the second of three enforcement
    // layers (controller guard is the first; per-materialiser creator-
    // role assertion is the third). Belt-and-braces: even if a future
    // controller is added without the coach guard, the gateway refuses.
    //
    // The audit-log write is fire-and-forget at write time (AuditService
    // swallows write errors internally and logs them), so a transient
    // audit-table outage does not turn this 403 into a 500.
    if (
      req.capability.startsWith(DRAFT_CAPABILITY_PREFIX) &&
      req.requester.role !== 'coach' &&
      req.requester.role !== 'owner'
    ) {
      this.logger.warn(
        {
          event: 'AI_GATEWAY_DRAFT_ROLE_REJECTED',
          capability: req.capability,
          requesterId: req.requester.id,
          requesterRole: req.requester.role,
          subjectUserId: req.subjectUserId ?? null,
          ip: req.ip ?? null,
        },
        `draft capability ${req.capability} refused for role=${req.requester.role}`,
      );
      if (this.audit) {
        // Don't await — AuditService is fire-and-forget internally; we
        // just want the row written without holding the 403 response
        // on the audit-table round-trip. AuditService catches its own
        // errors.
        void this.audit.write({
          action: 'AI_GATEWAY_DRAFT_ROLE_REJECTED',
          actorId: req.requester.id,
          actorRole: req.requester.role,
          targetUserId: req.subjectUserId ?? null,
          targetType: 'ai_capability',
          targetId: req.capability,
          tenantCoachId: req.tenantCoachId ?? null,
          ip: req.ip ?? null,
          userAgent: req.userAgent ?? null,
          metadata: { reason: 'role_not_permitted' },
        });
      }
      throw new ForbiddenException({
        error: 'AI_DRAFT_ROLE_FORBIDDEN',
        capability: req.capability,
        message:
          'Only coaches and owners can invoke draft capabilities. The client AI must not reach this gateway path.',
      });
    }

    const requestId = randomUUID();
    const resolved = this.config.resolve(req.capability);
    const adapter = this.providers.resolve(resolved.provider);

    // Stream 1 — pre-call budget gate. Skip for capabilities not in the
    // metered set (e.g. internal admin probes) and when the gateway is
    // disabled (no real provider call will happen, so no Anthropic cost).
    // The head-coach resolution maps sub-coaches onto their head's budget.
    const budgetCoachId = this.budget
      ? await this.resolveBudgetCoachId(req)
      : null;
    if (
      this.budget &&
      budgetCoachId &&
      resolved.enabled &&
      COACH_AI_METERED_CAPABILITIES.has(req.capability)
    ) {
      // We don't know the exact cost of an Anthropic call until it
      // returns, but the pre-call gate's only job is to refuse when the
      // coach is already AT or OVER the cap. A zero-cost canCharge tells
      // us "is there ANY headroom left?" — enough to draw the 402 line.
      // The atomic post-call recordUsage closes the actual overshoot
      // window.
      const pre = await this.budget.canCharge(budgetCoachId, 0);
      if (pre.budget.actual_used_cents >= pre.budget.total_actual_available_cents) {
        const dto = await this.budget.getBudgetDto(budgetCoachId);
        throw new CoachAiBudgetExhaustedException({
          code: COACH_AI_BUDGET_EXHAUSTED_CODE,
          message: 'AI budget exhausted — top up to continue',
          pack_options_cents: dto.pack_options_cents,
          custom_pack_bounds_cents: dto.custom_pack_bounds_cents,
          budget: {
            period_end: dto.period_end,
            base_displayed_cents: dto.base_displayed_cents,
            pack_displayed_cents: dto.pack_displayed_cents,
            used_displayed_cents: dto.used_displayed_cents,
            remaining_displayed_cents: dto.remaining_displayed_cents,
          },
        });
      }
    }

    // 1. Redact free-text inputs before they touch any provider client.
    const redacted = this.redaction.redact(req.userMessage ?? '');
    // A3 — role whitelist. Client-supplied conversation history can carry a
    // forged 'system' (or any other) role; passing it through verbatim is a
    // prompt-injection vector — a client could smuggle privileged
    // instructions to the provider. We narrow every history turn to the
    // 'user'/'assistant' pair: anything that is not 'assistant' is demoted
    // to 'user' so its CONTENT is preserved (no silent drop) but it can
    // never reach a provider with a privileged role. The trusted system
    // prompt is supplied separately by the gateway (req.systemPrompt).
    const redactedHistory: AiChatTurn[] = (req.conversationHistory ?? []).map(
      (t) => ({
        role: t.role === 'assistant' ? 'assistant' : 'user',
        content: this.redaction.redact(t.content).text,
      }),
    );

    // 2. Build provider request. The system prompt is provided by the
    //    caller (already permission-scoped) and is NOT redacted — the
    //    structured CLIENT_CONTEXT block is built from sanitized fields.
    const turns: AiChatTurn[] = [
      ...redactedHistory,
      { role: 'user', content: redacted.text },
    ];

    // 3. Hash inputs/outputs for the audit row. Real prompt/response
    //    bodies are intentionally NOT persisted.
    const promptHash = sha256(req.systemPrompt + '\n' + turns.map((t) => `${t.role}:${t.content}`).join('\n'));

    let response: AiProviderResponse;
    let errorMsg: string | null = null;
    try {
      response = await adapter.complete({
        capability: req.capability,
        systemPrompt: req.systemPrompt,
        turns,
        maxTokens: req.maxTokens ?? 600,
        temperature: req.temperature ?? 0.7,
        requestId,
      });
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Gateway provider call failed (${resolved.provider}): ${errorMsg}`);
      // Fail closed — return the stub even if a real provider blew up,
      // so the caller never sees a 500 from the AI surface.
      response = await this.providers.resolve('stub').complete({
        capability: req.capability,
        systemPrompt: req.systemPrompt,
        turns,
        maxTokens: req.maxTokens ?? 600,
        temperature: req.temperature ?? 0.7,
        requestId,
      });
    }

    const responseHash = sha256(response.text);
    const provenance = req.provenance ?? [];
    const redactionSummary = redacted.summary;

    // Stream 1 — post-call atomic usage recording. Runs ONLY when the
    // provider call actually executed (no recording on stub fallback —
    // that path didn't hit Anthropic and so has no cost) AND when the
    // capability is in the metered set. The actual cost is derived from
    // the provider's token estimates; we fall back to a conservative
    // default (5 cents) when the provider didn't return estimates so a
    // metering gap can't silently leak through.
    if (
      this.budget &&
      budgetCoachId &&
      response.enabled &&
      COACH_AI_METERED_CAPABILITIES.has(req.capability) &&
      !errorMsg
    ) {
      const actualCostCents = estimateAnthropicCostCents(response);
      try {
        await this.budget.recordUsage({
          coachId: budgetCoachId,
          actualCostCents,
          capability: req.capability,
          contextId: req.subjectUserId ?? null,
        });
      } catch (err) {
        // Best-effort: a budget write failure must not 500 the AI surface
        // (the work already completed). Log + continue. The audit row
        // below will still capture the request so reconciliation jobs
        // can replay against billable activity.
        this.logger.error(
          `Budget recordUsage failed for capability=${req.capability}: ${(err as Error).message}`,
        );
      }
    }

    // 4. Approval workflow. If the capability requires human approval,
    //    or if the gateway is in stub mode (no real model behind the
    //    output), the caller must treat the output as a draft.
    const approvalRequired = resolved.requireApproval;
    let approvalDraftId: string | null = null;
    let approvalStatus: AiGatewayResult['approvalStatus'] = 'not_required';

    if (approvalRequired) {
      // PR AI-3 (PRODUCT-1): validate capability-specific payload BEFORE
      // persisting the draft. This shifts the failure earlier — a malformed
      // payload never lands in the database, so the coach never sees a
      // broken draft card. Each capability that has a materialiser also
      // owns its schema; capabilities without a materialiser fall through
      // to the legacy behaviour (any-shape payload accepted) so we don't
      // break paths that haven't migrated yet.
      const proposedPayload = req.proposedActionPayload ?? { reply: response.text };
      // Stream 2 — capability-specific payload validation BEFORE the
      // draft row is persisted. Mirrors PR AI-3's pattern for
      // coach_message and adds the three Stream 2 capabilities. A
      // malformed payload never lands in the database, so the coach
      // never sees a broken draft card.
      const PAYLOAD_VALIDATORS: Record<string, (raw: unknown) => unknown> = {
        [COACH_MESSAGE_CAPABILITY]: assertCoachMessagePayload,
        [ASSIGN_WORKOUT_CAPABILITY]: assertAssignWorkoutPayload,
        [ASSIGN_MEAL_PLAN_CAPABILITY]: assertAssignMealPlanPayload,
        [SEND_NOTIFICATION_CAPABILITY]: assertSendNotificationPayload,
      };
      const validator = PAYLOAD_VALIDATORS[req.capability];
      if (validator) {
        try {
          validator(proposedPayload);
        } catch (err) {
          if (err instanceof ZodError) {
            throw new BadRequestException({
              error: 'AI_DRAFT_PAYLOAD_INVALID',
              capability: req.capability,
              issues: err.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
                code: i.code,
              })),
            });
          }
          throw err;
        }
      }
      const draft = await this.prisma.aiActionDraft.create({
        data: {
          capability: req.capability,
          status: 'pending',
          requester_id: req.requester.id,
          subject_user_id: req.subjectUserId ?? null,
          tenant_coach_id: req.tenantCoachId ?? null,
          payload: proposedPayload as Prisma.InputJsonValue,
          rationale: response.text.slice(0, 1000),
          redacted_inputs: redactionSummary as unknown as Prisma.InputJsonValue,
          provenance: provenance as unknown as Prisma.InputJsonValue,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      approvalDraftId = draft.id;
      approvalStatus = 'pending';
    }

    // 5. Audit row — best-effort write. If audit insertion fails the
    //    request still returns successfully to the caller, but an error
    //    is logged so ops can investigate. (Same posture AuditService
    //    uses — a transient outage in the audit table must not 500
    //    every AI surface.)
    let auditId = '';
    try {
      const audit = await this.prisma.aiRequestAudit.create({
        data: {
          request_id: requestId,
          capability: req.capability,
          requester_id: req.requester.id,
          requester_role: req.requester.role,
          subject_user_id: req.subjectUserId ?? null,
          tenant_coach_id: req.tenantCoachId ?? null,
          provider: response.provider,
          model: response.model,
          enabled: response.enabled,
          context_source_count: provenance.length,
          context_source_refs: provenance as unknown as Prisma.InputJsonValue,
          redactions_applied: redactionSummary as unknown as Prisma.InputJsonValue,
          prompt_token_estimate: response.promptTokenEstimate ?? null,
          response_token_estimate: response.responseTokenEstimate ?? null,
          prompt_hash: promptHash,
          response_hash: responseHash,
          approval_status: approvalStatus,
          approval_draft_id: approvalDraftId,
          error: errorMsg,
          ip: req.ip ?? null,
          user_agent: req.userAgent ?? null,
          metadata: ({
            resolved_reason: resolved.reason ?? null,
            provider_meta: response.meta ?? null,
          } as unknown) as Prisma.InputJsonValue,
        },
      });
      auditId = audit.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AI audit write failed for capability=${req.capability}: ${msg}`);
    }

    return {
      requestId,
      auditId,
      approvalDraftId,
      approvalRequired,
      approvalStatus,
      enabled: response.enabled,
      provider: response.provider,
      model: response.model,
      reply: response.text,
      redactionsApplied: redactionSummary,
      provenance,
      // Caller MUST mark output as draft if either: no real model ran,
      // or the capability requires human approval. The two combine.
      draftMode: !response.enabled || approvalRequired,
    };
  }

  /**
   * Resolve the head-coach id whose budget this request debits.
   *
   * Priority order:
   *   1. `tenantCoachId` if the caller stamped it (owner-impersonation
   *      paths and capabilities that explicitly scope to a coach).
   *   2. The subject's coach_id when the subject is a student (every
   *      student carries their owning coach as coach_id).
   *   3. The requester themselves when they are a coach or sub-coach
   *      (CoachAIBudgetService.resolveHeadCoachId folds sub-coaches into
   *      their head coach).
   *
   * Returns null when none of the above apply — the gateway treats null
   * as "no budget to charge" and skips metering for the call. The
   * structured log on the audit row still captures the requester so
   * out-of-band reconciliation is possible.
   */
  private async resolveBudgetCoachId(
    req: AiGatewayRequest,
  ): Promise<string | null> {
    if (!this.budget) return null;
    if (req.tenantCoachId) {
      return this.budget.resolveHeadCoachId(req.tenantCoachId);
    }
    if (req.subjectUserId) {
      // Look up the subject to see if they have a coach_id (student path).
      const subject = await this.prisma.user
        .findUnique({
          where: { id: req.subjectUserId },
          select: { id: true, role: true, coach_id: true },
        })
        .catch(() => null);
      if (subject?.coach_id) {
        return this.budget.resolveHeadCoachId(subject.coach_id);
      }
      if (subject && (subject.role === 'coach' || subject.role === 'owner')) {
        return this.budget.resolveHeadCoachId(subject.id);
      }
    }
    if (req.requester.role === 'coach' || req.requester.role === 'owner') {
      return this.budget.resolveHeadCoachId(req.requester.id);
    }
    return null;
  }

  getStatus(): AiGatewayStatus {
    const ALL_CAPABILITIES = [
      'coach_brief_draft',
      'client_path_summary',
      'check_in_summary',
      'food_log_explain',
    ];
    // Resolve config against the first known capability to get provider/enabled state.
    const resolved = this.config.resolve(ALL_CAPABILITIES[0]);
    const provider = resolved.provider;
    const gatewayEnabled = this.config.resolve('__status_probe__').enabled === true
      || ALL_CAPABILITIES.some((cap) => this.config.resolve(cap).enabled);
    const availableCapabilities = ALL_CAPABILITIES.filter(
      (cap) => this.config.resolve(cap).capabilityAllowed,
    );
    const degradedReason: string | null = !gatewayEnabled
      ? (resolved.reason ?? 'gateway_disabled')
      : null;
    return {
      available: gatewayEnabled,
      provider,
      capabilities: availableCapabilities,
      degraded_reason: degradedReason,
    };
  }
}

export interface AiGatewayStatus {
  available: boolean;
  provider: string;
  capabilities: string[];
  degraded_reason: string | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Map an AiProviderResponse to an estimated Anthropic cost in cents.
//
// Strategy: prefer the explicit token estimates when the provider
// returned them (Anthropic SDK surfaces input_tokens + output_tokens on
// the response), price them at Sonnet 4.5 list pricing (\$3/MTok input,
// \$15/MTok output as of 2026-05-28), round up to the nearest cent.
//
// When estimates are missing (stub adapter, future providers) fall back
// to a conservative default of 5 cents per call so the meter never
// silently undercounts a real call. The metering is approximate by
// design — the operator dashboard compares the sum of recordUsage cents
// against the actual Anthropic invoice and flags drift.
function estimateAnthropicCostCents(response: AiProviderResponse): number {
  const promptTok = response.promptTokenEstimate ?? null;
  const responseTok = response.responseTokenEstimate ?? null;
  if (promptTok === null && responseTok === null) {
    // Conservative default — favours over-counting on missing data.
    return 5;
  }
  const inputCostUsd = (promptTok ?? 0) * (3 / 1_000_000);
  const outputCostUsd = (responseTok ?? 0) * (15 / 1_000_000);
  const totalCents = Math.ceil((inputCostUsd + outputCostUsd) * 100);
  return Math.max(1, totalCents);
}
