import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
// expo-server-sdk v6 is ESM-only and exports `Expo` as a NAMED export
// (no default export). Jest handles the ESM transform via the
// `transformIgnorePatterns` allowlist in jest.config.js — see that file for
// the rationale (one ESM dep in an otherwise CJS project; full ESM
// conversion would be a multi-day effort).
import { Expo } from 'expo-server-sdk';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  UpdateNotificationPreferencesDto,
  GetNotificationsQueryDto,
  TimeZoneSource,
} from './notifications.dto';
import { usableTimeZone } from './local-time';
import { NotificationKind, NotificationKindValue } from './notification-kind';
import { NotificationCategory, DEFAULT_NOTIFICATION_CATEGORY } from './notification-category.enum';
import { PushAbortedError, PushDeliveryResult } from './push-delivery.types';
import { VoicePolicyService } from '../roman/voice/voice-policy.service';
import { EnqueueResult, PushDeliveryService, SendPathContext } from './push/push-delivery.service';
import { PushContext, lockScreenCopy, safetyAlertTap } from './push/lock-screen-copy';
import { currentCoachInbox } from './current-coach-inbox';
import { InboxBlockRule } from './inbox-block-rule';
import { resolveRecipientTimeZone } from './recipient-timezone';
import {
  MUTE_ALL_PASS,
  MuteAllPass,
  muteAllStops,
  notificationPrefsPrefix,
  pushAllowedByPreferences,
  RenewalOffer,
} from './push/push-preferences';
import { RomanCopyPayload } from '../roman/voice/voice-policy.constants';
import { describeFailure } from '../observability/log-pii';

// Phase 6B: PushPayload is the minimal envelope CoachAlertsService.tryPush
// passes through. It intentionally contains no PII — only the alert
// identifier, type, and a short message string for the coach's lock-screen.
//
// Phase 11: `category` field added. Defaults to SYSTEM so all existing call
// sites remain valid without modification.
/**
 * PF-3-BE: how the one send path treats a sender's own push (pushToUser).
 * `kind` decides quiet hours, the switches and the Android channel; the tap
 * data the phone gets is the sender's own.
 */
export interface PushRoute {
  kind: string;
  /** The sender's switch is Mute all alone (it has no per-kind switch). */
  muteAllOnly?: boolean;
  /** A notice that passes Mute all (MUTE_ALL_PASS, owner #171-3). */
  passesMuteAll?: boolean;
  /** The event's exactly-once identity: a replayed send never posts twice. */
  dedupeKey?: string;
  /** The other person the push is about: a block either way stops a waiting push. */
  otherUserId?: string;
}

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
  /**
   * S-FEE round 6 (#627 B-627-6 / C-627-7): narrows the per-process 60 s push
   * limiter to one logical alert (for example a payout notice id), so two
   * different alerts of the same kind to the same user are never collapsed.
   * Unset keeps the default (one push per user per kind per minute).
   */
  throttle_key?: string;
  /**
   * B-648-7: true when this `push` row duplicates an `inapp` row the same
   * writer stored for the same event. The row is kept (history) but hidden
   * from the inbox and the unread counts, and only when that `inapp` row is
   * found (see PUSH_TWIN_WINDOW_MS): a writer whose inapp write failed or was
   * switched off keeps its push row visible.
   */
  push_twin?: boolean;
}

/** Whether a user receives a kind on a channel (createNotification's gate). */
export type NotificationChannelGate = 'enabled' | 'muted' | 'off';

// Rate-limit guard: at most 1 push per user per kind per minute.
// Tracked in-process (per replica). At scale: move to Redis with a
// sorted-set TTL key: `notif:rate:<userId>:<kind>`.
const recentPushes = new Map<string, number>();

/**
 * Sol B-643-2 / B-648-7: one inbox item per notification. Several writers
 * stored an `inapp` row plus a `push` twin with the same text. Only a
 * PROVEN twin is hidden: `inbox_hidden` is set when the writer marks its
 * `push` row as a twin (createNotification `push_twin`), and the
 * 20270307000000 migration backfilled stored twins (a `push` row within 10 s
 * of an `inapp` row for the same user, kind, deep link and text, never a
 * coach-AI row). A sole `push` row of any kind (coach-AI,
 * community, assignments) stays visible. Installed builds get this because
 * only the API response changes.
 */
