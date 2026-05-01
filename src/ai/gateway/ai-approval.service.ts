import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AuditService } from '../../audit/audit.service';

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
  ) {}

  async listPending(scope: { tenantCoachId?: string; subjectUserId?: string; limit?: number }) {
    const limit = Math.min(Math.max(scope.limit ?? 50, 1), 200);
    return this.prisma.aiActionDraft.findMany({
      where: {
        status: 'pending',
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
