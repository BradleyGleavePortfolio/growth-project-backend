/**
 * community-notifications.service.ts — Community v1-4 push wrapper.
 *
 * WHY a wrapper (not edits inside NotificationsService): keeps the 712-LOC core
 * untouched (single-responsibility, #15) while adding the Community semantics —
 * per-kind defaults, lock-screen privacy, idempotency, and telemetry. It
 * DELEGATES delivery to the existing NotificationsService (createNotification +
 * pushToUser); it never re-implements Expo wiring (#bypass-NotificationsService).
 *
 * Everything is gated behind FEATURE_COMMUNITY_PUSH, read from process.env AT
 * THE CALL SITE (never boot-cached). When off, no community push payload is
 * even constructed; the standard NotificationsService path for non-community
 * kinds is unaffected.
 *
 * LOCK-SCREEN PRIVACY (HARD GATE #4): the v1-1 schema has NO lockscreen-
 * privacy column on User (verified by grep; see
 * LOCKSCREEN_PRIVACY_FIELD_MISSING.md at repo root). v1-4 is schema-frozen
 * (zero schema mutation), so resolveLockscreenPrivacy() returns privacy-ON
 * UNCONDITIONALLY — the strictly safe choice, a generic body can never leak
 * sender names or message text. The instant a `lockscreenPrivacy` column
 * lands in a future schema PR, that one method is the single place to read it.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import {
  COMMUNITY_TELEMETRY_EVENTS,
  classifyTelemetryError,
} from '../community-events';
import {
  COMMUNITY_PUSH_BODIES,
  COMMUNITY_PUSH_DEFAULTS,
  COMMUNITY_PUSH_TITLES,
  CommunityChannelDefaults,
  CommunityPushBodyContext,
  CommunityPushKind,
} from './community-notifications.types';

export interface SendCommunityPushInput {
  /** The recipient. Telemetry distinctId is always this id. */
  recipientId: string;
  kind: CommunityPushKind;
  /** Idempotency dimensions — (kind, recipientId, targetType, targetId). */
  targetType: string;
  targetId: string;
  /** Optional deep link (tgp://…). Never carries user text. */
  deepLink?: string;
  /** Pre-approved short context for the privacy-OFF body only. */
  bodyContext?: CommunityPushBodyContext;
  /**
   * Forward-compatible carrier for a future per-user privacy value. Currently
   * IGNORED — resolveLockscreenPrivacy() returns privacy-ON unconditionally
   * because no `lockscreenPrivacy` column exists on User (zero schema
   * mutation). Kept on the input shape so the call surface is stable once the
   * column lands and the resolver starts reading the real value.
   */
  lockscreenPrivacy?: boolean;
}

type SkipReason = 'flag_off' | 'preference_off' | 'no_token';

@Injectable()
export class CommunityNotificationsService {
  private readonly logger = new Logger(CommunityNotificationsService.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Push flag — read per call, never cached. */
  private pushEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_PUSH === 'true';
  }

  /** Telemetry flag — read per call, never cached. */
  private telemetryEnabled(): boolean {
    return process.env.FEATURE_COMMUNITY_TELEMETRY === 'true';
  }

  /** Defaults for a community kind (read-path preference resolution). */
  defaultsFor(kind: CommunityPushKind): CommunityChannelDefaults {
    return COMMUNITY_PUSH_DEFAULTS[kind];
  }

  /**
   * Resolve the recipient's lock-screen privacy state.
   *
   * HARD GATE #4 + ZERO SCHEMA MUTATION: the v1-1 schema has NO
   * `lockscreenPrivacy` / `lockscreen_privacy` column on User (verified by
   * grep; see LOCKSCREEN_PRIVACY_FIELD_MISSING.md at repo root). v1-4 is
   * schema-frozen, so we CANNOT read a real value and CANNOT add the column
   * here. The strictly-safe resolution is therefore PRIVACY-ON, UNCONDITIONALLY
   * — a generic body can never leak sender names or message text.
   *
   * There is intentionally NO caller override: an override could turn privacy
   * OFF without a real per-user DB value backing it, defeating the gate. The
   * instant a `lockscreenPrivacy` column lands in a future schema PR, replace
   * the body of this method with a read of the recipient's column value.
   */
  resolveLockscreenPrivacy(_lockscreenPrivacy?: boolean): boolean {
    return true; // privacy-on, unconditionally — schema field absent (gate #4)
  }

  /**
   * Build the lock-screen-aware push body. Privacy ON → fixed safe string
   * (never tenant data). Privacy OFF → the templated body from pre-approved
   * short context.
   */
  buildBody(input: SendCommunityPushInput): string {
    const copy = COMMUNITY_PUSH_BODIES[input.kind];
    if (this.resolveLockscreenPrivacy(input.lockscreenPrivacy)) {
      return copy.privacyOn;
    }
    return copy.privacyOff(input.bodyContext ?? {});
  }

