import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { CoachAlertEmitter } from '../../notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import {
  ChannelDecision,
  DunningEscalationClassifier,
} from './dunning-escalation.classifier';
import {
  CopyTokens,
  DunningV2Renderer,
  QuipRotation,
} from './dunning-v2.renderer';
import { DunningV2Telemetry } from './dunning-v2.telemetry';
import { DUNNING_V2_CADENCE_DAYS } from './dunning-v2.cadence';

/**
 * B3 Smart Dunning v2 — notification dispatcher + coach notifier (spec §4, §9).
 *
 * Single fan-out point. Given a resolved step the dispatcher fires the exact
 * channel ladder the classifier returns, rendering Roman copy (straight vs
 * dry-Roman per the locked quip rotation) and emitting locked PostHog telemetry
 * per channel.
 *
 * Channel transports reuse v1 infrastructure (NO new deps):
 *   - push  → NotificationsService.pushToUser / pushToCoach (Expo).
 *   - email → EmailService.send (Resend pipeline; idempotency-keyed).
 *   - inapp → NotificationsService.createNotification (the durable feed row).
 *   - coach → CoachNotifierService fans out in-app + push + email at Step 3.
 *
 * Coach-notify idempotency (spec §9.3): per-transport keys
 * `coach_notify:{dunning_state_id}:{inapp|push|email}` are threaded into the
 * email idempotency key and the in-app/push dedup so a retried trigger never
 * triple-sends. The in-app row is the durable source of truth.
 *
 * EmailService / NotificationsService are @Optional so unit tests can construct
 * a thin instance; production wiring in the v2 module supplies all three.
 */

/** Resolved context the cadence service hands the dispatcher per step. */
export interface DispatchContext {
  dunningStateId: string;
  stepIndex: number;
  isLateReversalCycle: boolean;
  /** The locked-out client. */
  clientUserId: string;
  /** The owning coach (spec §9.2 resolution). */
  coachUserId: string;
  clientEmail: string | null;
  coachEmail: string | null;
  tokens: CopyTokens;
  /** Deep link to the dunning detail view for the coach email (§9.2). */
  dunningDetailDeeplink: string;
}

@Injectable()
export class DunningV2Dispatcher {
  private readonly logger = new Logger(DunningV2Dispatcher.name);

  constructor(
    private readonly classifier: DunningEscalationClassifier,
    private readonly renderer: DunningV2Renderer,
    private readonly telemetry: DunningV2Telemetry,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly coachAlert?: CoachAlertEmitter,
  ) {}

  /**
   * Dispatch all channels for a resolved (failed) cadence step. `rotation` is a
   * per-session QuipRotation so the "never two quips in a row" rule holds
   * across a render sequence; callers may pass a fresh one per dispatch.
   */
  async dispatchStep(
    ctx: DispatchContext,
    rotation: QuipRotation = new QuipRotation(),
  ): Promise<ChannelDecision> {
    const decision = this.classifier.resolve({
      stepIndex: ctx.stepIndex,
      isLateReversalCycle: ctx.isLateReversalCycle,
    });
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;

    // Day-0 charge failure telemetry (spec §5: dunning.attempt.failed).
    if (ctx.stepIndex === 0) {
      this.telemetry.attemptFailed(ctx.clientUserId, { day });
    }

    if (decision.push) {
      await this.safe('client push', () => this.sendClientPush(ctx, decision));
    }
    if (decision.email) {
      await this.safe('client email', () =>
        this.sendClientEmail(ctx, decision, rotation),
      );
    }
    if (decision.inAppBlocker) {
      await this.safe('client blocker', () =>
        this.sendBlocker(ctx, decision, rotation, day),
      );
    }
    if (decision.coachAllChannels) {
      await this.safe('coach notify', () =>
        this.notifyCoachAllChannels(ctx),
      );
    }
    return decision;
  }

  // ── Client transports ────────────────────────────────────────────────────

  private async sendClientPush(
    ctx: DispatchContext,
    decision: ChannelDecision,
  ): Promise<void> {
    // Money surface: quip is allowed but may opt out; client rate 0.125.
    const rotation = new QuipRotation();
    const quip = rotation.shouldQuip('client');
    const body = this.renderer.clientPush(decision.copyKey, ctx.tokens, quip);
    if (this.notifications) {
      await this.notifications.pushToUser(ctx.clientUserId, 'Payment', body);
    }
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;
    this.telemetry.notifySent(ctx.clientUserId, day, 'push', 'client');
  }

