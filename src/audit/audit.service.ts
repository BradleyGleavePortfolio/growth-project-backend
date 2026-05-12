import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// Kill switch: set AUDIT_LOGGING_ENABLED=off to disable all audit writes
// without removing the call sites. Defaults to "on" (safe default — you
// should only disable this in short-lived debugging windows, not long-term).
// Audit reads via list() are unaffected — they still return the existing rows.
function auditLoggingEnabled(): boolean {
  const val = (process.env.AUDIT_LOGGING_ENABLED ?? 'on').toLowerCase();
  return val !== 'off' && val !== 'false' && val !== '0';
}

// Canonical audit-action strings. Free-form strings keep adding new actions
// cheap, but exporting the names here gives call sites and tests a single
// source of truth.
//
// Naming convention: <domain>.<event_past_tense>
// e.g. auth.login, user.role_changed, bloodwork.panel_viewed
//
// Do NOT add actions here for high-frequency non-sensitive events
// (e.g. weight logs, check-in submissions) — audit is for sensitive
// and compliance-relevant events only.
export const AuditAction = {
  // --- User / account ---
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_ACCOUNT_DELETION_SCHEDULED: 'user.account_deletion_scheduled',
  USER_ACCOUNT_DELETION_CANCELED: 'user.account_deletion_canceled',
  USER_ACCOUNT_DELETED: 'user.account_deleted',
  USER_DATA_EXPORT_REQUESTED: 'user.data_export_requested',
  USER_DATA_EXPORT_FULFILLED: 'user.data_export_fulfilled',
  USER_DATA_EXPORT_FAILED: 'user.data_export_failed',

  // --- Authentication events ---
  // Captured so operators can detect brute-force, credential-stuffing, and
  // account takeover attempts by scanning the audit log per IP/actor.
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_APPLE_SIGNIN: 'auth.apple_signin',
  // Password changes log the actor and a redacted timestamp only — the
  // old/new password values are NEVER included in metadata.
  AUTH_PASSWORD_CHANGE: 'auth.password_change',
  // Biometric unlock is a privilege escalation: the device credentials
  // stand in for the user's password on subsequent opens. Log when
  // the user enables this setting so the trail is queryable if an enrolled
  // device is later reported compromised.
  AUTH_BIOMETRIC_UNLOCK_SETUP: 'auth.biometric_unlock_setup',

  // --- Coach actions ---
  COACH_PROFILE_CREATED: 'coach.profile_created',
  COACH_CLIENT_ARCHIVED: 'coach.client_archived',
  COACH_CLIENT_UNARCHIVED: 'coach.client_unarchived',
  // Fire when a coach's roster assignment changes (add / remove client).
  COACH_ASSIGNED_CLIENT_CHANGE: 'coach.assigned_client_change',
  // Fire when a coach opens a client's timeline or summary view.
  // High-signal for privacy audits — who has looked at whose data.
  COACH_VIEWED_CLIENT_DATA: 'coach.viewed_client_data',

  // --- Admin PTM (Predictive Tracking Model) ---
  PTM_OUTCOME_LABELLED: 'ptm.outcome_labelled',
  // Viewing the risk board exposes churn risk scores for all enrolled
  // clients — gate this behind sampling if it becomes high-frequency.
  // See admin-ptm.service.ts for the sample-rate guard.
  PTM_RISK_BOARD_VIEW: 'ptm.risk_board_view',

  // --- Notification preferences ---
  // Any change to a user's notification preferences is logged so
  // support can audit whether a user opted out before a critical alert
  // was missed.
  NOTIFICATION_PREF_CHANGE: 'notification.pref_change',

  // --- Billing ---
  BILLING_SUBSCRIPTION_UPDATED: 'billing.subscription_updated',
  BILLING_SUBSCRIPTION_CANCELED: 'billing.subscription_canceled',
  BILLING_INVOICE_PAID: 'billing.invoice_paid',
  BILLING_INVOICE_PAYMENT_FAILED: 'billing.invoice_payment_failed',
  // Concierge scheduling — every state transition on a CoachingSession
  // emits one of these. See docs/rfcs/142-concierge-scheduling.md.
  SESSION_REQUESTED: 'session.requested',
  SESSION_APPROVED: 'session.approved',
  SESSION_DECLINED: 'session.declined',
  SESSION_RESCHEDULED: 'session.rescheduled',
  SESSION_CANCELED: 'session.canceled',
  SESSION_COMPLETED: 'session.completed',
  SESSION_NO_SHOW: 'session.no_show',
  SESSION_VIDEO_LINK_ATTACHED: 'session.video_link_attached',
  SESSION_PROVIDER_CALENDAR_CREATED: 'session.provider.calendar_created',
  SESSION_PROVIDER_VIDEO_CREATED: 'session.provider.video_created',
  SESSION_PROVIDER_CANCELED: 'session.provider.canceled',
  SESSION_TYPE_CREATED: 'coach.session_type_created',
  SESSION_TYPE_UPDATED: 'coach.session_type_updated',
  COACH_AVAILABILITY_UPDATED: 'coach.availability_updated',
  COACH_AVAILABILITY_OVERRIDE_SET: 'coach.availability_override_set',
  CALENDAR_CONNECTED: 'calendar.connected',
  CALENDAR_DISCONNECTED: 'calendar.disconnected',
  // Concierge scheduling — Google Calendar adapter. One row per
  // outbound Calendar API mutation; reads do not write audit rows.
  CALENDAR_EVENT_CREATED: 'calendar.event_created',
  CALENDAR_EVENT_UPDATED: 'calendar.event_updated',
  CALENDAR_EVENT_DELETED: 'calendar.event_deleted',
  CALENDAR_WATCH_STARTED: 'calendar.watch_started',
  CALENDAR_WATCH_STOPPED: 'calendar.watch_stopped',

  // --- Bloodwork (wired in PR #103 — feat-bloodwork-rails) ---
  // Only the panel ID (not result values) appears in metadata — raw
  // lab values are redacted from the audit log to limit PII surface.
  BLOODWORK_VIEW: 'bloodwork.view',
  BLOODWORK_DISCLAIMER_ACKED: 'bloodwork.disclaimer_acked',
  BLOODWORK_ENTRY_CREATED: 'bloodwork.entry_created',
  BLOODWORK_ENTRY_UPDATED: 'bloodwork.entry_updated',

  // --- Leaderboard (wired in PR #148 — feat/phase-7c-peer-leaderboard) ---
  // Logs when a user opts in or out of the public leaderboard.
  LEADERBOARD_OPTIN_CHANGED: 'leaderboard.optin_changed',

  // --- Settings / consent (future surface) ---
  CONSENT_GRANTED: 'consent.granted',
  CONSENT_REVOKED: 'consent.revoked',
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
  // IMPORTANT: never pass plaintext passwords, full lab result values,
  // payment card details, or any PII that is not essential for incident
  // investigation. Use IDs to reference records; the record itself can be
  // looked up if needed. This contract is enforced by code review (there
  // is no runtime enforcement — it would cost too much at write-path latency).
  metadata?: Record<string, unknown> | null;
}

// AuditService is the single entry point for writing immutable audit-log
// entries. It deliberately swallows write errors and logs them — a failed
// audit write must never surface as a 500 to the user, but we still want
// the failure visible in app logs (and Sentry, via the global Logger
// transport) so operators can investigate.
//
// APPEND-ONLY CONTRACT:
//   - No update* or delete* methods exist on this service.
//   - The Prisma model has no @updatedAt field.
//   - Rows are never mutated after insert; PII scrub sets FK columns
//     to NULL (ON DELETE SET NULL) but preserves the row + actor_email_snapshot.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  async write(input: AuditWriteInput): Promise<void> {
    // Kill switch: AUDIT_LOGGING_ENABLED=off disables all writes without
    // requiring call-site changes. Safe default is "on".
    if (!auditLoggingEnabled()) return;

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
          metadata:
            input.metadata != null
              ? (input.metadata as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Audit write failed for action=${input.action}: ${msg}`,
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
    const where: Prisma.AuditLogWhereInput = {};
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
