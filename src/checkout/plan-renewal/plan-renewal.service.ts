import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PlanRenewal } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import { dunningErrorCode } from '../dunning-v2/dunning-v2.safe-error';
import {
  isPlanRenewalEnabled,
  PLAN_RENEWAL_OPEN_WINDOW_MS,
  PLAN_RENEWAL_POPUP_DAYS,
  PLAN_RENEWAL_PUSH_DAY,
  PLAN_RENEWAL_SWEEP_CRON,
  planRenewalDay,
} from './plan-renewal.cadence';
import {
  latestPlanEnd,
  loadPlanRenewal,
  planEndedAt,
  planRenewalBlock,
  planRenewalHouseCoach,
  PlanRenewalView,
} from './plan-renewal.state';

const BATCH = 500;

const refusal = (code: string, message: string) => ({ code, error: code, message });

/**
 * RENEWAL-BE: the plan-renewal sequence (cadence: plan-renewal.cadence.ts).
 *
 * The Day 0 and Day 1 pop-ups are read, not sent: GET /v1/checkout/entitlement
 * works them out from the client's local day and their acknowledgements. The
 * one app notification (Day 7) is sent exactly once, by the database: the
 * claim is a CAS on status (active -> done) and the push is enqueued inside
 * that transaction with the dedupe key plan_renewal:<id> (the outbox's unique
 * key). planRenewalBlock is re-checked right before it goes out (the push
 * worker through planRenewalPushStillDue).
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

  /** Open sequences for plans that just ended; stop blocked ones; send the Day 7 app notification. */
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
      where: {
        plan_renewal: { is: null },
        OR: [
          { billing_type: 'one_time', status: { in: ['paid', 'active'] }, entitlement_active: true, access_expires_at: { gt: since, lte: now } },
          {
            billing_type: 'recurring',
            status: 'canceled',
            OR: [{ cancel_at_period_end: true, current_period_end: { gt: since, lte: now } }, { canceled_at: { gt: since } }],
          },
        ],
      },
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

  /** Stop the sequence, or from the client's local Day 7 claim it and enqueue the one app notification in the same transaction. */
  private async advance(row: PlanRenewal, now: Date): Promise<'idle' | 'pushed' | 'stopped'> {
    const block = await planRenewalBlock(this.prisma, row.client_user_id, row.coach_user_id, now);
    if (block) {
      await this.prisma.planRenewal.updateMany({
        where: { id: row.id, status: 'active' },
        data: { status: 'stopped', stop_reason: block },
      });
      return 'stopped';
    }
    const day = planRenewalDay(row.ended_at, now, await resolveRecipientTimeZone(this.prisma, row.client_user_id));
    if (day < PLAN_RENEWAL_PUSH_DAY) return 'idle';
    const house = await planRenewalHouseCoach(this.prisma, row.coach_user_id);
    return this.prisma.$transaction(async (tx): Promise<'idle' | 'pushed'> => {
      const won = await tx.planRenewal.updateMany({ where: { id: row.id, status: 'active' }, data: { status: 'done' } });
      // A Day 7 the sweep never saw (flag off, server down) is skipped, never sent late.
      if (won.count !== 1 || day > PLAN_RENEWAL_PUSH_DAY) return 'idle';
      await this.notifications.sendPush(
        {
          user_id: row.client_user_id,
          kind: NotificationKind.PLAN_RENEWAL,
          body: 'Your plan has ended.',
          deep_link: 'tgp://home',
          dedupe_key: `plan_renewal:${row.id}`,
          // The two buttons (contract on b#1127): the phone registers both categories with the labels.
          data: {
            categoryId: house ? 'PLAN_RENEWAL' : 'PLAN_RENEWAL_COACH',
            coach_id: row.coach_user_id,
            ...(house ? { house_coach_id: house.id } : {}),
          },
        },
        tx,
      );
      return 'pushed';
    });
  }

  /** POST /v1/checkout/renewal/popup-ack: the client saw the pop-up for local `day` (0 or 1). */
  async ackPopup(userId: string, day: number, now = new Date()): Promise<{ renewal: PlanRenewalView }> {
    if (!PLAN_RENEWAL_POPUP_DAYS.includes(day)) {
      throw new BadRequestException(refusal('PLAN_RENEWAL_STEP_INVALID', 'The pop-up step must be 0 or 1.'));
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
