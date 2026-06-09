import { Injectable, Optional } from '@nestjs/common';
import { AnalyticsService } from '../../analytics/analytics.service';
import { ROMAN_FLAGS } from './dunning-v2.copy';

/**
 * B3 Smart Dunning v2 — PostHog telemetry (spec §5).
 *
 * The event names below are LOCKED by the spec — do not invent variants. Each
 * is fired through the existing `AnalyticsService.capture(distinctId, event,
 * props)` path (no-op when POSTHOG_KEY is unset), so telemetry never throws
 * into a billing transaction.
 *
 * The locked Roman flags (`roman_enabled`, the two quip rates) are attached to
 * every event so dashboards can segment the v2 rollout without drift
 * (ROMAN_VOICE_POLICY §5).
 */
export const DunningV2Events = {
  /** Day-0 charge fail. */
  ATTEMPT_FAILED: 'dunning.attempt.failed',
  /** A notify was dispatched. props: day, channel, recipient_role. */
  NOTIFY_SENT: 'dunning.notify.sent',
  /** An in-app blocker pop-up was shown (Day 3 / Day 7). */
  BLOCKER_SHOWN: 'dunning.blocker.shown',
  /** The coach was notified at Step 3 (Day 7). */
  COACH_NOTIFIED: 'dunning.coach.notified',
  /** Day-10 hard lockout entered. */
  LOCKOUT_ENTERED: 'dunning.lockout.entered',
  /** Dunning resolved. props: via=card_update|retry|manual. */
  RECOVERED: 'dunning.recovered',
  /** A previously-cleared charge was reversed (late-reversal detected). */
  REVERSAL_DETECTED: 'dunning.reversal.detected',
  /** A locked-out client was restored to full access. */
  LOCKOUT_EXITED: 'dunning.lockout.exited',
} as const;

export type DunningV2Event =
  (typeof DunningV2Events)[keyof typeof DunningV2Events];

/** Base Roman flag props attached to every v2 dunning event (frozen). */
export function romanFlagProps(): Record<string, unknown> {
  return {
    roman_enabled: true,
    roman_quip_rate_client: ROMAN_FLAGS.roman_quip_rate_client,
    roman_quip_rate_coach: ROMAN_FLAGS.roman_quip_rate_coach,
  };
}

@Injectable()
export class DunningV2Telemetry {
  // AnalyticsService is @Optional so unit tests can construct without it.
  constructor(@Optional() private readonly analytics?: AnalyticsService) {}

  private emit(
    distinctId: string,
    event: DunningV2Event,
    props?: Record<string, unknown>,
  ): void {
    // capture() already swallows errors; the @Optional guard covers the
    // test-double path where analytics is absent.
    this.analytics?.capture(distinctId, event, {
      ...romanFlagProps(),
      ...(props ?? {}),
    });
  }

  attemptFailed(distinctId: string, props?: Record<string, unknown>): void {
    this.emit(distinctId, DunningV2Events.ATTEMPT_FAILED, props);
  }

  notifySent(
    distinctId: string,
    day: number,
    channel: 'push' | 'email' | 'inapp',
    recipientRole: 'client' | 'coach',
  ): void {
    this.emit(distinctId, DunningV2Events.NOTIFY_SENT, {
      day,
      channel,
      recipient_role: recipientRole,
    });
  }

  blockerShown(distinctId: string, day: number): void {
    this.emit(distinctId, DunningV2Events.BLOCKER_SHOWN, { day });
  }

  coachNotified(distinctId: string, props?: Record<string, unknown>): void {
    this.emit(distinctId, DunningV2Events.COACH_NOTIFIED, props);
  }

  lockoutEntered(distinctId: string, props?: Record<string, unknown>): void {
    this.emit(distinctId, DunningV2Events.LOCKOUT_ENTERED, props);
  }

  recovered(
    distinctId: string,
    via: 'card_update' | 'retry' | 'manual',
  ): void {
    this.emit(distinctId, DunningV2Events.RECOVERED, { via });
  }

  reversalDetected(distinctId: string, props?: Record<string, unknown>): void {
    this.emit(distinctId, DunningV2Events.REVERSAL_DETECTED, props);
  }

  lockoutExited(distinctId: string, props?: Record<string, unknown>): void {
    this.emit(distinctId, DunningV2Events.LOCKOUT_EXITED, props);
  }
}
