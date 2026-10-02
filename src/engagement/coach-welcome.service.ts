import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CoachWelcomeMessageJob } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { MessagesSafetyService } from '../messages-safety/messages-safety.service';
import { renderWelcomeMessage, WELCOME_DELAY_MS } from './welcome-template';
import { isCoachWelcomeSchedulerEnabled } from './engagement.flags';

// C05 item 6 — coach welcome message, 13 minutes after onboarding completes.
//
// MECHANISM (same as DripDispatcherCron / every other @Cron in this repo):
// a one-minute @Cron plus a DB table claimed by conditional UPDATE
// ("claim-by-write"). There is no Redis/Bull queue in this codebase.
//
//   1. schedule(): finds onboarding intakes completed in the last
//      SCHEDULE_LOOKBACK_MS that have no CoachWelcomeMessageJob yet and
//      inserts exactly one row per client. CoachWelcomeMessageJob.client_id is
//      @unique, so a replayed POST /me/onboarding/complete (completed_at is
//      written once), a second replica or a restart can never add a second
//      job. If the coach's flag is off (or the client completed before the
//      flag was turned on) the row is written as status='skipped' so the
//      decision is final and visible.
//   2. dispatch(): claims due 'pending' rows (and 'sending' rows whose claim
//      is stale, i.e. a worker died mid-send), re-checks every cancellation
//      condition at send time, then sends through MessagingService.sendAsCoach
//      — the exact path a coach's own message takes (thread row, realtime
//      ping, message_received push + in-app, audit, analytics, PTM).
//
// DURABILITY: all state is in Postgres. A restart loses nothing: pending rows
// stay pending, a stale 'sending' claim is reclaimed after STALE_CLAIM_MS.
//
// NO DUPLICATES: the rendered body is stamped on the row before the send. A
// reclaimed 'sending' row first looks for a CoachMessage from the coach to the
// client with that exact body created since the dead worker's claim; if one
// exists the job is marked sent with that message id and nothing is re-sent.
// CoachWelcomeMessageJob.message_id is @unique as a final backstop.
//
// CONSENT / AI: the job runs only for intakes with completed_at, and
// OnboardingService.complete() writes completed_at only after the D2 box-1
// consent (waiver + collection/use for coaching) is on file with its exact
// text. The message is the coach's own text (or the generic default) with
// two name placeholders filled in by string replacement: no AI provider is
// called and no client data leaves the platform, so the box-2 AI consent is
// not involved. Any later AI use of the thread goes through the #626 egress
// gate like every other coach message.
//
// DATA MINIMISATION: rendered_body (it carries the client's first name) is
// needed only while a send can still be retried or reconciled. Every
// terminal transition (sent, cancelled, failed) clears it. Account deletion
// tombstones the User row (deleted_at) instead of deleting it, so the FK
// cascades never fire; purgeErased() removes this module's rows for
// tombstoned clients and coaches on every tick, including while the kill
// switch is off. The account-deletion erasure manifest (backend #608) should
// also list these tables so they go inside the finalisation transaction.

const TICK_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Intakes completed longer ago than this are never scheduled. */
const SCHEDULE_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** A welcome that could not go out within this window is cancelled, not sent late. */
const MAX_LATENESS_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type WelcomeCancelReason =
  'client_deleted' | 'detached' | 'blocked' | 'coach_disabled' | 'expired';

