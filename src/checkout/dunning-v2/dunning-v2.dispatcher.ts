import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { CoachAlertEmitter } from '../../notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import { ChannelDecision, DunningEscalationClassifier } from './dunning-escalation.classifier';
import { CopyTokens, DunningV2Renderer, QuipRotation } from './dunning-v2.renderer';
import { DunningV2Telemetry } from './dunning-v2.telemetry';
import { DUNNING_UPDATE_CARD_URL, DUNNING_V2_CADENCE_DAYS } from './dunning-v2.cadence';
import { VoicePolicyService } from '../../roman/voice/voice-policy.service';
import { SurfaceKey, RomanCopyPayload } from '../../roman/voice/voice-policy.constants';
import { applyTokensTruthfully } from './dunning-v2.renderer';
import { dunningErrorCode } from './dunning-v2.safe-error';

/**
 * Phase 2 — map a dunning classifier `copyKey` to the Roman Phase 2 in-app
 * `SurfaceKey`. Only the Day 0/1/3/7 client surfaces are in Phase 2 scope; the
 * late-reversal keys and coach surfaces are NOT swapped here and return
 * `undefined` so the dispatcher keeps its existing rendering for them.
 */
function phase2SurfaceForCopyKey(copyKey: string): SurfaceKey | undefined {
  switch (copyKey) {
    case 'day0':
      return 'dunning_day0';
    case 'day1':
      return 'dunning_day1';
    case 'day3':
      return 'dunning_day3';
    case 'day7':
      return 'dunning_day7';
    default:
      return undefined;
  }
}

/**
 * B3 Smart Dunning v2 — notification dispatcher + coach notifier (spec §4, §9).
 *
 * Single fan-out point. Given a resolved step the dispatcher fires the exact
 * channel ladder the classifier returns, rendering Roman copy (straight vs
 * dry-Roman per the locked quip rotation) and emitting locked PostHog telemetry
 * per channel.
 *
 * Channel transports reuse v1 infrastructure (NO new deps):
 *   - push  → NotificationsService.pushToUser / pushToCoach (Expo; no
 *     idempotency key, so at-least-once after an expired claim, C-628-12).
 *   - email → EmailService.send (Resend pipeline; idempotency-keyed).
 *   - inapp → NotificationsService.createNotification (the durable feed row).
 *   - coach → CoachAlertEmitter (in-app feed row, then push) and the coach
 *     email at Step 3, each its own outbox channel (B-688-3).
 *
 * Coach-notify idempotency (spec §9.3): per-transport keys
 * `coach_notify:{dunning_state_id}:{inapp|push|email}` are threaded into the
 * email idempotency key and the in-app/push dedup so a retried trigger never
 * triple-sends. The in-app row is the durable source of truth.
 *
 * EmailService / NotificationsService are @Optional so unit tests can construct
 * a thin instance; production wiring in the v2 module supplies all three.
 */

/** One transport of a step's notice (S-DUNNING-R3 outbox channel). */
export type DunningChannel =
  'client_push' | 'client_email' | 'client_blocker' | 'coach_alert' | 'coach_push' | 'coach_email';

export type ChannelStatus = 'sent' | 'skipped' | 'failed';

export interface ChannelResult {
  status: ChannelStatus;
  /** A closed code ("push_ticket-error"), never provider text (B-688-4). */
  error?: string;
}

export interface DispatchOutcome {
  decision: ChannelDecision;
  results: Partial<Record<DunningChannel, ChannelResult>>;
}

/** The transports a step's decision calls for, in send order. Pure. */
export function dunningChannelsFor(decision: ChannelDecision): DunningChannel[] {
  const out: DunningChannel[] = [];
  if (decision.push) out.push('client_push');
  if (decision.email) out.push('client_email');
  if (decision.inAppBlocker) out.push('client_blocker');
  if (decision.coachAllChannels) out.push('coach_alert', 'coach_push', 'coach_email');
  return out;
}

