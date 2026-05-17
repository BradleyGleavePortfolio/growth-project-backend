import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AiGatewayConfig } from './ai-gateway.config';
import { AiRedactionService, RedactionSummary } from './ai-redaction.service';
import { AiProviderRegistry } from './providers/provider-registry';
import { AiChatTurn, AiProviderResponse } from './providers/ai-provider.types';
import { ProvenanceRef } from './data-quality.types';

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
  ) {}

  async invoke(req: AiGatewayRequest): Promise<AiGatewayResult> {
    if (!req.requester || !req.requester.id) {
      // Defensive: every controller calling the gateway is behind
      // JwtAuthGuard, but the gateway is also reachable from background
      // jobs and we want a hard failure rather than a logged anonymous row.
      throw new Error('AiGatewayService.invoke called without requester');
    }
    const requestId = randomUUID();
    const resolved = this.config.resolve(req.capability);
    const adapter = this.providers.resolve(resolved.provider);

    // 1. Redact free-text inputs before they touch any provider client.
    const redacted = this.redaction.redact(req.userMessage ?? '');
    const redactedHistory = (req.conversationHistory ?? []).map((t) => ({
      role: t.role,
      content: this.redaction.redact(t.content).text,
    }));

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

    // 4. Approval workflow. If the capability requires human approval,
    //    or if the gateway is in stub mode (no real model behind the
    //    output), the caller must treat the output as a draft.
    const approvalRequired = resolved.requireApproval;
    let approvalDraftId: string | null = null;
    let approvalStatus: AiGatewayResult['approvalStatus'] = 'not_required';

    if (approvalRequired) {
      const draft = await this.prisma.aiActionDraft.create({
        data: {
          capability: req.capability,
          status: 'pending',
          requester_id: req.requester.id,
          subject_user_id: req.subjectUserId ?? null,
          tenant_coach_id: req.tenantCoachId ?? null,
          payload: (req.proposedActionPayload ?? { reply: response.text }) as Prisma.InputJsonValue,
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
