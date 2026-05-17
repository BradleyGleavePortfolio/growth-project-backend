import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { UpdateNotificationPreferencesDto, GetNotificationsQueryDto } from './notifications.dto';
import { NotificationKindValue } from './notification-kind';
import {
  NotificationCategory,
  DEFAULT_NOTIFICATION_CATEGORY,
} from './notification-category.enum';

// Phase 6B: PushPayload is the minimal envelope CoachAlertsService.tryPush
// passes through. It intentionally contains no PII — only the alert
// identifier, type, and a short message string for the coach's lock-screen.
//
// Phase 11: `category` field added. Defaults to SYSTEM so all existing call
// sites remain valid without modification.
export interface PushPayload {
  alertId: string;
  alertType: string;
  severity: string;
  message: string;
  /** Push notification category for Android channels / iOS actionable categories. */
  category?: NotificationCategory;
}

// Phase 9: Envelope every emitter passes to createNotification.
// `body` is the plain-text notification text (max 160 chars).
// `payload` is the deep-link context object — no cross-user PII.
// `channel` defaults to 'inapp'; digest sends use 'email'.
export interface CreateNotificationInput {
  user_id: string;
  kind: NotificationKindValue;
  body: string;
  payload?: Record<string, unknown>;
  deep_link?: string;
  channel?: 'push' | 'email' | 'inapp';
}