const INBOX_HIDES_PUSH_TWINS = { inbox_hidden: false };

/**
 * Sol B-648-7 (round 5): a declared twin is hidden only when its counterpart
 * is proven: an `inapp` row for the same user, kind, deep link and text,
 * stored in the last hour. Otherwise the push row is the only stored copy and
 * stays visible.
 */
export const PUSH_TWIN_WINDOW_MS = 60 * 60_000;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

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
    // C-643-2: device delivery for inbox notifications. @Optional so thin
    // unit tests without DI keep working (sendPush is then a no-op).
    @Optional() private pushDelivery?: PushDeliveryService,
    // B-LONOTIFY3-1: a block hides the rows that name the other person
    // (inbox-block-rule.ts). @Optional for the same thin unit tests; a
    // production boot without it fails (onModuleInit).
    @Optional() private inboxBlocks?: InboxBlockRule,
  ) {}

  /**
   * C-648-2: NotificationsModule provides PushDeliveryService. If that wiring
   * is ever lost, every device push would silently stop, so a production
   * boot fails here instead. (Thin unit tests construct the service without
   * DI and never run this hook.) B-LONOTIFY3-1: the same for the inbox's
   * block rule, without which a blocked person's rows would stay listed.
   */
  onModuleInit(): void {
    this.requireWired(
      this.pushDelivery,
      'NotificationsService started without PushDeliveryService: no inbox notification would reach a device.',
    );
    this.requireWired(
      this.inboxBlocks,
      "NotificationsService started without InboxBlockRule: a blocked person's notifications would stay in the inbox.",
    );
  }

  private requireWired(dependency: unknown, notWired: string): void {
    if (dependency) return;
    if (process.env.NODE_ENV === 'production') throw new Error(notWired);
    this.logger.error(notWired);
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  async getPreferences(userId: string, tx?: Prisma.TransactionClient) {
    // R81 (PR-395 follow-up, F1/F2): read prefs on the ambient tx when one is
    // supplied so a transactional notification write sees a consistent
    // snapshot. Falls back to the autocommitting PrismaService otherwise.
    const db = tx ?? this.prisma;
    const prefs = await db.notificationPreferences.findUnique({
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
        // B-NOTIF-4: no zone has been supplied yet (provenance unset), so
        // notification copy does not trust the `timezone` default above.
        timezone_source: null,
        timezone_updated_at: null,
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
        // C05 item 7 — workout reminders default ON (schema default).
        workout_reminder_push: true,
        workout_reminder_inapp: true,
        plan_renewal_push: true, // RENEWAL-BE (schema default)
        plan_renewal_offers_opt_in_at: null, // STORE-B2: no yes to renewal offers yet
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
      timezone: undefined as string | undefined,
      timezone_source: undefined as TimeZoneSource | undefined,
      timezone_updated_at: undefined as Date | undefined,
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
      // C05 item 7 — workout reminders (Settings > Notifications toggle).
      workout_reminder_push: data.workout_reminder_push,
      workout_reminder_inapp: data.workout_reminder_inapp,
      plan_renewal_push: data.plan_renewal_push, // RENEWAL-BE
    };

    // B-NOTIF-4: an explicit zone in a preferences PATCH is validated and
    // stamped with provenance ('settings'), the same as PUT /timezone.
    if (data.timezone !== undefined) {
      const zone = this.validateTimeZone(data.timezone);
      if (zone) {
        fields.timezone = zone;
        fields.timezone_source = 'settings';
        fields.timezone_updated_at = new Date();
      }
    }

    // Strip undefined entries so Prisma does not try to set them to NULL.
    const definedFields = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );

    const existing = await this.prisma.notificationPreferences.findUnique({
      where: { user_id: userId },
    });
    // STORE-B2 (App Store 4.5.4): the in-app yes to renewal offers is the time the person turned the switch on
    // (kept when it is already on); turning it off clears it. Absent from the PATCH, it is left as it is.
    if (data.plan_renewal_offers !== undefined) {
      (definedFields as Record<string, unknown>).plan_renewal_offers_opt_in_at = data.plan_renewal_offers
        ? (existing?.plan_renewal_offers_opt_in_at ?? new Date())
        : null;
    }

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
      (k) =>
        existing == null ||
        (existing as Record<string, unknown>)[k] !== (definedFields as Record<string, unknown>)[k],
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
   * B-NOTIF-4: validate an IANA zone name. Returns the trimmed name, or null
   * for a UTC alias (the mobile app reports 'UTC' when the device zone is
   * unknown, so it is never stored over a real zone). Throws a 400 with the
   * stable code TIMEZONE_INVALID for anything the runtime does not know.
   */
  private validateTimeZone(raw: string): string | null {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    let known = false;
    if (trimmed.length > 0 && trimmed.length <= 64) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
        known = true;
      } catch {
        known = false;
      }
    }
    if (!known) {
      throw new BadRequestException({
        code: 'TIMEZONE_INVALID',
        message:
          'That time zone is not recognised. Check the date and time settings on your phone, then open the app again.',
      });
    }
    return usableTimeZone(trimmed);
  }

  /**
   * B-NOTIF-4 (Opus B-647-1, Sol B-647-2): store the recipient's own zone
   * with provenance. Idempotent: the same zone again only refreshes
   * timezone_updated_at. A UTC alias is acknowledged but not stored
   * (`stored: false`), so a device that cannot report its zone never
   * overwrites a real one. Creates the preferences row when needed (the
   * other columns take their schema defaults).
   */
  async setTimeZone(
    userId: string,
    timezone: string,
    source: TimeZoneSource = 'device',
  ): Promise<{
    timezone: string | null;
    timezone_source: string | null;
    timezone_updated_at: Date | null;
    stored: boolean;
  }> {
    const zone = this.validateTimeZone(timezone);
    if (!zone) {
      const current = await this.prisma.notificationPreferences.findUnique({
        where: { user_id: userId },
        select: { timezone: true, timezone_source: true, timezone_updated_at: true },
      });
      const trusted = current?.timezone_updated_at ? current : null;
      return {
        timezone: trusted?.timezone ?? null,
        timezone_source: trusted?.timezone_source ?? null,
        timezone_updated_at: trusted?.timezone_updated_at ?? null,
        stored: false,
      };
    }
    const now = new Date();
    const row = await this.prisma.notificationPreferences.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        timezone: zone,
        timezone_source: source,
        timezone_updated_at: now,
      },
      update: { timezone: zone, timezone_source: source, timezone_updated_at: now },
      select: { timezone: true, timezone_source: true, timezone_updated_at: true },
    });
    return { ...row, stored: true };
  }

  /**
   * Write one notification row. Called by every emitter.
   *
   * Before writing, the method checks the user's NotificationPreferences to
   * see if the channel for this kind is enabled. If not, the write is
   * skipped. MUTE-PAY (owner #171-3): `muted` ("Mute all notifications")
   * never skips a row: every row is listed in the inbox. This is the single
   * enforcement point so individual emitters do not need to repeat
   * preference lookups.
   *
   * Returns the created row, or null if suppressed by preferences.
   *
   * R81 (PR-395 follow-up, F1/F2): the optional `tx` lets a caller thread the
   * AMBIENT purchase transaction through so the notification row is written
   * via `tx.notification.create(...)` instead of this service's autocommitting
   * PrismaService. When a tx is supplied, the row commits-or-rolls-back WITH
   * the caller's outer transaction — closing the seam where a first-payment
   * notification could survive an outer rollback (and re-fire on Stripe retry)
   * or be delivered before the purchase ever committed. The preference read
   * also rides `tx` for a consistent snapshot. When `tx` is omitted the
   * behaviour is unchanged (autocommit on `this.prisma`), so every existing
   * callsite keeps working.
   */
  /**
   * The preference gate createNotification applies, without writing: lets a
   * caller tell "the user turned this off" (done, nothing to retry) from a
   * suppressed push (rate limit), which createNotification reports the same
   * way (null). 'muted' is the delivery answer only (muteAllStops: a push or
   * email of a non-money kind); createNotification still writes that row. A
   * money sender on a shared kind passes MUTE_ALL_PASS as `context` (FR-1154).
   */
  async channelGate(
    userId: string,
    kind: NotificationKindValue,
    channel: 'push' | 'email' | 'inapp',
    context?: MuteAllPass,
  ): Promise<NotificationChannelGate> {
    return this.gateFrom(await this.getPreferences(userId), kind, channel, false, context);
  }

  private gateFrom(
    prefs: Awaited<ReturnType<NotificationsService['getPreferences']>>,
    kind: NotificationKindValue,
    channel: 'push' | 'email' | 'inapp',
    row = false,
    context?: MuteAllPass,
  ): NotificationChannelGate {
    // MUTE-PAY: Mute all never stops a row, an in-app notice or a money notice.
    if (!row && muteAllStops(prefs as Record<string, unknown>, kind, channel, context)) return 'muted';
    // Per-kind channel gate.
    const enabledKey = `${this._kindToPrefsPrefix(kind)}_${channel}` as keyof typeof prefs;
    return prefs[enabledKey] === false ? 'off' : 'enabled';
  }

  async createNotification(input: CreateNotificationInput, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    const prefs = await this.getPreferences(input.user_id, tx);
    const channel = input.channel ?? 'inapp';

    // Per-kind channel gate (shared with channelGate); Mute all never stops a row.
    if (this.gateFrom(prefs, input.kind, channel, true) !== 'enabled') {
      return null;
    }

    // Push rate limit: at most 1 push per user per kind per 60 seconds.
    //
    // R81 (PR-395/#402 rebuild, N1): the throttle lives in module-level process
    // state (`recentPushes`), which does NOT participate in the caller's
    // transaction. Mutating it here, before the ambient `tx` commits, opens a
    // lost-push seam: if the outer Stripe webhook transaction rolls back after
    // this write and Stripe redelivers the same event within 60s, the retry
    // would commit the in-app row but find `recentPushes` still primed and
    // silently drop the push. We therefore ONLY apply the in-process throttle
    // for autocommit writes (`tx` undefined). When a `tx` is supplied the caller
    // is a transactional emit whose exactly-once guarantee is already enforced
    // by a DB-backed ledger (e.g. CoachFirstPaymentNotification.coachId @unique),
    // so generic per-process push throttling is both unnecessary and unsafe —
    // its state cannot roll back with the transaction.
    if (channel === 'push' && !tx) {
      const key = input.throttle_key
        ? `${input.user_id}:${input.kind}:${input.throttle_key}`
        : `${input.user_id}:${input.kind}`;
      const last = recentPushes.get(key) ?? 0;
      const now = Date.now();
      if (now - last < 60_000) {
        this.logger.debug(`push rate-limited: user=${input.user_id} kind=${input.kind}`);
        return null;
      }
      recentPushes.set(key, now);
    }

    const body = input.body.slice(0, 160);
    // B-648-7: a writer that stores a `push` twin next to the `inapp` row of
    // the same event says so, and the twin stays out of the inbox and the
    // unread counts once that `inapp` row is found. Nothing is hidden by kind.
    const inboxHidden =
      channel === 'push' &&
      input.push_twin === true &&
      (await this.inboxCounterpartExists(db, input, body));

    return db.notification.create({
      data: {
        user_id: input.user_id,
        kind: input.kind,
        body,
        payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        deep_link: input.deep_link,
        channel,
        ...(inboxHidden ? { inbox_hidden: true } : {}),
      },
    });
  }

  /**
   * Send an inbox notification to the recipient's phone (C-643-2).
   *
   * The inbox row is written separately with `createNotification({ channel:
   * 'inapp' })`; this call writes NO inbox row, so each event is one inbox
   * item. It queues one PushOutbox row (B-NOTIF-5) and returns at once: the
   * request never waits on Expo (B-648-6). Gated by `<kind>_push` and by
   * `muted` unless the kind is money, the context is a safety alert or carries
   * MUTE_ALL_PASS (pushAllowedByPreferences; FR-1154). Quiet hours
   * (OR-113-5) are applied in the recipient's zone. The lock screen gets quiet copy
   * (lock-screen-copy.ts: no health details, no message text); `data`
   * carries only tap routing (the screen, the deep link and ids).
   *
   * `dedupe_key` makes an event exactly once (booking events, each Roman
   * safety coach alert) and it never collapses; without it, repeats in the
   * same conversation (same kind and deep link) collapse.
   * With `tx` the push commits or rolls back with the caller's write.
   * Never throws without `tx`; returns null when suppressed or unwired.
   */
  async sendPush(
    input: {
      user_id: string;
      kind: NotificationKindValue;
      body: string;
      deep_link?: string;
      context?: (PushContext & MuteAllPass & RenewalOffer & Pick<SendPathContext, 'otherUserId'>) | null;
      dedupe_key?: string | null;
      urgent?: boolean;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<EnqueueResult | null> {
    if (!this.pushDelivery) return null;
    try {
      const prefs = await this.getPreferences(input.user_id, tx);
      // Same rule the push worker re-checks right before sending (B-648-9).
      if (!pushAllowedByPreferences(prefs as Record<string, unknown>, input.kind, input.context)) return null;
      const copy = lockScreenCopy(input.kind, input.body, input.context);
      const timeZone =
        input.context?.timeZone ??
        (await resolveRecipientTimeZone(tx ?? this.prisma, input.user_id, input.context?.sessionId));
      return await this.pushDelivery.enqueue(
        {
          userId: input.user_id,
          kind: input.kind,
          title: copy.title,
          body: copy.body,
          data: {
            ...pushTapData(
              input.kind,
              input.deep_link,
              input.context?.sessionId,
              await this.bookingRole(
                tx ?? this.prisma,
                input.kind,
                input.user_id,
                input.context?.sessionId,
              ),
            ),
            // Owner 57d: a Roman safety alert push opens that alert.
            ...(input.context?.safetyAlert && input.context.alertId
              ? safetyAlertTap(input.context.alertId)
              : {}),
          },
          context: input.context ?? null,
          dedupeKey: input.dedupe_key ?? null,
          collapseKey: `${input.kind}:${input.deep_link ?? ''}`,
          urgent: input.urgent,
          timeZone,
        },
        tx,
      );
    } catch (err) {
      if (tx) throw err;
      this.logger.warn(
        `sendPush skipped: user=${input.user_id} kind=${input.kind} error=${err instanceof Error ? err.name : 'unknown'}`,
      );
      return null;
    }
  }

  /**
   * Paginated notification inbox. Cursor is the last seen notification id.
   * Default limit 20, max 100.
   */
  async listNotifications(userId: string, query: GetNotificationsQueryDto) {
    const limit = Math.min(query.limit ?? 20, 100);
    const inbox = await this.inboxWhere(userId);
    const where: Record<string, unknown> = { ...inbox, ...INBOX_HIDES_PUSH_TWINS };

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
      where: { ...inbox, read_at: null, ...INBOX_HIDES_PUSH_TWINS },
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
   * Mark a single notification as read. Returns 404 if the notification
   * does not belong to the requesting user.
   */
  async markRead(notificationId: string, userId: string) {
    const row = await this.prisma.notification.findFirst({
      where: { ...(await this.inboxWhere(userId)), id: notificationId },
    });
    if (!row) {
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
      where: { ...(await this.inboxWhere(userId)), read_at: null },
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
      where: { ...(await this.inboxWhere(userId)), read_at: null, ...INBOX_HIDES_PUSH_TWINS },
    });
  }

  /**
   * The user's inbox: a moved client's rows leave the coach they left
   * (current-coach-inbox.ts), and while two people are in a block the rows
   * that name the other one are left out (inbox-block-rule.ts), added under
   * AND next to any AND the move rule has. Callers add plain keys (id,
   * read_at, created_at, inbox_hidden), never AND.
   */
  private async inboxWhere(userId: string): Promise<Prisma.NotificationWhereInput> {
    const [inbox, blocked] = await Promise.all([
      currentCoachInbox(this.prisma, userId),
      this.inboxBlocks ? this.inboxBlocks.where(userId) : [],
    ]);
    if (blocked.length === 0) return inbox;
    const and = inbox.AND === undefined ? [] : Array.isArray(inbox.AND) ? inbox.AND : [inbox.AND];
    return { ...inbox, AND: [...and, ...blocked] };
  }

  // ── Push delivery (Phase 6B baseline, extended Phase 9) ──────────────────

  /**
   * Phase 6B — Push an alert payload to a coach's device(s).
   *
   * Returns `true` when the push was handed to the one send path (or there
   * was nothing to send to), `false` on a failure. Push failure must never
   * throw — callers treat `false` as graceful fallback to the in-app inbox.
   * PF-3-BE: no caller on main; it goes through pushToUser and the outbox
   * like every other push (no direct Expo send).
   *
   * Phase 11: `payload.category` is forwarded in the tap data. When not
   * provided, defaults to `SYSTEM`.
   */
  async pushToCoach(coachId: string, payload: PushPayload): Promise<boolean> {
    const category = payload.category ?? DEFAULT_NOTIFICATION_CATEGORY;

    this.logger.log(
      `push delivery: coach=${coachId} alertId=${payload.alertId} type=${payload.alertType} sev=${payload.severity} category=${category}`,
    );
    const res = await this.pushToUser(
      coachId,
      payload.message,
      payload.alertType,
      { alertId: payload.alertId, alertType: payload.alertType, category },
      undefined,
      { kind: NotificationKind.COACH_ALERT, dedupeKey: `coach_alert_push:${payload.alertId}` },
    );
    return res.delivered || res.code === 'no-token' || res.code === 'invalid-token';
  }

  /**
   * Send a push notification to any user (coach or client) by userId, in the
   * sender's own words (title, body, tap data).
   *
   * PF-3-BE (one send path): the push is queued in the outbox
   * (PushDeliveryService), never sent to Expo from here, so the outbox's rules
   * apply to it like to every other push: quiet hours in the recipient's zone
   * (a push inside 21:00-08:00 waits for 08:00, the workout reminder keeps its
   * own time), the recipient's switches read again when it goes (`route`:
   * the kind's rule, or Mute all alone; money and a stored Mute all pass go
   * through Mute all), a block with `route.otherUserId` while it waited, the
   * burst cap and the token. `route.dedupeKey` is the event's exactly-once
   * identity, so a replayed send never posts twice.
   *
   * P2-6: `signal` lets the caller (e.g. CoachBriefScheduler) cancel before
   * the push is queued; an abort is reported as 'aborted' and nothing is queued.
   *
   * P1-5: returns a typed PushDeliveryResult. delivered=true now means the
   * push was handed to the one send path (`detail`: queued, deferred to the
   * morning, or a duplicate of one already handed over); no-token and
   * invalid-token mean there is no device to send to (nothing is queued).
   *
   * P1-6: the abort path throws a typed PushAbortedError internally.
   */
  async pushToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
    signal?: AbortSignal,
    route?: PushRoute,
  ): Promise<PushDeliveryResult> {
    const checkAborted = () => {
      if (signal?.aborted) {
        const reason = signal.reason;
        if (reason instanceof Error) throw reason;
        // R17 / Hard Rule — no raw new Error. Throw a typed domain error
        // carrying a stable code so observability can branch on the
        // abort path without string-matching.
        throw new PushAbortedError(typeof reason === 'string' ? reason : undefined);
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
      if (!this.pushDelivery) {
        this.logger.warn(`pushToUser: no push outbox wired; user=${userId} not sent`);
        return { delivered: false, code: 'transport-error', detail: 'no-outbox' };
      }
      // A sender that names no route has no switch of its own: Mute all alone.
      const r: PushRoute = route ?? {
        kind: typeof data?.kind === 'string' ? data.kind : 'push',
        muteAllOnly: true,
      };
      const timeZone = await resolveRecipientTimeZone(this.prisma, userId);
      checkAborted();
      const dedupeKey = r.dedupeKey ?? `push:${randomUUID()}`;
      const queued = await this.pushDelivery.enqueue({
        userId,
        kind: r.kind,
        title,
        body,
        data: data ?? {},
        context: {
          senderWords: true,
          ...(r.muteAllOnly ? { muteAllOnly: true as const } : {}),
          ...(r.passesMuteAll ? MUTE_ALL_PASS : {}),
          ...(r.otherUserId ? { otherUserId: r.otherUserId } : {}),
        },
        dedupeKey,
        collapseKey: dedupeKey,
        timeZone,
      });
      return { delivered: true, code: 'delivered', detail: queued.code };
    } catch (err) {
      // R17: return a scrubbed typed result to the caller. The `detail`
      // field carries only the Error.name so we never leak stack traces or
      // query text. B-700-1: the log line holds the class and code only.
      this.logger.error(`Push notification failed for user ${userId}: ${describeFailure(err)}`);
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
      this.logger.error(`claimDigestWindow unexpected error: ${describeFailure(err)}`);
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

  /** B-648-7: the `inapp` row a declared push twin duplicates. A failed read proves nothing. */
  private async inboxCounterpartExists(
    db: Pick<PrismaService, 'notification'> | Prisma.TransactionClient,
    input: CreateNotificationInput,
    body: string,
  ): Promise<boolean> {
    try {
      const twin = await db.notification.findFirst({
        where: {
          user_id: input.user_id,
          kind: input.kind,
          channel: 'inapp',
          deep_link: input.deep_link ?? null,
          body,
          created_at: { gte: new Date(Date.now() - PUSH_TWIN_WINDOW_MS) },
        },
        select: { id: true },
      });
      return twin !== null;
    } catch {
      return false;
    }
  }

  /**
   * C-648-3: which side of a booking the recipient is on, so the tap opens
   * that side's session screen. Null for non-booking kinds, a missing
   * session or a failed read (the tap then opens the notification center).
   */
  private async bookingRole(
    db: Pick<PrismaService, 'coachingSession'> | Prisma.TransactionClient,
    kind: string,
    userId: string,
    sessionId: string | undefined,
  ): Promise<'client' | 'coach' | null> {
    if (!sessionId || notificationPrefsPrefix(kind) !== 'booking') return null;
    try {
      const session = await db.coachingSession.findUnique({
        where: { id: sessionId },
        select: { coach_id: true, client_id: true },
      });
      if (!session) return null;
      if (session.coach_id === userId) return 'coach';
      if (session.client_id === userId) return 'client';
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Maps a NotificationKind value to the base preferences key prefix.
   * E.g. 'milestone_reached' → 'milestone'
   */
  private _kindToPrefsPrefix(kind: string): string {
    // B-NOTIF-6: one mapping shared with the push worker (push-preferences.ts).
    return notificationPrefsPrefix(kind);
  }
}

/**
 * The booking tap targets, the same contract as the S-SCHED booking
 * emitter (#634) and the mobile push router (#325): a client opens the
 * session in their calendar, a coach opens the booking inbox, both with
 * `actionParams.sessionId`.
 */
export const BOOKING_PUSH_SCREEN = { client: 'CalendarSession', coach: 'CoachBookingInbox' } as const;

/**
 * Tap routing a device push carries (ids and enums only, never user text).
 * C-648-3: a booking push opens that session (BOOKING_PUSH_SCREEN for the
 * recipient's side, with `actionParams.sessionId`); a build without that
 * route falls back to the notification center (the mobile tap router's
 * unknown-screen rule). A message opens Messages; everything else opens the
 * notification center. `deepLink` and the top-level `sessionId` stay for
 * builds that read them.
 */
export function pushTapData(
  kind: string,
  deepLink: string | undefined,
  sessionId: string | undefined,
  bookingRole: 'client' | 'coach' | null = null,
): Record<string, unknown> {
  const prefix = notificationPrefsPrefix(kind);
  const booking =
    prefix === 'booking' &&
    bookingRole !== null &&
    typeof sessionId === 'string' &&
    sessionId.length > 0;
  // FU-WORKLOG-126: a workout push (assigned or reminder) opens the client's
  // Workouts tab, where the coach's workout is, instead of the inbox.
  const workout = kind === 'workout_assigned' || kind === 'workout_reminder';
  const actionScreen = booking
    ? BOOKING_PUSH_SCREEN[bookingRole]
    : prefix === 'message'
      ? 'Messages'
      : workout
        ? 'WorkoutMain'
        : 'NotificationCenter';
  return {
    actionScreen,
    ...(booking ? { actionParams: { sessionId } } : {}),
    ...(deepLink ? { deepLink } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
