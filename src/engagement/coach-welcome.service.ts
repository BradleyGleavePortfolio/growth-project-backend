import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import type { CoachWelcomeMessageJob, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { MessagesSafetyService } from '../messages-safety/messages-safety.service';
import { renderWelcomeMessage, WELCOME_DELAY_MS } from './welcome-template';
import { isCoachWelcomeSchedulerEnabled } from './engagement.flags';
import { WelcomeLeaseLostError } from './welcome-lease-fence';

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
// NO DUPLICATES (B-609-3), enforced by the database, not by timing:
//   - Idempotency key at the persistence boundary: the welcome is written with
//     CoachMessage.welcome_job_id = job.id (@unique). However many workers
//     reach sendAsCoach for one job (a stale lease-holder that is still alive,
//     a reclaiming worker, a retry after a post-write failure), exactly one
//     CoachMessage row exists; the losing INSERT trips P2002 and sendAsCoach
//     returns the existing row with no second ping, push, audit or PTM signal.
//   - Fencing: every claim writes a fresh lease_token, and every later write
//     (body stamp, sent, retry, failed, cancelled) is conditional on it. A
//     worker whose lease was reclaimed loses every write and stops
//     ('superseded'); it can neither re-send nor overwrite the new holder.
//   - Reconcile: before sending, the holder looks the job's message up by
//     welcome_job_id; if it exists the job is marked sent with that id.
//   CoachWelcomeMessageJob.message_id is @unique as a final backstop.
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
  /** The lease was reclaimed by another worker; this one stopped without writing. */
  superseded: number;
}