export interface WelcomeTickStats {
  scheduled: number;
  skipped: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class CoachWelcomeService {
  private readonly logger = new Logger(CoachWelcomeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    @Optional() private readonly safety?: MessagesSafetyService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'coach-welcome-message' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.running) return;
    this.running = true;
    try {
      // The kill switch stops sends, never erasure: with the job off, the
      // tick still runs the erasure sweep and nothing else.
      if (!isCoachWelcomeSchedulerEnabled()) {
        await this.purgeErasedSafely();
        return;
      }
      const stats = await this.runOnce();
      if (stats.scheduled + stats.sent + stats.cancelled + stats.failed > 0) {
        this.logger.log(
          `coach-welcome tick: scheduled=${stats.scheduled} skipped=${stats.skipped} sent=${stats.sent} cancelled=${stats.cancelled} retried=${stats.retried} failed=${stats.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `coach-welcome tick crashed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }

  async runOnce(now: Date = new Date()): Promise<WelcomeTickStats> {
    const stats: WelcomeTickStats = {
      scheduled: 0,
      skipped: 0,
      sent: 0,
      cancelled: 0,
      retried: 0,
      failed: 0,
    };
    await this.purgeErasedSafely();
    await this.schedule(now, stats);
    await this.dispatch(now, stats);
    return stats;
  }

  /**
   * purgeErased() that never throws: a failed sweep is logged and retried on
   * the next tick, and never blocks scheduling or sending for live clients.
   */
  async purgeErasedSafely(): Promise<number> {
    try {
      const n = await this.purgeErased();
      if (n > 0) this.logger.log(`coach-welcome erasure sweep removed ${n} row(s)`);
      return n;
    } catch (err) {
      this.logger.warn(
        `coach-welcome erasure sweep failed (${err instanceof Error ? err.name : 'unknown'}); retrying next tick`,
      );
      return 0;
    }
  }

  /**
   * Erasure backstop (see header): delete welcome jobs whose client or coach
   * is tombstoned, and the welcome setting (the coach's welcome text) of a
   * tombstoned coach. Returns the number of rows removed.
   */
  async purgeErased(): Promise<number> {
    const erased = { deleted_at: { not: null } };
    const jobs = await this.prisma.coachWelcomeMessageJob.deleteMany({
      where: { OR: [{ client: erased }, { coach: erased }] },
    });
    const settings = await this.prisma.coachWelcomeMessageSetting.deleteMany({
      where: { coach: erased },
    });
    return jobs.count + settings.count;
  }

  // ── 1) schedule ─────────────────────────────────────────────────────────

  async schedule(now: Date, stats: WelcomeTickStats): Promise<void> {
    const since = new Date(now.getTime() - SCHEDULE_LOOKBACK_MS);
    const intakes = await this.prisma.clientOnboardingIntake.findMany({
      where: {
        completed_at: { gte: since, not: null },
        // A tombstoned client is never scheduled (purgeErased removed its
        // job; without this filter it would be re-created every tick).
        // C-609-3: a client with no coach writes no row (scheduleOne returns
        // no_coach), so without the coach filter those intakes would be
        // re-selected every tick for the whole lookback and, oldest first,
        // could fill the batch and starve every newer completion.
        client: { coach_welcome_job: { is: null }, deleted_at: null, coach_id: { not: null } },
      },
      select: { client_id: true, completed_at: true },
      orderBy: { completed_at: 'asc' },
      take: TICK_BATCH_SIZE,
    });
    for (const intake of intakes) {
      if (!intake.completed_at) continue;
      const outcome = await this.scheduleOne(intake.client_id, intake.completed_at);
      if (outcome === 'scheduled') stats.scheduled += 1;
      else if (outcome === 'skipped') stats.skipped += 1;
    }
  }

  /**
   * Insert the single job row for this client. Returns 'exists' when another
   * replica or an earlier tick already did (unique client_id).
   */
  async scheduleOne(
    clientId: string,
    completedAt: Date,
  ): Promise<'scheduled' | 'skipped' | 'exists' | 'no_coach'> {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    if (!client?.coach_id) return 'no_coach';
    const setting = await this.prisma.coachWelcomeMessageSetting.findUnique({
      where: { coach_id: client.coach_id },
      select: { enabled: true, enabled_at: true },
    });
    const enabled =
      !!setting?.enabled &&
      !!setting.enabled_at &&
      completedAt.getTime() >= setting.enabled_at.getTime();
    try {
      await this.prisma.coachWelcomeMessageJob.create({
        data: {
          client_id: clientId,
          coach_id: client.coach_id,
          completed_at: completedAt,
          fire_at: new Date(completedAt.getTime() + WELCOME_DELAY_MS),
          status: enabled ? 'pending' : 'skipped',
          reason: enabled ? null : 'coach_disabled',
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'exists';
      throw err;
    }
    return enabled ? 'scheduled' : 'skipped';
  }

  // ── 2) dispatch ─────────────────────────────────────────────────────────

  async dispatch(now: Date, stats: WelcomeTickStats): Promise<void> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const due = await this.prisma.coachWelcomeMessageJob.findMany({
      where: {
        fire_at: { lte: now },
        attempt_count: { lt: MAX_ATTEMPTS },
        OR: [
          {
            status: 'pending',
            OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
          },
          { status: 'sending', locked_at: { lte: staleBefore } },
        ],
      },
      orderBy: { fire_at: 'asc' },
      take: TICK_BATCH_SIZE,
    });
    for (const job of due) {
      const claimed = await this.claim(job, now);
      if (!claimed) continue;
      const outcome = await this.deliver(job, now);
      stats[outcome] += 1;
    }
  }

  private async claim(job: CoachWelcomeMessageJob, now: Date): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const res = await this.prisma.coachWelcomeMessageJob.updateMany({
      where:
        job.status === 'sending'
          ? { id: job.id, status: 'sending', locked_at: { lte: staleBefore } }
          : { id: job.id, status: 'pending' },
      data: { status: 'sending', locked_at: now },
    });
    return res.count === 1;
  }

  private async cancel(
    job: CoachWelcomeMessageJob,
    reason: WelcomeCancelReason,
  ): Promise<'cancelled'> {
    await this.prisma.coachWelcomeMessageJob.updateMany({
      where: { id: job.id, status: 'sending' },
      data: { status: 'cancelled', reason, locked_at: null, rendered_body: null },
    });
    this.logger.log(`coach-welcome job=${job.id} cancelled reason=${reason}`);
    return 'cancelled';
  }

  private async deliver(
    job: CoachWelcomeMessageJob,
    now: Date,
  ): Promise<'sent' | 'cancelled' | 'retried' | 'failed'> {
    // Cancellation checks run at send time, not only at schedule time.
    const client = await this.prisma.user.findUnique({
      where: { id: job.client_id },
      select: { name: true, coach_id: true, deleted_at: true, deletion_scheduled_at: true },
    });
    if (!client || client.deleted_at || client.deletion_scheduled_at) {
      return this.cancel(job, 'client_deleted');
    }
    if (client.coach_id !== job.coach_id) return this.cancel(job, 'detached');
    const setting = await this.prisma.coachWelcomeMessageSetting.findUnique({
      where: { coach_id: job.coach_id },
      select: { enabled: true, template: true },
    });
    if (!setting?.enabled) return this.cancel(job, 'coach_disabled');
    if (now.getTime() - job.fire_at.getTime() > MAX_LATENESS_MS) {
      return this.cancel(job, 'expired');
    }
    if (this.safety && (await this.safety.isEitherSideBlocked(job.coach_id, job.client_id))) {
      return this.cancel(job, 'blocked');
    }

    // A previous attempt stamped the body (worker died mid-send, or the send
    // threw after the row was written): never send twice.
    if (job.rendered_body) {
      const already = await this.prisma.coachMessage.findFirst({
        where: {
          coach_id: job.coach_id,
          client_id: job.client_id,
          sender_id: job.coach_id,
          body: job.rendered_body,
          created_at: { gte: job.created_at },
        },
        select: { id: true },
      });
      if (already) return this.markSent(job, already.id, now);
    }

    let body = job.rendered_body;
    if (!body) {
      const coach = await this.prisma.user.findUnique({
        where: { id: job.coach_id },
        select: { name: true },
      });
      body = renderWelcomeMessage(setting.template, {
        clientName: client.name,
        coachName: coach?.name ?? null,
      });
      await this.prisma.coachWelcomeMessageJob.updateMany({
        where: { id: job.id, status: 'sending' },
        data: { rendered_body: body },
      });
    }

    try {
      const created = await this.messaging.sendAsCoach(job.coach_id, job.client_id, { body });
      return this.markSent(job, created.id, now);
    } catch (err) {
      if (err instanceof ForbiddenException) return this.cancel(job, 'blocked');
      if (err instanceof NotFoundException) return this.cancel(job, 'detached');
      return this.retryOrFail(job, err, now);
    }
  }

  private async markSent(
    job: CoachWelcomeMessageJob,
    messageId: string,
    now: Date,
  ): Promise<'sent'> {
    await this.prisma.coachWelcomeMessageJob.updateMany({
      where: { id: job.id, status: 'sending' },
      data: {
        status: 'sent',
        message_id: messageId,
        sent_at: now,
        attempt_count: { increment: 1 },
        locked_at: null,
        next_retry_at: null,
        reason: null,
        rendered_body: null,
      },
    });
    return 'sent';
  }

  private async retryOrFail(
    job: CoachWelcomeMessageJob,
    err: unknown,
    now: Date,
  ): Promise<'retried' | 'failed'> {
    const attempt = job.attempt_count + 1;
    const reason = err instanceof Error ? err.name : 'unknown';
    if (attempt >= MAX_ATTEMPTS) {
      await this.prisma.coachWelcomeMessageJob.updateMany({
        where: { id: job.id, status: 'sending' },
        data: {
          status: 'failed',
          reason,
          attempt_count: { increment: 1 },
          locked_at: null,
          rendered_body: null,
        },
      });
      this.logger.error(`coach-welcome job=${job.id} failed permanently (${reason})`);
      return 'failed';
    }
    const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    await this.prisma.coachWelcomeMessageJob.updateMany({
      where: { id: job.id, status: 'sending' },
      data: {
        status: 'pending',
        reason,
        attempt_count: { increment: 1 },
        next_retry_at: new Date(now.getTime() + backoff),
        locked_at: null,
      },
    });
    this.logger.warn(`coach-welcome job=${job.id} attempt ${attempt} failed (${reason}); retrying`);
    return 'retried';
  }
}

export const __coachWelcomeConsts = {
  TICK_BATCH_SIZE,
  MAX_ATTEMPTS,
  STALE_CLAIM_MS,
  SCHEDULE_LOOKBACK_MS,
  MAX_LATENESS_MS,
};
