import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
// expo-server-sdk v6 is ESM-only and exports `Expo` as a NAMED export
// (no default export). Jest handles the ESM transform via the
// `transformIgnorePatterns` allowlist in jest.config.js — see that file for
// the rationale (one ESM dep in an otherwise CJS project; full ESM
// conversion would be a multi-day effort).
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { UpdateNotificationPreferencesDto, GetNotificationsQueryDto } from './notifications.dto';
import { NotificationKindValue } from './notification-kind';
import {
  NotificationCategory,
  DEFAULT_NOTIFICATION_CATEGORY,
} from './notification-category.enum';
import {
  PushAbortedError,
  PushDeliveryResult,
} from './push-delivery.types';
import { VoicePolicyService } from '../roman/voice/voice-policy.service';
import {
  RomanCopyPayload,
  SurfaceKey,
} from '../roman/voice/voice-policy.constants';

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
  private readonly expo = new Expo();

  constructor(
    private prisma: PrismaService,
    // AuditService is @Global — injected here for notification.pref_change
    // audit events. Optional so tests that build NotificationsService
    // without DI continue to work (audit writes become no-ops).
    @Optional() private audit?: AuditService,
    // Phase 2: the Roman Option-3 copy policy. @Optional so thin unit tests
    // that construct NotificationsService without DI keep working — when it is
    // absent the empty-state copy falls back to the pinned legacy string.
    @Optional() private voice?: VoicePolicyService,
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
        // PR-10 — DRIP_RELEASED defaults match the migration: buyers get
        // content-unlocked push + in-app by default; no transactional
        // email channel for drip releases (matches booking cluster).
        drip_released_email: false,
        drip_released_push: true,
        drip_released_inapp: true,
        // PR-15A — COACH_NEW_PURCHASE defaults match the migration:
        // selling coach gets push + in-app on every new entitlement,
        // email off (no transactional channel today).
        coach_new_purchase_email: false,
        coach_new_purchase_push: true,
        coach_new_purchase_inapp: true,
        // Concierge booking defaults — email off (no transactional
        // email transport for booking events in Phase 1); push + inapp
        // on so a Concierge client/coach is reachable for lifecycle
        // events and reminders without flipping prefs first.
        booking_email: false,
        booking_push: true,
        booking_inapp: true,
        // NUDGE-V1 defaults — mirror schema defaults. Per-trigger opt-out lives here.
        nudge_missed_checkin_email: false,
        nudge_missed_checkin_push: true,
        nudge_missed_checkin_inapp: true,
        // Streak-broken trigger — schema columns named 'practice_paused' per
        // the doctrine (no 'streak_' substring in schema.prisma).
        nudge_practice_paused_email: false,
        nudge_practice_paused_push: true,
        nudge_practice_paused_inapp: true,
        nudge_onboarding_abandoned_email: true,
        nudge_onboarding_abandoned_push: true,
        nudge_onboarding_abandoned_inapp: true,
        nudge_inactive_email: true,
        nudge_inactive_push: true,
        nudge_inactive_inapp: true,
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
      // PR-15A — COACH_NEW_PURCHASE (selling coach alerted on entitlement).
      coach_new_purchase_email: data.coach_new_purchase_email,
      coach_new_purchase_push: data.coach_new_purchase_push,
      coach_new_purchase_inapp: data.coach_new_purchase_inapp,
      // NUDGE-V1 — explicit per-trigger × per-channel mapping. Each maps
      // 1:1 to a column added in the same schema migration; missing values
      // are stripped below so a partial PATCH only flips the supplied flags.
      nudge_missed_checkin_email: data.nudge_missed_checkin_email,
      nudge_missed_checkin_push: data.nudge_missed_checkin_push,
      nudge_missed_checkin_inapp: data.nudge_missed_checkin_inapp,
      nudge_practice_paused_email: data.nudge_practice_paused_email,
      nudge_practice_paused_push: data.nudge_practice_paused_push,
      nudge_practice_paused_inapp: data.nudge_practice_paused_inapp,
      nudge_onboarding_abandoned_email: data.nudge_onboarding_abandoned_email,
      nudge_onboarding_abandoned_push: data.nudge_onboarding_abandoned_push,
      nudge_onboarding_abandoned_inapp: data.nudge_onboarding_abandoned_inapp,
      nudge_inactive_email: data.nudge_inactive_email,
      nudge_inactive_push: data.nudge_inactive_push,
      nudge_inactive_inapp: data.nudge_inactive_inapp,
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

    // Phase 2: when the panel is empty, attach the Roman empty-state copy +
    // avatar crop so the UI renders a calm "nothing here" message rather than a
    // blank list. `emptyState` is null when there ARE items, so the existing
    // shape (items / nextCursor / unreadCount) is preserved for non-empty
    // responses and no consumer that ignores the field is affected.
    const emptyState: RomanCopyPayload | null =
      items.length === 0 ? this.emptyNotificationsCopy() : null;

    return { items, nextCursor, unreadCount, emptyState };
  }

  /**
   * Phase 2 empty-list copy, routed through the Roman Voice Policy
   * (FEATURE_ROMAN_COPY_V2-gated). Falls back to the pinned legacy string when
   * the policy service is not wired (thin unit tests). Never returns an empty
   * string — a blank empty-state is a worse user experience than a default.
   */
  private emptyNotificationsCopy(): RomanCopyPayload {
    if (this.voice) {
      return this.voice.copyFor('empty_notifications');
    }
    // No-DI fallback: the pinned legacy empty-state copy + neutral crop.
    return {
      text: 'You have no notifications.',
      avatar_crop: 'neutral',
      surface_key: 'empty_notifications',
      voice_variant: 'legacy',
    };
  }

  /**
   * Phase 2 paywall copy builder. The single in-app source of truth for the
   * paywall surface, routed through the Roman Voice Policy
   * (FEATURE_ROMAN_COPY_V2-gated). Callers that render the paywall read both
   * the `text` and the `avatar_crop` from this payload. Throws (never returns
   * blank copy) when the policy is wired but the surface is unknown.
   */
  paywallCopy(): RomanCopyPayload {
    return this.surfaceCopy('paywall', {
      text: 'This content requires an active subscription. Choose a plan to continue.',
      avatar_crop: 'neutral',
    });
  }

  /**
   * Phase 2 billing-update prompt copy builder (card expiry / pre-retry card
   * decline). Money surface — the avatar crop is always `neutral`, never
   * `smile` (ROMAN_VOICE_POLICY §4).
   */
  billingUpdateCopy(): RomanCopyPayload {
    return this.surfaceCopy('billing_update', {
      text: 'Your payment method needs attention. Please update your card to avoid an interruption to your access.',
      avatar_crop: 'neutral',
    });
  }

  /**
   * Phase 2 ED.3 first-payment "wow" copy builder. Fired on the first
   * successful charge. Celebratory surface — the avatar crop is `smile`.
   */
  firstPaymentCopy(): RomanCopyPayload {
    return this.surfaceCopy('first_payment_ed3', {
      text: 'Your payment was successful. Your subscription is now active.',
      avatar_crop: 'smile',
    });
  }

  /**
   * Phase 2 onboarding welcome copy builder (post-signup first-run message).
   * Celebratory surface — the avatar crop is `smile`.
   */
  onboardingWelcomeCopy(): RomanCopyPayload {
    return this.surfaceCopy('onboarding_welcome', {
      text: 'Welcome to The Growth Project. Your account is ready and your coach has been notified.',
      avatar_crop: 'smile',
    });
  }

  /**
   * Shared resolver for the four Phase 2 surfaces that have no DI-less default
   * builder of their own. Routes through the Voice Policy when wired, otherwise
   * returns the supplied pinned legacy fallback so a missing DI never ships a
   * blank notification (no silent failure).
   */
  private surfaceCopy(
    surfaceKey: SurfaceKey,
    fallback: { text: string; avatar_crop: RomanCopyPayload['avatar_crop'] },
  ): RomanCopyPayload {
    if (this.voice) {
      return this.voice.copyFor(surfaceKey);
    }
    return {
      text: fallback.text,
      avatar_crop: fallback.avatar_crop,
      surface_key: surfaceKey,
      voice_variant: 'legacy',
    };
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

    this.logger.log(
      `push delivery: coach=${coachId} alertId=${payload.alertId} type=${payload.alertType} sev=${payload.severity} category=${category}`,
    );

    try {
      const coach = await this.prisma.user.findUnique({
        where: { id: coachId },
        select: { expo_push_token: true },
      });
      if (!coach?.expo_push_token) return true;
      if (!Expo.isExpoPushToken(coach.expo_push_token)) {
        this.logger.warn(`Invalid Expo push token for coach ${coachId}`);
        return true;
      }
      const message: ExpoPushMessage = {
        to: coach.expo_push_token,
        title: payload.message,
        body: payload.alertType,
        data: { alertId: payload.alertId, alertType: payload.alertType, category },
        sound: 'default',
      };
      const chunks = this.expo.chunkPushNotifications([message]);
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of chunks) {
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      }
      await this.pollReceipts(tickets, coachId);
      return true;
    } catch (err) {
      this.logger.error(
        `pushToCoach failed for coach=${coachId}: ${(err as Error).message}`,
        err,
      );
      return false;
    }
  }

  /**
   * Send a push notification to any user (coach or client) by userId.
   * Identical delivery logic to pushToCoach but accepts a plain title/body
   * envelope instead of the PushPayload coach-alert envelope.
   *
   * P2-6: `signal` lets the caller (e.g. CoachBriefScheduler) cancel the
   * downstream Expo round-trip when an external deadline elapses. We
   * check the signal at every await boundary so an abort during the
   * findUnique, chunk send, or receipt poll short-circuits cleanly.
   *
   * P1-5 (fix round 5): returns a typed PushDeliveryResult so callers
   * that need delivery semantics can distinguish "the SDK accepted the
   * message" from "the transport threw / the signal aborted / there was
   * no token". Pre-fix-round-5 this method resolved void on every path,
   * which let CoachBriefScheduler write last_push_date even when Expo
   * had thrown. The scheduler now consults `result.delivered`.
   *
   * P1-6 (fix round 5): the abort path throws a typed PushAbortedError
   * (stable code 'PUSH_ABORTED') instead of `new Error('...aborted')`.
   * No raw new Error in the Coach Brief push path.
   */
  async pushToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PushDeliveryResult> {
    const checkAborted = () => {
      if (signal?.aborted) {
        const reason = signal.reason;
        if (reason instanceof Error) throw reason;
        // R17 / Hard Rule — no raw new Error. Throw a typed domain error
        // carrying a stable code so observability can branch on the
        // abort path without string-matching.
        throw new PushAbortedError(
          typeof reason === 'string' ? reason : undefined,
        );
      }
    };
    try {
      checkAborted();
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { expo_push_token: true },
      });
      checkAborted();
      if (!user?.expo_push_token) {
        return { delivered: false, code: 'no-token' };
      }
      if (!Expo.isExpoPushToken(user.expo_push_token)) {
        return { delivered: false, code: 'invalid-token' };
      }
      const message: ExpoPushMessage = {
        to: user.expo_push_token,
        title,
        body,
        data: data ?? {},
        sound: 'default',
      };
      const chunks = this.expo.chunkPushNotifications([message]);
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of chunks) {
        checkAborted();
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      }
      checkAborted();

      // Inspect tickets synchronously. Expo returns one ticket per
      // message; a ticket with status='error' means the SDK refused
      // the message and we must NOT report delivered=true.
      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          this.logger.error(
            `pushToUser ticket error for user ${userId}: ${ticket.message}`,
          );
          // Poll receipts on a best-effort basis so stale tokens get
          // cleared even though we report failure to the caller.
          await this.pollReceipts(tickets, userId);
          return {
            delivered: false,
            code: 'ticket-error',
            detail: ticket.message,
          };
        }
      }

      // Poll receipts so DeviceNotRegistered tokens are cleared for this
      // user — mirrors the same pattern used in pushToCoach().
      await this.pollReceipts(tickets, userId);
      return { delivered: true, code: 'delivered' };
    } catch (err) {
      // R17: log the raw err for ops, return a scrubbed typed result to
      // the caller. The `detail` field carries only the Error.name so we
      // never leak stack traces or query text.
      this.logger.error(`Push notification failed for user ${userId}`, err);
      if (err instanceof PushAbortedError) {
        return { delivered: false, code: 'aborted', detail: err.name };
      }
      return {
        delivered: false,
        code: 'transport-error',
        detail: err instanceof Error ? err.name : 'unknown',
      };
    }
  }

  /**
   * Poll Expo receipts for a batch of tickets and clear any tokens that
   * Expo reports as DeviceNotRegistered. Called after every pushToCoach send.
   */
  private async pollReceipts(
    tickets: ExpoPushTicket[],
    userId: string,
  ): Promise<void> {
    const receiptIds: string[] = [];
    for (const ticket of tickets) {
      if ('id' in ticket) receiptIds.push(ticket.id);
    }
    if (receiptIds.length === 0) return;
    try {
      const chunks = this.expo.chunkPushNotificationReceiptIds(receiptIds);
      for (const chunk of chunks) {
        const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
        for (const [, receipt] of Object.entries(receipts)) {
          if (receipt.status === 'error') {
            if (receipt.details?.error === 'DeviceNotRegistered') {
              // Token is stale — clear it so we don't waste sends.
              await this.prisma.user.updateMany({
                where: { id: userId },
                data: { expo_push_token: null },
              });
            }
            this.logger.error('Push receipt error:', receipt.message);
          }
        }
      }
    } catch (err) {
      this.logger.warn('Failed to poll push receipts', err);
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
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique constraint violation = window already claimed by another process.
        return false;
      }
      this.logger.error('claimDigestWindow unexpected error', err);
      throw err;
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
    // NUDGE-V1 — most specific match wins. Nudge kinds are 'nudge_<trigger>'
    // so the prefs prefix maps 1:1 (e.g. nudge_missed_checkin_inapp). Tested
    // separately so a stray rename here fails the suite loudly.
    if (kind === 'nudge_missed_checkin') return 'nudge_missed_checkin';
    // Streak-broken kind maps to 'practice_paused' column prefix (doctrine).
    if (kind === 'nudge_streak_broken') return 'nudge_practice_paused';
    if (kind === 'nudge_onboarding_abandoned') return 'nudge_onboarding_abandoned';
    if (kind === 'nudge_inactive') return 'nudge_inactive';
    if (kind.startsWith('milestone')) return 'milestone';
    if (kind.startsWith('message')) return 'message';
    if (kind.startsWith('missed_checkin')) return 'missed_checkin';
    if (kind.startsWith('weight_trend')) return 'weight_trend';
    if (kind.startsWith('checkin_submitted')) return 'checkin_submitted';
    if (kind.startsWith('build_week')) return 'build_week';
    if (kind.startsWith('coach_alert')) return 'coach_alert';
    if (kind.startsWith('booking')) return 'booking';
    // PR-10 — DRIP_RELEASED (buyer content-unlocked alert). Routes to
    // the `drip_released_*` prefs columns (migration
    // 20261205000000_pr10_scheduled_drop_retry_lock); defaults are
    // push+inapp ON, email OFF. Without this branch the kind fell
    // through to the 'digest' safe-default whose _inapp + _push
    // defaults are FALSE, silently short-circuiting every in-app row
    // write — the PR-10 R1 P2 fix.
    if (kind.startsWith('drip_released')) return 'drip_released';
    // PR-15A — COACH_NEW_PURCHASE routes to the dedicated
    // coach_new_purchase_* prefs columns (migration
    // 20261208000000_pr15_coach_new_purchase_prefs); defaults push+inapp
    // ON, email OFF. Without this branch the kind falls through to the
    // 'digest' safe-default (push+inapp default FALSE), silently
    // short-circuiting every COACH_NEW_PURCHASE row write — the exact
    // PR-10 R1 P2 bug the brief calls out.
    if (kind.startsWith('coach_new_purchase')) return 'coach_new_purchase';
    if (kind.startsWith('fasting')) return 'fasting';
    if (kind.includes('digest')) return 'digest';
    return 'digest'; // safe default — falls back to digest prefs
  }
}