  /**
   * Stable idempotency key derived from (kind, recipientId, targetType,
   * targetId) so a Stripe-webhook-style replay cannot double-push. Stored on
   * the Notification.payload (no schema column needed) and checked before send.
   */
  static idempotencyKey(input: {
    kind: string;
    recipientId: string;
    targetType: string;
    targetId: string;
  }): string {
    return `community:${input.kind}:${input.recipientId}:${input.targetType}:${input.targetId}`;
  }

  /**
   * Send a Community push. Fire-and-forget AFTER the DB write returns (#44):
   * callers void-prefix this; we never block or fail the write. Returns void.
   */
  async sendCommunityPush(input: SendCommunityPushInput): Promise<void> {
    const { recipientId, kind, targetType, targetId } = input;
    const defaults = this.defaultsFor(kind);

    // 1) Flag gate — when off, construct nothing.
    if (!this.pushEnabled()) {
      this.track(recipientId, COMMUNITY_TELEMETRY_EVENTS.pushSkipped, {
        kind,
        reason: 'flag_off' satisfies SkipReason,
      });
      return;
    }

    // 2) Preference gate — read-path default (no per-kind prefs column exists).
    if (!defaults.push) {
      this.track(recipientId, COMMUNITY_TELEMETRY_EVENTS.pushSkipped, {
        kind,
        reason: 'preference_off' satisfies SkipReason,
      });
      return;
    }

    const idempotencyKey = CommunityNotificationsService.idempotencyKey({
      kind,
      recipientId,
      targetType,
      targetId,
    });

    try {
      // 3) Replay guard: if a notification row with this idempotency key
      // already exists for this recipient+kind, do not double-push.
      const existing = await this.prisma.notification.findFirst({
        where: {
          user_id: recipientId,
          kind,
          payload: { path: ['idempotency_key'], equals: idempotencyKey },
        },
        select: { id: true },
      });
      if (existing) {
        this.logger.debug(
          `sendCommunityPush idempotent skip: ${idempotencyKey}`,
        );
        return;
      }

      // 4) No token → skip (telemetry reason no_token). The core push path
      // also handles this, but we surface the analytics reason explicitly.
      const recipient = await this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { expo_push_token: true },
      });
      if (!recipient?.expo_push_token) {
        this.track(recipientId, COMMUNITY_TELEMETRY_EVENTS.pushSkipped, {
          kind,
          reason: 'no_token' satisfies SkipReason,
        });
        return;
      }

      const privacyOn = this.resolveLockscreenPrivacy(input.lockscreenPrivacy);
      const body = this.buildBody(input);
      const title = COMMUNITY_PUSH_TITLES[kind];

      // 5) Write the inbox row through the EXISTING core (preference gate +
      // 60s rate-limit live there). payload carries the idempotency key (no
      // user text) so the replay guard above can find it next time.
      await this.notifications.createNotification({
        user_id: recipientId,
        kind,
        body,
        channel: 'push',
        deep_link: input.deepLink,
        payload: {
          idempotency_key: idempotencyKey,
          category: defaults.category,
          target_type: targetType,
          target_id: targetId,
        },
      });

      // 6) Deliver via the EXISTING Expo transport. data carries IDs + enum
      // only — never user text.
      const result = await this.notifications.pushToUser(
        recipientId,
        title,
        body,
        {
          kind,
          category: defaults.category,
          target_type: targetType,
          target_id: targetId,
        },
      );

      if (result.delivered) {
        this.track(recipientId, COMMUNITY_TELEMETRY_EVENTS.pushSent, {
          kind,
          category: defaults.category,
          privacy_on: privacyOn,
        });
      } else {
        // Not delivered (no-token / ticket-error / transport): surface as a
        // delivery failure with the transport code — never silent (#36).
        this.logger.warn(
          `sendCommunityPush not delivered: kind=${kind} recipient=${recipientId} code=${result.code}`,
        );
        this.track(
          recipientId,
          COMMUNITY_TELEMETRY_EVENTS.pushDeliveryFailed,
          { kind, error_code: result.code },
        );
      }
    } catch (err) {
      // Best-effort: never throw to the caller (the DB write already
      // committed). Log + emit delivery_failed telemetry (#36).
      // Raw message stays SERVER-SIDE in the log only.
      const message = (err as Error).message;
      this.logger.warn(
        `sendCommunityPush failed: kind=${kind} recipient=${recipientId}: ${message}`,
      );
      // Telemetry carries a BOUNDED, allowlisted code — never the raw exception
      // message (PII gate): it could leak user text / emails / push tokens.
      this.track(
        recipientId,
        COMMUNITY_TELEMETRY_EVENTS.pushDeliveryFailed,
        { kind, error_code: classifyTelemetryError(err) },
      );
    }
  }

  /** Telemetry helper — gated on FEATURE_COMMUNITY_TELEMETRY, no user text. */
  private track(
    distinctId: string,
    event: string,
    props: Record<string, unknown>,
  ): void {
    if (!this.telemetryEnabled()) return;
    this.analytics.capture(distinctId, event, props);
  }
}
