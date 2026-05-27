import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CapabilityMaterializerRegistry } from './materialisers/capability-materialiser.registry';

// Human-approval workflow for consequential AI outputs. AiActionDraft
// rows land here as `pending`; an authorized human (coach for own-tenant
// drafts, owner for any draft) decides them. AI cannot self-approve —
// the service refuses any decision where decided_by_id == requester_id.
//
// Decisions are recorded both on the draft row and as an entry in the
// global AuditLog so the action is visible alongside other sensitive
// admin actions.

type Decision = 'approved' | 'rejected';

export interface DecideInput {
  draftId: string;
  decider: { id: string; role: string };
  decision: Decision;
  note?: string;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AiApprovalService {
  private readonly logger = new Logger(AiApprovalService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    // PR AI-3 (PRODUCT-1): optional so legacy unit tests that build the
    // service via `new AiApprovalService(prisma, audit)` keep compiling. In
    // production DI it's always provided via AiGatewayModule.
    @Optional()
    private materialisers: CapabilityMaterializerRegistry | null = null,
  ) {}

  async listPending(scope: { tenantCoachId?: string; subjectUserId?: string; limit?: number; status?: string }) {
    const limit = Math.min(Math.max(scope.limit ?? 50, 1), 200);
    // Allow filtering by explicit status; fall back to 'pending' when omitted so
    // existing callers that don't pass a status keep their current behaviour.
    const VALID_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
    type ValidStatus = (typeof VALID_STATUSES)[number];
    const resolvedStatus: ValidStatus =
      scope.status && (VALID_STATUSES as readonly string[]).includes(scope.status)
        ? (scope.status as ValidStatus)
        : 'pending';
    return this.prisma.aiActionDraft.findMany({
      where: {
        status: resolvedStatus,
        ...(scope.tenantCoachId ? { tenant_coach_id: scope.tenantCoachId } : {}),
        ...(scope.subjectUserId ? { subject_user_id: scope.subjectUserId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async getById(id: string) {
    const draft = await this.prisma.aiActionDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException('AI draft not found');
    return draft;
  }

  async decide(input: DecideInput) {
    const draft = await this.prisma.aiActionDraft.findUnique({
      where: { id: input.draftId },
    });
    if (!draft) throw new NotFoundException('AI draft not found');
    if (draft.status !== 'pending') {
      // Idempotency: a second approve/reject must not silently overwrite
      // the first decision. Surface a 403 so callers can refresh state.
      throw new ForbiddenException(`Draft already ${draft.status}`);
    }

    // AI never approves itself. The original requester also cannot
    // approve their OWN draft — even if the requester is a coach,
    // approving an action they themselves initiated defeats the purpose
    // of the human-in-the-loop check. Owners are still bound by this
    // rule because in a single-operator deployment that is the only
    // safety net we have.
    if (draft.requester_id && draft.requester_id === input.decider.id) {
      throw new ForbiddenException('A draft cannot be decided by its requester');
    }

    // Tenant boundary: coaches can only decide drafts inside their own
    // tenant. Owners can decide any draft. Other roles are rejected.
    if (input.decider.role !== 'owner') {
      if (input.decider.role !== 'coach') {
        throw new ForbiddenException('Approver role not permitted');
      }
      if (draft.tenant_coach_id && draft.tenant_coach_id !== input.decider.id) {
        throw new ForbiddenException('Draft is outside your tenant');
      }
    }

    const status = input.decision;

    // PR AI-3 (PRODUCT-1): for 'approved' decisions on capabilities that
    // have a registered materialiser, run materialisation BEFORE flipping
    // status. If the materialiser throws, the draft stays in 'pending' so
    // the coach can retry — recreating PRODUCT-1 (silent status flip with
    // no downstream send) is the one thing this PR exists to prevent.
    //
    // Capabilities WITHOUT a registered materialiser fall through to the
    // legacy behaviour (status flip + audit only) — that preserves the
    // inline-materialisation path used by WORKOUT_PROGRAM / MEAL_PLAN in
    // `coach-ai.service.ts:approveDraft`.
    let materialisationRef: string | null = null;
    if (status === 'approved' && this.materialisers) {
      const materialiser = this.materialisers.resolve(draft.capability);
      if (materialiser) {
        try {
          const result = await materialiser.materialize(draft);
          materialisationRef = result.ref ?? null;
          if (result.status === 'racing') {
            // P1-1: a concurrent approver holds the materialisation claim
            // but the downstream side-effect has not been observably
            // committed. Refuse to flip status — surfacing 409 lets the
            // caller retry once the winner's outcome is known, and is
            // the only way to preserve the invariant that
            // `status='approved'` implies a real downstream row when
            // such a row is expected.
            throw new ConflictException({
              error: 'AI_DRAFT_RACE_IN_FLIGHT',
              capability: draft.capability,
              reason:
                'Another approver is currently materialising this draft. Retry after their decision settles.',
            });
          }
          // `sent` / `already_materialised` carry a non-null ref;
          // `noop` is a legitimate terminal state for capabilities that
          // intentionally produce no downstream row. All three are
          // accepted; the decide-gate below distinguishes them at the
          // ref level, not via a coarse confirmed-or-not flag.
        } catch (err) {
          if (err instanceof ConflictException) {
            // Don't audit-log the race state as a materialisation failure
            // — it's a benign concurrency outcome and the winner will
            // record the success. Re-throw so the caller sees a 409.
            throw err;
          }
          // Surface as a 500 with the underlying message so the coach UI
          // can render a retry CTA. The draft remains in 'pending' status,
          // which means the next approve attempt will retry materialisation.
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Materialisation failed for draft ${draft.id} (capability=${draft.capability}): ${msg}`,
          );
          // Best-effort audit so ops can spot patterns of materialisation
          // failure even when the request 500s out.
          await this.audit
            .write({
              action: 'ai.draft_materialise_failed',
              actorId: input.decider.id,
              actorRole: input.decider.role,
              targetType: 'ai_action_draft',
              targetId: draft.id,
              targetUserId: draft.subject_user_id ?? null,
              tenantCoachId: draft.tenant_coach_id ?? null,
              ip: input.ip ?? null,
              userAgent: input.userAgent ?? null,
              metadata: {
                capability: draft.capability,
                error: msg,
              },
            })
            .catch(() => undefined);
          throw new InternalServerErrorException({
            error: 'AI_MATERIALISATION_FAILED',
            capability: draft.capability,
            reason: msg,
          });
        }
      } else {
        // No-op materialiser for this capability. Log a debug-level note so
        // the path is observable in dev without spamming production logs.
        this.logger.debug?.(
          `No materialiser registered for capability=${draft.capability}; proceeding with status flip only.`,
        );
      }
    }

    // P2-3 / P1-1 — atomic decide guard. Two concurrent approvers could both
    // pass the status==='pending' in-memory check above; without an atomic
    // gate the second writer overwrites `decided_by_id` and the audit trail
    // loses the actual decider. We therefore use updateMany with WHERE
    // status='pending' so only the first approver's update lands, and the
    // second sees count=0 and is told to retry.
    //
    // For approved decisions where a materialiser actually committed a
    // downstream row (`materialisationRef !== null`), we ADDITIONALLY
    // require `materialised_ref IS NOT NULL`. This is the invariant that
    // closes the PRODUCT-1 race (P1-1): even if a race-loser somehow
    // reached this point without observing the winner's commit, the gate
    // refuses to flip status until the downstream side-effect is visible.
    //
    // P2-A round-3: we gate on `materialisationRef !== null` rather than
    // a broader `materialisationConfirmed` flag. The previous code added
    // the clause for any non-error materialiser outcome — including
    // `noop` — which has no ref by definition, so the gate would refuse
    // to flip and 409 the caller. A `noop` materialiser is legitimate
    // (the side-effect is a no-op, e.g. an idempotent ack); the gate
    // should accept it. Approved-without-materialiser and rejected paths
    // preserve the legacy status-flip-only semantics.
    //
    // P1-A round-3: for the 'rejected' path on capabilities with a
    // registered materialiser, we ADDITIONALLY require
    // `materialised_at IS NULL` — i.e. no materialiser claim is in
    // flight. Without this clause a concurrent decide(approve) could be
    // mid-`sendAsCoach` (claim held, message in flight) while we flip
    // status to 'rejected' here, ending in `status='rejected',
    // materialised_ref=non-null` after the approve writes its ref. That
    // is the same trust-surface failure as PRODUCT-1 with the symptom
    // flipped (rejected-but-sent). Refusing the reject while at !=
    // null forces the rejecter to wait for the materialiser to either
    // succeed (status goes 'approved' — reject no longer applicable) or
    // rollback (at returns to null — reject can proceed). The 409
    // returned in that window is the same retry contract the approver
    // race uses.
    const decideGate: Record<string, unknown> = {
      id: draft.id,
      status: 'pending',
    };
    if (status === 'approved' && materialisationRef !== null) {
      decideGate.materialised_ref = { not: null };
    }
    if (status === 'rejected' && this.materialisers) {
      const materialiserForCap = this.materialisers.resolve(draft.capability);
      if (materialiserForCap) {
        decideGate.materialised_at = null;
      }
    }
    const decideResult = await this.prisma.aiActionDraft.updateMany({
      where: decideGate,
      data: {
        status,
        decided_by_id: input.decider.id,
        decided_at: new Date(),
        decision_note: input.note ?? null,
      },
    });
    if (decideResult.count === 0) {
      // Another approver already decided this draft (P2-3) OR — for the
      // approved-with-materialiser path — the materialisation has not
      // observably committed (P1-1 belt-and-braces). Surface as 409 so the
      // caller refreshes and tries again. We do NOT need to roll back the
      // materialisation here: either the winner already owns the success
      // (no rollback needed) or our materialise() call earlier returned
      // `racing` (no claim held, nothing to undo).
      throw new ConflictException({
        error: 'AI_DRAFT_ALREADY_DECIDED',
        capability: draft.capability,
        reason:
          'Draft was decided by another approver before this request landed.',
      });
    }
    const updated = await this.prisma.aiActionDraft.findUnique({
      where: { id: draft.id },
    });
    if (!updated) {
      // Should be unreachable — updateMany returned count=1 a moment ago —
      // but TypeScript still requires we treat findUnique as nullable.
      throw new InternalServerErrorException('Draft not found after decide');
    }

    // Reflect the decision on the linked audit row, if any.
    await this.prisma.aiRequestAudit.updateMany({
      where: { approval_draft_id: draft.id },
      data: { approval_status: status },
    });

    await this.audit.write({
      action: status === 'approved' ? 'ai.draft_approved' : 'ai.draft_rejected',
      actorId: input.decider.id,
      actorRole: input.decider.role,
      targetType: 'ai_action_draft',
      targetId: draft.id,
      targetUserId: draft.subject_user_id ?? null,
      tenantCoachId: draft.tenant_coach_id ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        capability: draft.capability,
        requester_id: draft.requester_id,
        note: input.note ?? null,
        materialised_ref: materialisationRef,
      },
    });

    return updated;
  }

  // Background sweep entry point. Mark any pending draft past its
  // `expires_at` as `expired` and write a single AuditLog row per sweep.
  // Wired to a cron in a follow-up; kept as a service method here so
  // tests and one-off scripts can invoke it directly.
  //
  // P1-A round-3: the WHERE clause requires `materialised_at IS NULL` so
  // we do not flip a draft to 'expired' while a materialiser holds an
  // active claim mid-`sendAsCoach`. Otherwise the symmetric trust-surface
  // failure of P1-A would land here too: the draft would end
  // `status='expired', materialised_ref=non-null` and the client would
  // have received a message the system regards as expired. Drafts in
  // STUCK-CLAIM state (at != null, ref = null with no live writer) are
  // intentionally left for ops to clear; the sweep is a best-effort
  // hygiene pass, not a forcing function.
  async expireStaleDrafts(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.aiActionDraft.updateMany({
      where: {
        status: 'pending',
        expires_at: { lt: now },
        materialised_at: null,
      },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      await this.audit.write({
        action: 'ai.drafts_expired',
        actorRole: 'system',
        metadata: { count: result.count, swept_at: now.toISOString() },
      });
    }
    return result.count;
  }
}