type DeliverOutcome = 'sent' | 'cancelled' | 'retried' | 'failed' | 'superseded';

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
      superseded: 0,
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
      const lease = await this.claim(job, now);
      if (!lease) continue;
      const outcome = await this.deliver(job, lease, now);
      stats[outcome] += 1;
    }
  }

  /**
   * Claim-by-write. Returns the fresh fencing token on success, null when
   * another worker holds (or just took) the job. A stale reclaim matches the
   * exact lease it replaces (status + locked_at + lease_token as read), so two
   * reclaimers can never both win.
   */
  private async claim(job: CoachWelcomeMessageJob, now: Date): Promise<string | null> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const lease = randomUUID();
    const res = await this.prisma.coachWelcomeMessageJob.updateMany({
      where:
        job.status === 'sending'
          ? {
              id: job.id,
              status: 'sending',
              locked_at: { lte: staleBefore },
              lease_token: job.lease_token,
            }
          : { id: job.id, status: 'pending' },
      data: { status: 'sending', locked_at: now, lease_token: lease },
    });
    return res.count === 1 ? lease : null;
  }

  /** Every write after the claim goes through here: fenced on the lease. */
  private async writeFenced(
    job: CoachWelcomeMessageJob,
    lease: string,
    data: Prisma.CoachWelcomeMessageJobUpdateManyMutationInput,
  ): Promise<boolean> {
    const res = await this.prisma.coachWelcomeMessageJob.updateMany({
      where: { id: job.id, status: 'sending', lease_token: lease },
      data,
    });
    return res.count === 1;
  }

  private superseded(job: CoachWelcomeMessageJob): 'superseded' {
    this.logger.warn(`coach-welcome job=${job.id} lease reclaimed by another worker; stopping`);
    return 'superseded';
  }

  private async cancel(
    job: CoachWelcomeMessageJob,
    lease: string,
    reason: WelcomeCancelReason,
  ): Promise<'cancelled' | 'superseded'> {
    const ok = await this.writeFenced(job, lease, {
      status: 'cancelled',
      reason,
      locked_at: null,
      lease_token: null,
      rendered_body: null,
    });
    if (!ok) return this.superseded(job);
    this.logger.log(`coach-welcome job=${job.id} cancelled reason=${reason}`);
    return 'cancelled';
  }

  private async deliver(
    job: CoachWelcomeMessageJob,
    lease: string,
    now: Date,
  ): Promise<DeliverOutcome> {
    // A previous holder may already have written this job's message (it died
    // mid-send, the send threw after the INSERT, or it is still alive and its
    // lease went stale): the welcome_job_id key finds it; never send twice.
    // This runs first: a message that exists is the truth (sent), whatever
    // changed since.
    const already = await this.prisma.coachMessage.findUnique({
      where: { welcome_job_id: job.id },
      select: { id: true },
    });
    if (already) return this.markSent(job, lease, already.id, now);

    // Cancellation checks run at send time, not only at schedule time.
    const client = await this.prisma.user.findUnique({
      where: { id: job.client_id },
      select: { name: true, coach_id: true, deleted_at: true, deletion_scheduled_at: true },
    });
    if (!client || client.deleted_at || client.deletion_scheduled_at) {
      return this.cancel(job, lease, 'client_deleted');
    }
    if (client.coach_id !== job.coach_id) return this.cancel(job, lease, 'detached');
    const setting = await this.prisma.coachWelcomeMessageSetting.findUnique({
      where: { coach_id: job.coach_id },
      select: { enabled: true, template: true },
    });
    if (!setting?.enabled) return this.cancel(job, lease, 'coach_disabled');
    if (now.getTime() - job.fire_at.getTime() > MAX_LATENESS_MS) {
      return this.cancel(job, lease, 'expired');
    }
    if (this.safety && (await this.safety.isEitherSideBlocked(job.coach_id, job.client_id))) {
      return this.cancel(job, lease, 'blocked');
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
      // Fenced: a holder whose lease was reclaimed stops here, before send.
      if (!(await this.writeFenced(job, lease, { rendered_body: body }))) {
        return this.superseded(job);
      }
    }

    try {
      const created = await this.messaging.sendAsCoach(
        job.coach_id,
        job.client_id,
        { body },
        { welcome: { jobId: job.id, lease } },
      );
      return this.markSent(job, lease, created.id, now);
    } catch (err) {
      // B-609-3: the lease was reclaimed (and possibly the job cancelled)
      // before the INSERT could commit. Nothing was persisted or fanned out.
      if (err instanceof WelcomeLeaseLostError) return this.superseded(job);
      if (err instanceof ForbiddenException) return this.cancel(job, lease, 'blocked');
      if (err instanceof NotFoundException) return this.cancel(job, lease, 'detached');
      return this.retryOrFail(job, lease, err, now);
    }
  }

  private async markSent(
    job: CoachWelcomeMessageJob,
    lease: string,
    messageId: string,
    now: Date,
  ): Promise<'sent' | 'superseded'> {
    const ok = await this.writeFenced(job, lease, {
      status: 'sent',
      message_id: messageId,
      sent_at: now,
      attempt_count: { increment: 1 },
      locked_at: null,
      lease_token: null,
      next_retry_at: null,
      reason: null,
      rendered_body: null,
    });
    // Superseded: the new holder reconciles by welcome_job_id and marks it.
    return ok ? 'sent' : this.superseded(job);
  }

  private async retryOrFail(
    job: CoachWelcomeMessageJob,
    lease: string,
    err: unknown,
    now: Date,
  ): Promise<'retried' | 'failed' | 'superseded'> {
    const attempt = job.attempt_count + 1;
    const reason = err instanceof Error ? err.name : 'unknown';
    if (attempt >= MAX_ATTEMPTS) {
      const ok = await this.writeFenced(job, lease, {
        status: 'failed',
        reason,
        attempt_count: { increment: 1 },
        locked_at: null,
        lease_token: null,
        rendered_body: null,
      });
      if (!ok) return this.superseded(job);
      this.logger.error(`coach-welcome job=${job.id} failed permanently (${reason})`);
      return 'failed';
    }
    const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    const ok = await this.writeFenced(job, lease, {
      status: 'pending',
      reason,
      attempt_count: { increment: 1 },
      next_retry_at: new Date(now.getTime() + backoff),
      locked_at: null,
      lease_token: null,
    });
    if (!ok) return this.superseded(job);
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