// Rate-limit guard: at most 1 push per user per kind per minute.
// Tracked in-process (per replica). At scale: move to Redis with a
// sorted-set TTL key: `notif:rate:<userId>:<kind>`.
const recentPushes = new Map<string, number>();

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    // AuditService is @Global — injected here for notification.pref_change
    // audit events. Optional so tests that build NotificationsService
    // without DI continue to work (audit writes become no-ops).
    @Optional() private audit?: AuditService,
  ) {}

  // ── Preferences ───────────────────────────────────────────────────────────

  async getPreferences(userId: string) {
    const prefs = await this.prisma.notificationPreferences.findUnique({
      where: { user_id: userId },
    });
    if (!prefs) {
      // Return defaults when the row has not been created yet.
      return {
        user_id: userId,
        water_enabled: true,
        workout_enabled: true,
        eat_enabled: true,
        mindset_enabled: true,
        fasting_enabled: true,
        daily_checkin_enabled: true,
        weekly_summary_enabled: true,
        new_client_alerts: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '06:00',
        timezone: 'America/Los_Angeles',
        // Phase 9 defaults
        muted: false,
        milestone_email: true,
        milestone_push: true,
        milestone_inapp: true,
        message_email: false,
        message_push: true,
        message_inapp: true,
        missed_checkin_email: false,
        missed_checkin_push: true,
        missed_checkin_inapp: true,
        weight_trend_email: false,
        weight_trend_push: true,
        weight_trend_inapp: true,
        checkin_submitted_email: false,
        checkin_submitted_push: false,
        checkin_submitted_inapp: true,
        build_week_email: true,
        build_week_push: true,
        build_week_inapp: true,
        coach_alert_email: false,
        coach_alert_push: true,
        coach_alert_inapp: true,
        digest_email: true,
        digest_push: false,
        digest_inapp: false,
        // Concierge booking defaults — email off (no transactional
        // email transport for booking events in Phase 1); push + inapp
        // on so a Concierge client/coach is reachable for lifecycle
        // events and reminders without flipping prefs first.
        booking_email: false,
        booking_push: true,
        booking_inapp: true,
      };
    }
    return prefs;
  }

  async updatePreferences(
    userId: string,
    data: UpdateNotificationPreferencesDto,
    auditCtx: { ip?: string | null; userAgent?: string | null; actorRole?: string | null } = {},
  ) {
    // Explicit field mapping — never spread `data` directly into the Prisma
    // call. Defense-in-depth alongside ValidationPipe's whitelist stripping.
    const fields = {
      water_enabled: data.water_enabled,
      workout_enabled: data.workout_enabled,
      eat_enabled: data.eat_enabled,
      mindset_enabled: data.mindset_enabled,
      fasting_enabled: data.fasting_enabled,
      daily_checkin_enabled: data.daily_checkin_enabled,
      weekly_summary_enabled: data.weekly_summary_enabled,
      new_client_alerts: data.new_client_alerts,
      quiet_hours_start: data.quiet_hours_start,
      quiet_hours_end: data.quiet_hours_end,
      timezone: data.timezone,
      // Phase 9 fields
      muted: data.muted,
      milestone_email: data.milestone_email,
      milestone_push: data.milestone_push,
      milestone_inapp: data.milestone_inapp,
      message_email: data.message_email,
      message_push: data.message_push,
      message_inapp: data.message_inapp,
      missed_checkin_email: data.missed_checkin_email,
      missed_checkin_push: data.missed_checkin_push,
      missed_checkin_inapp: data.missed_checkin_inapp,
      weight_trend_email: data.weight_trend_email,
      weight_trend_push: data.weight_trend_push,
      weight_trend_inapp: data.weight_trend_inapp,
      checkin_submitted_email: data.checkin_submitted_email,
      checkin_submitted_push: data.checkin_submitted_push,
      checkin_submitted_inapp: data.checkin_submitted_inapp,
      build_week_email: data.build_week_email,
      build_week_push: data.build_week_push,
      build_week_inapp: data.build_week_inapp,
      coach_alert_email: data.coach_alert_email,
      coach_alert_push: data.coach_alert_push,
      coach_alert_inapp: data.coach_alert_inapp,
      digest_email: data.digest_email,
      digest_push: data.digest_push,
      digest_inapp: data.digest_inapp,
      booking_email: data.booking_email,
      booking_push: data.booking_push,
      booking_inapp: data.booking_inapp,
    };

    // Strip undefined entries so Prisma does not try to set them to NULL.
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );

    const existing = await this.prisma.notificationPreferences.findUnique({
      where: { user_id: userId },
    });

    const result = existing
      ? await this.prisma.notificationPreferences.update({
          where: { user_id: userId },
          data: definedFields,
        })
      : await this.prisma.notificationPreferences.create({
          data: { user_id: userId, ...definedFields },
        });

    // Audit: log preference change. Fire-and-forget so a log write cannot
    // block or fail the primary preference update. Metadata captures only
    // the keys that changed — not their new values, to avoid storing
    // potentially-sensitive preference data in the audit log.
    const changedKeys = (Object.keys(definedFields) as Array<keyof typeof fields>).filter(
      (k) => existing == null || (existing as Record<string, unknown>)[k] !== (definedFields as Record<string, unknown>)[k],
    );
    void this.audit?.write({
      action: AuditAction.NOTIFICATION_PREF_CHANGE,
      actorId: userId,
      actorRole: auditCtx.actorRole ?? null,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      metadata: { changed_keys: changedKeys, is_create: existing == null },
    });

    return result;
  }

  // ── Notification center ───────────────────────────────────────────────────

  /**
   * Write one notification row. Called by every emitter.
   *
   * Before writing, the method checks the user's NotificationPreferences to
   * see if the channel for this kind is enabled. If not, or if `muted` is
   * true, the write is skipped. This is the single enforcement point so
   * individual emitters do not need to repeat preference lookups.
   *
   * Returns the created row, or null if suppressed by preferences.
   */
  async createNotification(input: CreateNotificationInput) {
    const prefs = await this.getPreferences(input.user_id);
    const channel = input.channel ?? 'inapp';

    // Global mute short-circuit.
    if ((prefs as Record<string, unknown>).muted) {
      return null;
    }

    // Per-kind channel gate.
    const enabledKey = `${this._kindToPrefsPrefix(input.kind)}_${channel}` as keyof typeof prefs;
    const enabled = prefs[enabledKey];
    if (enabled === false) {
      return null;
    }

    // Push rate limit: at most 1 push per user per kind per 60 seconds.
    if (channel === 'push') {
      const key = `${input.user_id}:${input.kind}`;
      const last = recentPushes.get(key) ?? 0;
      const now = Date.now();
      if (now - last < 60_000) {
        this.logger.debug(
          `push rate-limited: user=${input.user_id} kind=${input.kind}`,
        );
        return null;
      }
      recentPushes.set(key, now);
    }

    return this.prisma.notification.create({
      data: {
        user_id: input.user_id,
        kind: input.kind,
        body: input.body.slice(0, 160),
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        deep_link: input.deep_link,
        channel,
      },
    });
  }

  /**
   * Paginated notification inbox. Cursor is the last seen notification id.
   * Default limit 20, max 100.
   */
  async listNotifications(userId: string, query: GetNotificationsQueryDto) {
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Record<string, unknown> = { user_id: userId };

    if (query.filter === 'unread') {
      where.read_at = null;
    }

    if (query.cursor) {
      // Cursor is the id of the last item returned — fetch rows created
      // before (earlier) the cursor row. We use created_at for ordering
      // but id for stable tie-breaking.
      const cursorRow = await this.prisma.notification.findUnique({
        where: { id: query.cursor },
        select: { created_at: true },
      });
      if (cursorRow) {
        where.created_at = { lt: cursorRow.created_at };
      }
    }

    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit + 1, // fetch one extra to determine if there's a next page
    });

    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? items[items.length - 1].id : null;

    const unreadCount = await this.prisma.notification.count({
      where: { user_id: userId, read_at: null },
    });

    return { items, nextCursor, unreadCount };
  }

  /**
   * Mark a single notification as read. Returns 404 if the notification
   * does not belong to the requesting user.
   */
  async markRead(notificationId: string, userId: string) {
    const row = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!row || row.user_id !== userId) {
      throw new NotFoundException('Notification not found');
    }
    if (row.read_at) {
      return row; // Already read — idempotent.
    }
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { read_at: new Date() },
    });
  }

  /**
   * Mark all notifications for the user as read. Returns the count updated.
   */
  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    return { updated: result.count };
  }

  /**
   * Returns the count of unread notifications for the given user.
   * Used by GET /notifications/unread-count for lightweight badge polling.
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { user_id: userId, read_at: null },
    });
  }

  // ── Push delivery (Phase 6B baseline, extended Phase 9) ──────────────────

  /**
   * Phase 6B — Push an alert payload to a coach's device(s).
   *
   * Returns `true` when delivery was attempted, `false` on transport error.
   * Push failure must never throw — callers treat `false` as graceful fallback
   * to the in-app inbox.
   *
   * Phase 11: `payload.category` is now forwarded to the push transport.
   * When not provided, defaults to `SYSTEM` so existing callers continue
   * to work without modification. Callers should set the appropriate category
   * from the `NotificationCategory` enum.
   */
  async pushToCoach(coachId: string, payload: PushPayload): Promise<boolean> {
    const category = payload.category ?? DEFAULT_NOTIFICATION_CATEGORY;

    try {
      // Push token lookup and APNs/FCM transport are deferred until
      // push credentials are wired in the environment. For now, log
      // delivery intent — alerts are still stored in inbox.
      this.logger.log(
        `push delivery: coach=${coachId} alertId=${payload.alertId} type=${payload.alertType} sev=${payload.severity} category=${category}`,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `pushToCoach failed for coach=${coachId}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ── Digest idempotency helpers ────────────────────────────────────────────

  /**
   * Attempt to claim a digest send slot for (userId, digestKind, windowDate).
   * Returns false if a row with status 'sending' or 'sent' already exists for
   * this window — caller should skip the send.
   * Returns the new log id on success.
   */
  async claimDigestWindow(
    userId: string,
    digestKind: string,
    windowDate: string,
  ): Promise<string | false> {
    try {
      const row = await this.prisma.notificationDigestLog.create({
        data: { user_id: userId, digest_kind: digestKind, window_date: windowDate },
      });
      return row.id;
    } catch {
      // Unique constraint violation = window already claimed.
      return false;
    }
  }

  async markDigestSent(logId: string) {
    return this.prisma.notificationDigestLog.update({
      where: { id: logId },
      data: { status: 'sent', sent_at: new Date() },
    });
  }

  async markDigestFailed(logId: string, error: string) {
    return this.prisma.notificationDigestLog.update({
      where: { id: logId },
      data: { status: 'failed', error: error.slice(0, 500) },
    });
  }

  /**
   * Build an Expo push payload envelope with the `category` field set.
   *
   * This is a factory helper for callers building Expo push messages.
   * It ensures the category is always present, defaulting to SYSTEM.
   */
  buildExpoPushPayload(params: {
    to: string;
    title: string;
    body: string;
    category?: NotificationCategory;
    data?: Record<string, unknown>;
  }): {
    to: string;
    title: string;
    body: string;
    categoryId: string;
    data: Record<string, unknown>;
  } {
    return {
      to: params.to,
      title: params.title,
      body: params.body,
      categoryId: params.category ?? DEFAULT_NOTIFICATION_CATEGORY,
      data: params.data ?? {},
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Maps a NotificationKind value to the base preferences key prefix.
   * E.g. 'milestone_reached' → 'milestone'
   */
  private _kindToPrefsPrefix(kind: string): string {
    if (kind.startsWith('milestone')) return 'milestone';
    if (kind.startsWith('message')) return 'message';
    if (kind.startsWith('missed_checkin')) return 'missed_checkin';
    if (kind.startsWith('weight_trend')) return 'weight_trend';
    if (kind.startsWith('checkin_submitted')) return 'checkin_submitted';
    if (kind.startsWith('build_week')) return 'build_week';
    if (kind.startsWith('coach_alert')) return 'coach_alert';
    if (kind.startsWith('booking')) return 'booking';
    if (kind.includes('digest')) return 'digest';
    return 'digest'; // safe default — falls back to digest prefs
  }
}
