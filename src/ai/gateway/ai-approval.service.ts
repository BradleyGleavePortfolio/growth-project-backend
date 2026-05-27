import {
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
        } catch (err) {
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

    const updated = await this.prisma.aiActionDraft.update({
      where: { id: draft.id },
      data: {
        status,
        decided_by_id: input.decider.id,
        decided_at: new Date(),
        decision_note: input.note ?? null,
      },
    });

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
  async expireStaleDrafts(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.aiActionDraft.updateMany({
      where: { status: 'pending', expires_at: { lt: now } },
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
