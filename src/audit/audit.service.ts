import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// Canonical audit-action strings. Free-form strings keep adding new actions
// cheap, but exporting the names here gives call sites and tests a single
// source of truth.
export const AuditAction = {
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_ACCOUNT_DELETION_SCHEDULED: 'user.account_deletion_scheduled',
  USER_ACCOUNT_DELETION_CANCELED: 'user.account_deletion_canceled',
  USER_ACCOUNT_DELETED: 'user.account_deleted',
  USER_DATA_EXPORT_REQUESTED: 'user.data_export_requested',
  USER_DATA_EXPORT_FULFILLED: 'user.data_export_fulfilled',
  USER_DATA_EXPORT_FAILED: 'user.data_export_failed',
  COACH_PROFILE_CREATED: 'coach.profile_created',
  COACH_CLIENT_ARCHIVED: 'coach.client_archived',
  COACH_CLIENT_UNARCHIVED: 'coach.client_unarchived',
  BILLING_SUBSCRIPTION_UPDATED: 'billing.subscription_updated',
  BILLING_SUBSCRIPTION_CANCELED: 'billing.subscription_canceled',
  BILLING_INVOICE_PAID: 'billing.invoice_paid',
  BILLING_INVOICE_PAYMENT_FAILED: 'billing.invoice_payment_failed',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditWriteInput {
  action: AuditActionValue | string;
  actorId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  targetUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  tenantCoachId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

// AuditService is the single entry point for writing immutable audit-log
// entries. It deliberately swallows write errors and logs them — a failed
// audit write must never surface as a 500 to the user, but we still want
// the failure visible in app logs (and Sentry, via the global Logger
// transport) so operators can investigate.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  async write(input: AuditWriteInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          actor_id: input.actorId ?? null,
          actor_role: input.actorRole ?? null,
          actor_email_snapshot: input.actorEmail ?? null,
          target_user_id: input.targetUserId ?? null,
          target_type: input.targetType ?? null,
          target_id: input.targetId ?? null,
          tenant_coach_id: input.tenantCoachId ?? null,
          ip: input.ip ?? null,
          user_agent: input.userAgent ?? null,
          metadata: (input.metadata as any) ?? null,
        },
      });
    } catch (err: any) {
      this.logger.error(
        `Audit write failed for action=${input.action}: ${err?.message ?? err}`,
      );
    }
  }

  // Owner-only listing used by the admin surface. Filters are intentionally
  // narrow — owners can scope by action prefix, target user, or tenant.
  // Pagination via `before` cursor (created_at) keeps the index seek tight.
  async list(params: {
    action?: string;
    targetUserId?: string;
    tenantCoachId?: string;
    before?: Date;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const where: any = {};
    if (params.action) where.action = params.action;
    if (params.targetUserId) where.target_user_id = params.targetUserId;
    if (params.tenantCoachId) where.tenant_coach_id = params.tenantCoachId;
    if (params.before) where.created_at = { lt: params.before };
    return this.prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }
}
