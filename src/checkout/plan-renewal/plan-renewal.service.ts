import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PlanRenewal } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { quietHoursFor } from '../../notifications/push/push-quiet-hours';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import { dunningErrorCode } from '../dunning-v2/dunning-v2.safe-error';
import {
  isPlanRenewalEnabled,
  PLAN_RENEWAL_OPEN_WINDOW_MS,
  PLAN_RENEWAL_LAST_DAY,
  PLAN_RENEWAL_STEP_DAYS,
  PLAN_RENEWAL_SWEEP_CRON,
  planRenewalDay,
} from './plan-renewal.cadence';
import {
  endedPlanWhere,
  latestPlanEnd,
  loadPlanRenewal,
  planEndedAt,
  planRenewalBlock,
  PlanRenewalView,
} from './plan-renewal.state';

const BATCH = 500;

const refusal = (code: string, message: string) => ({ code, error: code, message });

/**
 * RENEWAL-BE: the plan-renewal sequence (cadence: plan-renewal.cadence.ts).
 *
 * The pop-ups (and Home's banner) are read, not sent: GET /v1/checkout/entitlement
 * works them out from the client's local day and their acknowledgements. Each
 * step's app notification (Day 0, 1, 7) goes out at most once, by the
 * database: the claim is a CAS on pushed_step (and status active -> done on
 * Day 7) and the push is enqueued inside that transaction with the dedupe key
 * plan_renewal:<id>:<day> (the outbox's unique key). A step whose notification
 * could only land on a later local day (quiet hours) is claimed and skipped,
 * so two steps never arrive together. planRenewalBlock is re-checked right
 * before it goes out (the push worker through planRenewalPushStillDue).
 */
@Injectable()
export class PlanRenewalService {
  private readonly logger = new Logger(PlanRenewalService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
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

  /** Open sequences for plans that just ended; stop blocked ones; send each step's app notification. */
  async runSweep(now = new Date()) {
    const out = { opened: 0, pushed: 0, stopped: 0 };
    if (!isPlanRenewalEnabled()) return out;
    out.opened = await this.openEnded(now);
    const active = await this.prisma.planRenewal.findMany({ where: { status: 'active' }, orderBy: { ended_at: 'asc' }, take: BATCH });
    for (const row of active) {
      const result = await this.advance(row, now);
      if (result !== 'idle') out[result] += 1;
    }
    return out;
  }

  /**
   * One sequence per plan end, for the client's LATEST plan with the coach
   * only (LS B1): a purchase another plan with the coach outlasted never
   * opens, and opening a newer one stops any older sequence still running.
   */
  private async openEnded(now: Date): Promise<number> {
    const since = new Date(now.getTime() - PLAN_RENEWAL_OPEN_WINDOW_MS);
    const ended = await this.prisma.clientPurchase.findMany({
      where: { plan_renewal: { is: null }, ...endedPlanWhere(since, now) },
      select: {
        id: true, client_user_id: true, coach_user_id: true, billing_type: true, access_expires_at: true,
        canceled_at: true, current_period_end: true, cancel_at_period_end: true,
      },
      orderBy: { created_at: 'desc' },
      take: BATCH,
    });
    let opened = 0;
    for (const p of ended) {
      const endedAt = planEndedAt(p);
      if (!endedAt || endedAt <= since || endedAt > now) continue;
      const pair = { client_user_id: p.client_user_id, coach_user_id: p.coach_user_id };
      if (await planRenewalBlock(this.prisma, p.client_user_id, p.coach_user_id, now)) continue;
      const latest = await latestPlanEnd(this.prisma, p.client_user_id, p.coach_user_id);
      if (latest && latest > endedAt) continue;
      if (await this.prisma.planRenewal.count({ where: { ...pair, ended_at: { gte: endedAt } } })) continue;
      const [, made] = await this.prisma.$transaction([
        this.prisma.planRenewal.updateMany({ where: { ...pair, status: 'active' }, data: { status: 'stopped', stop_reason: 'superseded' } }),
        this.prisma.planRenewal.createMany({ data: [{ purchase_id: p.id, ...pair, ended_at: endedAt }], skipDuplicates: true }),
      ]);
      opened += made.count;
    }
    return opened;
  }

  /** Stop the sequence, or claim today's step and enqueue its app notification in the same transaction. */
  private async advance(row: PlanRenewal, now: Date): Promise<'idle' | 'pushed' | 'stopped'> {
    const block = await planRenewalBlock(this.prisma, row.client_user_id, row.coach_user_id, now);
    if (block) {
      await this.prisma.planRenewal.updateMany({
        where: { id: row.id, status: 'active' },
        data: { status: 'stopped', stop_reason: block },
      });
      return 'stopped';
    }
    const tz = await resolveRecipientTimeZone(this.prisma, row.client_user_id);
    const day = planRenewalDay(row.ended_at, now, tz);
    const step = PLAN_RENEWAL_STEP_DAYS.filter((d) => d <= day).pop();
    if (step === undefined || step <= row.pushed_step) return 'idle';
    // A step the sweep never saw on its day (flag off, server down), or whose notification quiet hours would hold
    // past its day, is skipped, never sent late or together with the next one.
    const deliverAt = quietHoursFor({ kind: NotificationKind.PLAN_RENEWAL, timeZone: tz, now }).deliverAt;
    const send = day === step && planRenewalDay(row.ended_at, deliverAt, tz) === step;
    const last = step === PLAN_RENEWAL_LAST_DAY;
    return this.prisma.$transaction(async (tx): Promise<'idle' | 'pushed'> => {
      const won = await tx.planRenewal.updateMany({
        where: { id: row.id, status: 'active', pushed_step: { lt: step } },
        data: { pushed_step: step, ...(last ? { status: 'done' } : {}) },
      });
      if (won.count !== 1 || !send) return 'idle';
      await this.notifications.sendPush(
        {
          user_id: row.client_user_id,
          kind: NotificationKind.PLAN_RENEWAL,
          body: 'Your plan has ended.',
          deep_link: 'tgp://home',
          // No buttons (OPERATOR RULING v3 6328335815): the tap opens Home and its renewal pop-up.
          dedupe_key: `plan_renewal:${row.id}:${step}`,
        },
        tx,
      );
      return 'pushed';
    });
  }

  /** POST /v1/checkout/renewal/popup-ack: the client saw the pop-up for local `day` (0, 1 or 7). */
  async ackPopup(userId: string, day: number, now = new Date()): Promise<{ renewal: PlanRenewalView }> {
    if (!PLAN_RENEWAL_STEP_DAYS.includes(day)) {
      throw new BadRequestException(refusal('PLAN_RENEWAL_STEP_INVALID', 'The pop-up step must be 0, 1 or 7.'));
    }
    const current = await loadPlanRenewal(this.prisma, userId, undefined, now);
    if (!current.row) throw new NotFoundException(refusal('PLAN_RENEWAL_NOT_FOUND', 'There is no plan renewal running for this account.'));
    if (day > current.day) {
      throw new ConflictException(refusal('PLAN_RENEWAL_STEP_NOT_REACHED', 'That pop-up is not due yet.'));
    }
    await this.prisma.planRenewal.updateMany({
      where: { id: current.row.id, popup_acked_step: { lt: day } },
      data: { popup_acked_step: day },
    });
    return { renewal: (await loadPlanRenewal(this.prisma, userId, undefined, now)).view };
  }
}