/** Resolved context the cadence service hands the dispatcher per step. */
export interface DispatchContext {
  dunningStateId: string;
  /** B-628-6: the cycle's entered_at in ms; idempotency keys carry it. */
  cycleKey?: string;
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
    // Phase 2 — the single Roman Option-3 copy source of truth. @Optional so
    // thin unit tests can construct the dispatcher without DI; when present,
    // the Day 0/1/3/7 in-app client copy funnels through it (flag-gated).
    @Optional() private readonly voice?: VoicePolicyService,
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
    const { decision } = await this.dispatchStepDetailed(ctx, rotation);
    return decision;
  }

  /**
   * B-628-6: send a step's notices and report each transport's real result.
   * `channels` limits a retry to the failed transports; `attempt` > 0 gives
   * the email a fresh idempotency key (EmailService remembers failed keys).
   */
  async dispatchStepDetailed(
    ctx: DispatchContext,
    rotation: QuipRotation = new QuipRotation(),
    opts: { channels?: DunningChannel[]; attempt?: number } = {},
  ): Promise<DispatchOutcome> {
    const decision = this.classifier.resolve({
      stepIndex: ctx.stepIndex,
      isLateReversalCycle: ctx.isLateReversalCycle,
    });
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;
    const wanted = new Set(opts.channels ?? dunningChannelsFor(decision));
    const attempt = opts.attempt ?? 0;
    const results: Partial<Record<DunningChannel, ChannelResult>> = {};

    // Day-0 charge failure telemetry (spec §5: dunning.attempt.failed).
    if (ctx.stepIndex === 0 && attempt === 0) {
      this.telemetry.attemptFailed(ctx.clientUserId, { day });
    }

    if (decision.push && wanted.has('client_push')) {
      results.client_push = await this.run('client push', () => this.sendClientPush(ctx, decision));
    }
    if (decision.email && wanted.has('client_email')) {
      results.client_email = await this.run('client email', () =>
        this.sendClientEmail(ctx, decision, rotation, attempt),
      );
    }
    if (decision.inAppBlocker && wanted.has('client_blocker')) {
      results.client_blocker = await this.run('client blocker', () =>
        this.sendBlocker(ctx, decision, rotation, day),
      );
    }
    const coachWanted = ['coach_alert', 'coach_push', 'coach_email'].some((c) =>
      wanted.has(c as DunningChannel),
    );
    if (decision.coachAllChannels && coachWanted) {
      const coach = await this.notifyCoachAllChannels(ctx, {
        alert: wanted.has('coach_alert'),
        push: wanted.has('coach_push'),
        email: wanted.has('coach_email'),
        attempt,
      });
      Object.assign(results, coach);
    }
    return { decision, results };
  }

  /** Cycle-scoped key segment ("" for a legacy context without a cycle). */
  private cyclePart(ctx: DispatchContext): string {
    return ctx.cycleKey ? `:${ctx.cycleKey}` : '';
  }

  // ── Client transports ────────────────────────────────────────────────────

  private async sendClientPush(
    ctx: DispatchContext,
    decision: ChannelDecision,
  ): Promise<ChannelResult> {
    // Phase 2: route the Day 0/1/3/7 in-app client copy through the Roman
    // Voice Policy. With FEATURE_ROMAN_COPY_V2 OFF the policy returns the
    // LEGACY string — byte-equal to this renderer's `straight` variant — so
    // flag-off behaviour is unchanged. With the flag ON it returns the Roman
    // Option-3 variant. The `avatar_crop` rides along on the surface so the UI
    // never renders Roman's voice without his face.
    const policy = this.resolvePhase2Copy(decision.copyKey, ctx);
    let body: string;
    if (policy && policy.voice_variant === 'roman_v2') {
      // Flag ON: use the Roman Option-3 Phase 2 copy.
      body = applyTokensTruthfully(policy.text, ctx.tokens);
    } else {
      // Flag OFF (or out of Phase 2 scope): keep the EXACT existing rendering,
      // including the locked quip rotation, so flag-off runtime behaviour is
      // byte-for-byte unchanged. Money surface, client rate 0.125.
      const rotation = new QuipRotation();
      const quip = rotation.shouldQuip('client');
      body = this.renderer.clientPush(decision.copyKey, ctx.tokens, quip);
    }
    if (!this.notifications) return { status: 'skipped', error: 'push_not_wired' };
    const res = await this.notifications.pushToUser(ctx.clientUserId, 'Payment', body);
    // A transport that returns no verdict (legacy stubs) counts as sent.
    if (typeof res === 'object' && res !== null && res.delivered === false) {
      if (res.code === 'no-token') return { status: 'skipped', error: 'push_no_token' };
      return { status: 'failed', error: `push_${res.code}` };
    }
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;
    this.telemetry.notifySent(ctx.clientUserId, day, 'push', 'client');
    return { status: 'sent' };
  }

  /**
   * Phase 2 helper: resolve the Roman Voice Policy payload for a Day 0/1/3/7
   * client copyKey, or `undefined` when the key is out of Phase 2 scope or the
   * VoicePolicyService is not wired (thin unit tests). Never throws into the
   * dispatch path — a missing policy falls back to the legacy renderer.
   */
  private resolvePhase2Copy(copyKey: string, _ctx: DispatchContext): RomanCopyPayload | undefined {
    if (!this.voice) {
      return undefined;
    }
    const surface = phase2SurfaceForCopyKey(copyKey);
    if (!surface) {
      return undefined;
    }
    return this.voice.copyFor(surface);
  }

  private async sendClientEmail(
    ctx: DispatchContext,
    decision: ChannelDecision,
    rotation: QuipRotation,
    attempt: number,
  ): Promise<ChannelResult> {
    const quip = rotation.shouldQuip('client');
    const body = this.renderer.clientEmail(decision.copyKey, ctx.tokens, quip);
    const day = DUNNING_V2_CADENCE_DAYS[ctx.stepIndex] ?? ctx.stepIndex;
    if (!this.email) return { status: 'skipped', error: 'email_not_wired' };
    if (!ctx.clientEmail) return { status: 'skipped', error: 'email_no_address' };
    {
      const res = await this.email.send({
        to: ctx.clientEmail,
        template: EmailTemplateKey.DUNNING_V2_CLIENT,
        data: {
          roman_body: body,
          ...ctx.tokens,
          subject: this.clientEmailSubject(ctx),
          update_card_url: DUNNING_UPDATE_CARD_URL,
          // B-687-4/5: card-update and cancel wording differ in a dispute cycle.
          dispute: ctx.isLateReversalCycle,
        },
        idempotencyKey: `dunning_v2:${ctx.dunningStateId}${this.cyclePart(ctx)}:email:${ctx.stepIndex}${attempt > 0 ? `:r${attempt}` : ''}`,
      });
      // The provider's error text stays out of the outbox (B-688-4).
      if (res?.status === 'failed') return { status: 'failed', error: 'email_failed' };
      if (res?.status === 'skipped') return { status: 'skipped', error: 'email_skipped' };
    }
    this.telemetry.notifySent(ctx.clientUserId, day, 'email', 'client');
    return { status: 'sent' };
  }

  private async sendBlocker(
    ctx: DispatchContext,
    decision: ChannelDecision,
    rotation: QuipRotation,
    day: number,
  ): Promise<ChannelResult> {
    // A dispute cycle shows the dispute blocker at every step (B-687-5).
    const variant = ctx.isLateReversalCycle
      ? 'lr_day3'
      : decision.blockerVariant === 'none'
        ? 'day3'
        : decision.blockerVariant;
    const quip = rotation.shouldQuip('client');
    const blocker = this.renderer.blocker(variant as 'day3' | 'day7' | 'lr_day3', ctx.tokens, quip);
    if (!this.notifications) return { status: 'skipped', error: 'inapp_not_wired' };
    {
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
    return { status: 'sent' };
  }

  // ── Coach notifier (spec §9) — all three transports, idempotency-keyed ────

  private async notifyCoachAllChannels(
    ctx: DispatchContext,
    want: { alert: boolean; push: boolean; email: boolean; attempt: number },
  ): Promise<Partial<Record<DunningChannel, ChannelResult>>> {
    const rotation = new QuipRotation();
    // Coach quip rate 0.083; never two in a row across the 3 transports.
    const inappQuip = rotation.shouldQuip('coach');
    const pushQuip = rotation.shouldQuip('coach');
    const emailQuip = rotation.shouldQuip('coach');
    const dispute = ctx.isLateReversalCycle;

    const inappBody = this.renderer.coachInApp(ctx.tokens, inappQuip, dispute);
    const pushBody = this.renderer.coachPush(ctx.tokens, pushQuip, dispute);
    const emailBody = this.renderer.coachEmail(
      { ...ctx.tokens, dunningDetailDeeplink: ctx.dunningDetailDeeplink },
      emailQuip,
      dispute,
    );
    const out: Partial<Record<DunningChannel, ChannelResult>> = {};
    // Cycle-scoped (B-628-6): a second cycle on the same row alerts again.
    const alertId = `coach_notify:${ctx.dunningStateId}${this.cyclePart(ctx)}`;

    // B-688-3: ONE emitter call for whichever of feed row and push is still
    // owed; each is its own outbox channel, so a push retry adds no feed row.
    if (want.alert || want.push) {
      const coach = await this.run('coach alert', async () => {
        if (!this.coachAlert) return { status: 'skipped', error: 'coach_not_wired' };
        const delivery = await this.coachAlert.emit(
          {
            coachId: ctx.coachUserId,
            alertId,
            alertType: 'dunning_step7',
            message: inappBody,
            severity: 'warning',
            clientUserId: ctx.clientUserId,
          },
          { inapp: want.alert, push: want.push },
          { title: 'Payment', body: pushBody },
        );
        // An emitter that returns no verdict (legacy stubs) counts as sent.
        const inapp = delivery?.inapp ?? 'sent';
        const push = delivery?.push ?? 'sent';
        if (want.alert) out.coach_alert = coachResult(inapp, 'inapp');
        if (want.push) {
          // B-687-3: the ticket verdict's code, as on the client push.
          const code = delivery?.pushCode;
          out.coach_push = code
            ? { status: push, error: code === 'no-token' ? 'push_no_token' : `push_${code}` }
            : coachResult(push, 'push');
        }
        if (want.alert && inapp === 'sent') {
          this.telemetry.coachNotified(ctx.coachUserId, { dunning_state_id: ctx.dunningStateId });
          this.telemetry.notifySent(ctx.coachUserId, 7, 'inapp', 'coach');
        }
        if (want.push && push === 'sent')
          this.telemetry.notifySent(ctx.coachUserId, 7, 'push', 'coach');
        return { status: 'sent' };
      });
      // A throw (or no emitter) fails or skips every coach channel asked for.
      if (coach.status !== 'sent') {
        if (want.alert) out.coach_alert = coach;
        if (want.push) out.coach_push = coach;
      }
    }

    if (want.email) {
      out.coach_email = await this.run('coach email', async () => {
        if (!this.email) return { status: 'skipped', error: 'email_not_wired' };
        if (!ctx.coachEmail) return { status: 'skipped', error: 'email_no_address' };
        const res = await this.email.send({
          to: ctx.coachEmail,
          template: EmailTemplateKey.DUNNING_V2_COACH,
          data: { roman_body: emailBody, ...ctx.tokens, dispute },
          idempotencyKey: `${alertId}:email${want.attempt > 0 ? `:r${want.attempt}` : ''}`,
        });
        if (res?.status === 'failed') return { status: 'failed', error: 'email_failed' };
        if (res?.status === 'skipped') return { status: 'skipped', error: 'email_skipped' };
        this.telemetry.notifySent(ctx.coachUserId, 7, 'email', 'coach');
        return { status: 'sent' };
      });
    }
    return out;
  }

  /** Per-step client subject (F17: v2 has its own `roman_body` templates). */
  private clientEmailSubject(ctx: DispatchContext): string {
    // B-687-8: true for a dispute and for an inquiry (no reversal claim).
    if (ctx.isLateReversalCycle) return 'Your plan is paused after a payment dispute or inquiry';
    switch (ctx.stepIndex) {
      case 0:
        return 'Your payment did not go through';
      case 1:
        return 'Your payment is still outstanding';
      case 2:
        return 'Your access is at risk';
      case 3:
        return ctx.tokens.lockoutDate
          ? `Final notice: access pauses on ${ctx.tokens.lockoutDate}`
          : 'Final notice before your access pauses';
      default:
        return 'About your Growth Project payment';
    }
  }

  /** Run a transport: a throw is a failed (retried) delivery, never a tick break. */
  private async run(label: string, fn: () => Promise<ChannelResult>): Promise<ChannelResult> {
    try {
      return await fn();
    } catch (err) {
      // B-688-4 (Sol): a code, never the exception text.
      const code = dunningErrorCode(err);
      this.logger.warn(`dunning v2 ${label} transport failed: ${code}`);
      return { status: 'failed', error: code };
    }
  }
}

function coachResult(status: ChannelStatus, transport: 'inapp' | 'push'): ChannelResult {
  if (status === 'sent') return { status };
  return { status, error: `coach_${transport}_${status === 'failed' ? 'failed' : 'muted'}` };
}
