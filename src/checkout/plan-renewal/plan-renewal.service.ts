import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { ClientPurchase, PlanRenewal, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { MessagingService } from '../../messaging/messaging.service';
import { renderWelcomeMessage } from '../../engagement/welcome-template';
import { dunningErrorCode } from '../dunning-v2/dunning-v2.safe-error';
import {
  isPlanRenewalEnabled,
  PLAN_RENEWAL_LAST_STEP,
  PLAN_RENEWAL_MESSAGE_BACKOFF_MS,
  PLAN_RENEWAL_MESSAGES,
  PLAN_RENEWAL_MIN_STEP_GAP_MS,
  PLAN_RENEWAL_OPEN_WINDOW_MS,
  PLAN_RENEWAL_STEPS,
  PLAN_RENEWAL_SWEEP_CRON,
  planRenewalStepFor,
} from './plan-renewal.cadence';
import { loadPlanRenewal, planRenewalBlock, PlanRenewalView } from './plan-renewal.state';

const BATCH = 500;
/** A claimed coach message is retried after this if its worker died mid-send. */
const MESSAGE_LEASE_MS = 5 * 60_000;

type Ended = Pick<ClientPurchase, 'id' | 'client_user_id' | 'coach_user_id' | 'billing_type' | 'access_expires_at' | 'canceled_at' | 'current_period_end'>;

/** When the plan ended: a package's last day, or a subscription's end (period end, or the cancel itself). */
export function planEndedAt(p: Ended, now: Date): Date | null {
  if (p.billing_type !== 'recurring') return p.access_expires_at;
  const periodEnd = p.current_period_end && p.current_period_end <= now ? p.current_period_end : null;
  if (!p.canceled_at) return periodEnd;
  return periodEnd && periodEnd > p.canceled_at ? periodEnd : p.canceled_at;
}

const refusal = (code: string, message: string) => ({ code, error: code, message });

/**
 * RENEWAL-BE: the plan-renewal sequence (cadence: plan-renewal.cadence.ts).
 *
 * Exactly once per step and channel, by the database: the step claim is a CAS
 * on step_index; the push is enqueued inside the claim's transaction with the
 * dedupe key plan_renewal:<id>:<step> (the outbox's unique key); the coach
 * message carries the claim's message_key as CoachMessage.client_message_id
 * (unique per sender), so a retry or a second machine replays the one row.
 * Every channel re-checks planRenewalBlock right before it goes out (the
 * push worker through planRenewalPushStillDue).
 */
@Injectable()
export class PlanRenewalService {
  private readonly logger = new Logger(PlanRenewalService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  @Cron(PLAN_RENEWAL_SWEEP_CRON, { name: 'plan-renewal-sweep', timeZone: 'UTC' })
  async handleCron(): Promise<void> {
    if (!isPlanRenewalEnabled() || this.running) return;
    this.running = true;
    try {
      this.logger.log(JSON.stringify({ event: 'plan_renewal.sweep_completed', ...(await this.runSweep()) }));
    } catch (err: unknown) {
      this.logger.error(`plan renewal sweep failed: ${dunningErrorCode(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Open sequences for plans that just ended, claim due steps, send owed coach messages. */
  async runSweep(now = new Date()) {
    const out = { opened: 0, claimed: 0, stopped: 0, messages: 0 };
    if (!isPlanRenewalEnabled()) return out;
    out.opened = await this.openEnded(now);
    const active = await this.prisma.planRenewal.findMany({ where: { status: 'active' }, take: BATCH });
    for (const row of active) {
      const result = await this.advance(row, now);
      if (result !== 'idle') out[result] += 1;
    }
    const owed = await this.prisma.planRenewal.findMany({
      where: { message_status: 'pending', message_next_at: { lte: now } },
      take: BATCH,
    });
    for (const row of owed) if ((await this.sendMessage(row, now)) === 'sent') out.messages += 1;
    return out;
  }

  private async openEnded(now: Date): Promise<number> {
    const since = new Date(now.getTime() - PLAN_RENEWAL_OPEN_WINDOW_MS);
    const ended = await this.prisma.clientPurchase.findMany({
      where: {
        plan_renewal: { is: null },
        OR: [
          { billing_type: 'one_time', status: { in: ['paid', 'active'] }, entitlement_active: true, access_expires_at: { gt: since, lte: now } },
          { billing_type: 'recurring', status: 'canceled', OR: [{ canceled_at: { gt: since } }, { current_period_end: { gt: since } }] },
        ],
      },
      select: { id: true, client_user_id: true, coach_user_id: true, billing_type: true, access_expires_at: true, canceled_at: true, current_period_end: true },
      take: BATCH,
    });
    let opened = 0;
    for (const p of ended) {
      const endedAt = planEndedAt(p, now);
      if (!endedAt || endedAt <= since || endedAt > now) continue;
      const pair = { client_user_id: p.client_user_id, coach_user_id: p.coach_user_id };
      if (await this.prisma.planRenewal.count({ where: { ...pair, status: 'active' } })) continue;
      if (await planRenewalBlock(this.prisma, p.client_user_id, p.coach_user_id, now)) continue;
      const made = await this.prisma.planRenewal.createMany({
        data: [{ purchase_id: p.id, ...pair, ended_at: endedAt }],
        skipDuplicates: true,
      });
      opened += made.count;
    }
    return opened;
  }

  /** Stop, wait, or claim the latest due step (one per 24 hours) and enqueue its push in the same transaction. */
  private async advance(row: PlanRenewal, now: Date): Promise<'idle' | 'claimed' | 'stopped'> {
    const block = await planRenewalBlock(this.prisma, row.client_user_id, row.coach_user_id, now);
    if (block) {
      await this.prisma.planRenewal.updateMany({
        where: { id: row.id, status: 'active' },
        data: { status: 'stopped', stop_reason: block },
      });
      return 'stopped';
    }
    const due = planRenewalStepFor(now.getTime() - row.ended_at.getTime());
    if (due <= row.step_index) return 'idle';
    if (row.step_claimed_at && now.getTime() - row.step_claimed_at.getTime() < PLAN_RENEWAL_MIN_STEP_GAP_MS) return 'idle';
    const step = PLAN_RENEWAL_STEPS[due];
    return this.prisma.$transaction(async (tx): Promise<'idle' | 'claimed'> => {
      const won = await tx.planRenewal.updateMany({
        where: { id: row.id, status: 'active', step_index: row.step_index },
        data: {
          step_index: due,
          step_claimed_at: now,
          ...(due === PLAN_RENEWAL_LAST_STEP ? { status: 'done' } : {}),
          ...(step.popup ? { popup_step: due } : {}),
          ...(step.message
            ? { message_step: due, message_key: randomUUID(), message_status: 'pending', message_attempts: 0, message_next_at: now, message_id: null }
            : {}),
        },
      });
      if (won.count !== 1) return 'idle';
      if (step.push) {
        await this.notifications.sendPush(
          {
            user_id: row.client_user_id,
            kind: NotificationKind.PLAN_RENEWAL,
            body: 'Your plan has ended.',
            deep_link: 'tgp://home',
            dedupe_key: `plan_renewal:${row.id}:${due}`,
          },
          tx,
        );
      }
      return 'claimed';
    });
  }

  /** Send the owed coach message once (lease + fenced writes; the message key makes a replay a no-op). */
  private async sendMessage(row: PlanRenewal, now: Date): Promise<'sent' | 'skipped' | 'retry' | 'lost'> {
    if (!row.message_key || row.message_step == null) return 'lost';
    const held = { id: row.id, message_status: 'pending', message_key: row.message_key };
    const claim = await this.prisma.planRenewal.updateMany({
      where: { ...held, message_attempts: row.message_attempts, message_next_at: { lte: now } },
      data: { message_attempts: row.message_attempts + 1, message_next_at: new Date(now.getTime() + MESSAGE_LEASE_MS) },
    });
    if (claim.count !== 1) return 'lost';
    // Fenced: a worker whose lease was taken over loses every later write.
    const settle = (data: Prisma.PlanRenewalUpdateManyMutationInput) =>
      this.prisma.planRenewal.updateMany({ where: { ...held, message_attempts: row.message_attempts + 1 }, data });
    const setting = await this.prisma.coachWelcomeMessageSetting.findUnique({
      where: { coach_id: row.coach_user_id },
      select: { renewal_messages_enabled: true },
    });
    const off = setting?.renewal_messages_enabled === false;
    if (row.status === 'stopped' || off || (await planRenewalBlock(this.prisma, row.client_user_id, row.coach_user_id, now))) {
      await settle({ message_status: 'skipped', message_next_at: null });
      return 'skipped';
    }
    try {
      const client = await this.prisma.user.findUnique({ where: { id: row.client_user_id }, select: { name: true } });
      const body = renderWelcomeMessage(PLAN_RENEWAL_MESSAGES[row.message_step], { clientName: client?.name, coachName: null });
      const sent = await this.messaging.sendAsCoach(row.coach_user_id, row.client_user_id, { body, client_message_id: row.message_key });
      await settle({ message_status: 'sent', message_id: sent.id, message_next_at: null });
      return 'sent';
    } catch (err: unknown) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) {
        await settle({ message_status: 'skipped', message_next_at: null });
        return 'skipped';
      }
      const wait = PLAN_RENEWAL_MESSAGE_BACKOFF_MS[row.message_attempts];
      await settle(wait ? { message_next_at: new Date(now.getTime() + wait) } : { message_status: 'dead', message_next_at: null });
      this.logger.warn(`plan renewal message ${row.id} attempt ${row.message_attempts + 1} failed: ${dunningErrorCode(err)}`);
      return 'retry';
    }
  }

  /** POST /v1/checkout/renewal/popup-ack: the client saw the pop-up for `day` (0, 3 or 7). */
  async ackPopup(userId: string, day: number): Promise<{ renewal: PlanRenewalView }> {
    const idx = PLAN_RENEWAL_STEPS.findIndex((s) => s.popup && s.day === day);
    if (idx < 0) {
      throw new BadRequestException(refusal('PLAN_RENEWAL_STEP_INVALID', 'The pop-up step must be 0, 3 or 7.'));
    }
    const { row } = await loadPlanRenewal(this.prisma, userId);
    if (!row) throw new NotFoundException(refusal('PLAN_RENEWAL_NOT_FOUND', 'There is no plan renewal running for this account.'));
    if (idx > row.popup_step) {
      throw new ConflictException(refusal('PLAN_RENEWAL_STEP_NOT_REACHED', 'That pop-up is not due yet.'));
    }
    await this.prisma.planRenewal.updateMany({
      where: { id: row.id, popup_acked_step: { lt: idx } },
      data: { popup_acked_step: idx },
    });
    return { renewal: (await loadPlanRenewal(this.prisma, userId)).view };
  }

  /** The coach's renewal-message switch (default on; stored beside the welcome setting). */
  async coachSettings(coachId: string): Promise<{ messages_enabled: boolean }> {
    const row = await this.prisma.coachWelcomeMessageSetting.findUnique({
      where: { coach_id: coachId },
      select: { renewal_messages_enabled: true },
    });
    return { messages_enabled: row?.renewal_messages_enabled ?? true };
  }

  async setCoachSettings(coachId: string, enabled: boolean): Promise<{ messages_enabled: boolean }> {
    const row = await this.prisma.coachWelcomeMessageSetting.upsert({
      where: { coach_id: coachId },
      create: { coach_id: coachId, renewal_messages_enabled: enabled },
      update: { renewal_messages_enabled: enabled },
      select: { renewal_messages_enabled: true },
    });
    return { messages_enabled: row.renewal_messages_enabled };
  }
}