  private async sendClientEmail(
    ctx: DispatchContext,
    decision: ChannelDecision,
    rotation: QuipRotation,
  ): Promise<void> {
    const quip = rotation.shouldQuip('client');
    const body = this.renderer.clientEmail(decision.copyKey, ctx.tokens, quip);
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;
    if (this.email && ctx.clientEmail) {
      await this.email.send({
        to: ctx.clientEmail,
        template: this.emailTemplateForStep(ctx.stepIndex),
        data: { roman_body: body, ...ctx.tokens },
        idempotencyKey: `dunning_v2:${ctx.dunningStateId}:email:${ctx.stepIndex}`,
      });
    }
    this.telemetry.notifySent(ctx.clientUserId, day, 'email', 'client');
  }

  private async sendBlocker(
    ctx: DispatchContext,
    decision: ChannelDecision,
    rotation: QuipRotation,
    day: number,
  ): Promise<void> {
    const variant =
      decision.blockerVariant === 'none'
        ? 'day3'
        : (decision.copyKey === 'lr_day3'
            ? 'lr_day3'
            : decision.blockerVariant);
    const quip = rotation.shouldQuip('client');
    const blocker = this.renderer.blocker(
      variant as 'day3' | 'day7' | 'lr_day3',
      ctx.tokens,
      quip,
    );
    if (this.notifications) {
      // The blocker flag is a durable in-app notification the client reads on
      // session start; the mobile client renders the modal from it (§8.2).
      await this.notifications.createNotification({
        user_id: ctx.clientUserId,
        kind: NotificationKind.DUNNING_BLOCKER,
        body: blocker.body.slice(0, 160),
        payload: {
          headline: blocker.headline,
          primaryCta: blocker.primaryCta,
          secondaryCta: blocker.secondaryCta,
          variant,
          dunningStateId: ctx.dunningStateId,
        },
        deep_link: 'tgp://billing/update',
        channel: 'inapp',
      });
    }
    this.telemetry.blockerShown(ctx.clientUserId, day);
  }

  // ── Coach notifier (spec §9) — all three transports, idempotency-keyed ────

  private async notifyCoachAllChannels(ctx: DispatchContext): Promise<void> {
    const rotation = new QuipRotation();
    // Coach quip rate 0.083; never two in a row across the 3 transports.
    const inappQuip = rotation.shouldQuip('coach');
    const pushQuip = rotation.shouldQuip('coach');
    const emailQuip = rotation.shouldQuip('coach');

    const inappBody = this.renderer.coachInApp(ctx.tokens, inappQuip);
    const pushBody = this.renderer.coachPush(ctx.tokens, pushQuip);
    const emailBody = this.renderer.coachEmail(
      { ...ctx.tokens, dunningDetailDeeplink: ctx.dunningDetailDeeplink },
      emailQuip,
    );

    // In-app + push via the existing CoachAlertEmitter (writes the durable
    // feed row AND pushes). Idempotency is keyed on dunning_state_id so a
    // retried trigger does not duplicate (§9.3).
    if (this.coachAlert) {
      await this.coachAlert.emit({
        coachId: ctx.coachUserId,
        alertId: `coach_notify:${ctx.dunningStateId}`,
        alertType: 'dunning_step7',
        message: inappBody,
        severity: 'warning',
        clientUserId: ctx.clientUserId,
      });
    } else if (this.notifications) {
      await this.notifications.pushToCoach(ctx.coachUserId, {
        alertId: `coach_notify:${ctx.dunningStateId}`,
        alertType: 'dunning_step7',
        severity: 'warning',
        message: pushBody.slice(0, 160),
      });
    }

    if (this.email && ctx.coachEmail) {
      await this.email.send({
        to: ctx.coachEmail,
        template: EmailTemplateKey.DUNNING_FINAL,
        data: { roman_body: emailBody, ...ctx.tokens },
        idempotencyKey: `coach_notify:${ctx.dunningStateId}:email`,
      });
    }

    this.telemetry.coachNotified(ctx.coachUserId, {
      dunning_state_id: ctx.dunningStateId,
    });
    this.telemetry.notifySent(ctx.coachUserId, 7, 'inapp', 'coach');
    this.telemetry.notifySent(ctx.coachUserId, 7, 'push', 'coach');
    this.telemetry.notifySent(ctx.coachUserId, 7, 'email', 'coach');
  }

  /** Map a v2 step to its email template (reuses v1 cadence templates). */
  private emailTemplateForStep(stepIndex: number): EmailTemplateKey {
    switch (stepIndex) {
      case 1:
        return EmailTemplateKey.PAYMENT_REMINDER_URGENT;
      case 2:
        return EmailTemplateKey.PAYMENT_FINAL_NOTICE;
      case 3:
        return EmailTemplateKey.PAYMENT_FINAL_NOTICE;
      default:
        return EmailTemplateKey.PAYMENT_REMINDER_SOFT;
    }
  }

  /** Run a transport; never let a transport failure break the cadence tick. */
  private async safe(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `dunning v2 ${label} transport failed: ${(err as Error).message}`,
      );
    }
  }
}
