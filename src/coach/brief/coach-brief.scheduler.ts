// src/coach/brief/coach-brief.scheduler.ts
//
// Daily push dispatch for the Coach Brief. Runs every UTC minute; for
// each coach with preferences.enabled = true, fires a push if the
// current wall-clock minute in the coach's timezone equals their
// notification_time. The per-coach work runs through Promise.allSettled
// so one coach's failure cannot block the rest of the dispatch.
//
// Race-safety on multi-instance deploys:
//   * Brief generation is gated by an atomic status='generating' claim in
//     CoachBriefService.generateBrief with a stale-lease reclaim path.
//   * Push dispatch is gated by the server-only CoachBriefPushLedger
//     table (no coach RLS write policy). Each per-coach attempt takes a
//     short-lived lease (push_attempt_lease_until=now+90s) BEFORE
//     calling pushToUser; concurrent cron instances see the lease and
//     back off. Only the instance whose pushToUser returns
//     delivered=true writes last_push_date=briefDate. The day's retry
//     budget is capped at MAX_PUSH_ATTEMPTS so an Expo outage cannot
//     drive unbounded retries; the budget resets when
//     last_push_attempt_date rolls over.
//
// External call safety:
//   * notifications.pushToUser is wrapped in Promise.race against a
//     10s timeout AND an AbortController is fed into the SDK so a
//     stalled Expo client is cancelled rather than wedging the
//     scheduler. pushToUser returns a typed PushDeliveryResult; the
//     scheduler ONLY writes last_push_date when delivered=true so a
//     swallowed transport error cannot fabricate a delivery record.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { CoachBriefService, bucketDateLocal } from './coach-brief.service';
import { coachBriefEnabled } from './coach-brief-enabled.guard';

const CRON_JOB_NAME = 'coach-brief-dispatch';
const TTL_CRON_JOB_NAME = 'coach-brief-ttl-prune';
const DEFAULT_CRON = '* * * * *';
// 03:15 UTC — off-peak, well after the 05:00 push generation window.
const TTL_PRUNE_CRON = '15 3 * * *';
const PUSH_TIMEOUT_MS = 10_000;

// P1-4 fix round 5: bounded retry budget. A coach receives at most
// MAX_PUSH_ATTEMPTS push attempts per brief_date; after that the
// scheduler stops retrying so a long Expo outage cannot drive
// unbounded calls. The budget resets when last_push_attempt_date
// rolls to a new day.
const MAX_PUSH_ATTEMPTS = 5;

// P1-4 fix round 5: the lease that prevents two cron instances from
// calling pushToUser at the same minute. Slightly longer than
// PUSH_TIMEOUT_MS so we always observe the abort outcome before the
// next minute's cron can claim. Stale leases (now > lease_until) are
// reclaimable so a crashed worker cannot wedge the day's push.
const PUSH_ATTEMPT_LEASE_MS = 90_000;

// R44: typed internal error for the push-timeout reject path. Carrying a
// `code` lets observability distinguish "Expo round-trip slow" from a
// real downstream Expo failure without parsing message text.
class CoachBriefPushTimeoutError extends Error {
  readonly code = 'COACH_BRIEF_PUSH_TIMEOUT' as const;
  constructor(message = 'push timeout') {
    super(message);
    this.name = 'CoachBriefPushTimeoutError';
  }
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

@Injectable()
export class CoachBriefScheduler implements OnModuleInit {
  private readonly logger = new Logger(CoachBriefScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly briefService: CoachBriefService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    // SchedulerRegistry is optional so unit tests that construct the
    // scheduler directly (without a Nest test module) don't need to
    // stub it. onModuleInit only runs under a real Nest bootstrap.
    private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  // Register the cron at bootstrap so the schedule expression can come
  // from ConfigService (validated env) rather than a raw process.env
  // read at decorator-evaluation time.
  onModuleInit(): void {
    if (!this.schedulerRegistry) return;
    const cronExpr =
      this.config.get<string>('COACH_BRIEF_CRON')?.trim() || DEFAULT_CRON;

    let job: CronJob;
    try {
      job = new CronJob(
        cronExpr,
        () => {
          this.dispatchDailyBriefs().catch((err) => {
            this.logger.error(
              `coach brief dispatch tick failed: ${errorMessageOf(err)}`,
            );
          });
        },
        null,
        false,
        'UTC',
      );
    } catch (err) {
      this.logger.error(
        `invalid COACH_BRIEF_CRON="${cronExpr}" — refusing to register: ${errorMessageOf(err)}`,
      );
      return;
    }

    // Replace any prior registration (hot-reload safe).
    try {
      this.schedulerRegistry.deleteCronJob(CRON_JOB_NAME);
    } catch {
      /* no prior job registered — fine */
    }
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job as never);
    job.start();

    // BL-GDPR-BRIEF-2 — daily TTL prune at 03:15 UTC. Deletes CoachBrief
    // rows older than COACH_BRIEF_RETENTION_DAYS (default 7) so embedded
    // client PII in brief_context JSON ages out within the retention window.
    // Honors COACH_BRIEF_ENABLED kill switch identical to dispatchDailyBriefs.
    let ttlJob: CronJob;
    try {
      ttlJob = new CronJob(
        TTL_PRUNE_CRON,
        () => {
          this.runTtlPrune().catch((err) => {
            this.logger.error(
              `coach brief TTL prune tick failed: ${errorMessageOf(err)}`,
            );
          });
        },
        null,
        false,
        'UTC',
      );
    } catch (err) {
      this.logger.error(
        `failed to register coach-brief TTL prune cron: ${errorMessageOf(err)}`,
      );
      return;
    }

    try {
      this.schedulerRegistry.deleteCronJob(TTL_CRON_JOB_NAME);
    } catch {
      /* no prior job registered — fine */
    }
    this.schedulerRegistry.addCronJob(TTL_CRON_JOB_NAME, ttlJob as never);
    ttlJob.start();
  }

  async runTtlPrune(): Promise<void> {
    if (!coachBriefEnabled(this.config)) {
      this.logger.debug(
        'coach brief TTL prune skipped — COACH_BRIEF_ENABLED=off',
      );
      return;
    }
    const retentionDays =
      parseInt(
        this.config.get<string>('COACH_BRIEF_RETENTION_DAYS') ?? '7',
        10,
      ) || 7;
    await this.briefService.pruneStaleBriefs(retentionDays);
  }

  async dispatchDailyBriefs(): Promise<void> {
    // P1-2 — master kill switch. When COACH_BRIEF_ENABLED=off the cron is
    // a no-op; this short-circuits BEFORE we read the prefs table so an
    // operator who disables the feature does not generate scheduler load.
    if (!coachBriefEnabled(this.config)) {
      this.logger.debug(
        'coach brief scheduler skipped — COACH_BRIEF_ENABLED=off',
      );
      return;
    }

    const enabled =
      this.config.get<string>('COACH_BRIEF_NOTIFICATIONS_ENABLED') !== 'off';
    if (!enabled) {
      this.logger.debug(
        'coach brief notifications skipped — COACH_BRIEF_NOTIFICATIONS_ENABLED=off',
      );
      return;
    }

    const now = new Date();
    const allPrefs = await this.prisma.coachBriefPreferences.findMany({
      where: { enabled: true },
      include: {
        coach: { select: { id: true, name: true, expo_push_token: true } },
      },
    });

    await Promise.allSettled(
      allPrefs.map((prefs) => this.maybeDispatch(prefs, now)),
    );
  }

  async maybeDispatch(
    prefs: {
      coach_id: string;
      notification_time: string;
      timezone: string;
      coach: {
        id: string;
        name: string;
        expo_push_token: string | null;
      };
    },
    now: Date,
  ): Promise<void> {
    try {
      const [prefHour, prefMinute] = prefs.notification_time
        .split(':')
        .map((s) => parseInt(s, 10));
      if (Number.isNaN(prefHour) || Number.isNaN(prefMinute)) return;

      // Invalid IANA tz on this row — new writes are blocked by
      // IsValidTimezone, but legacy/manual rows could still trip this.
      // Fall back to UTC and continue dispatch rather than skipping
      // the coach entirely.
      let effectiveTimezone = prefs.timezone;
      let localParts: Intl.DateTimeFormatPart[];
      try {
        localParts = new Intl.DateTimeFormat('en-US', {
          timeZone: effectiveTimezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(now);
      } catch {
        this.logger.warn(
          `Invalid timezone '${prefs.timezone}' for coach ${prefs.coach_id} — falling back to UTC`,
        );
        effectiveTimezone = 'UTC';
        localParts = new Intl.DateTimeFormat('en-US', {
          timeZone: effectiveTimezone,
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        }).formatToParts(now);
      }

      const hourStr = localParts.find((p) => p.type === 'hour')?.value ?? '0';
      const minuteStr =
        localParts.find((p) => p.type === 'minute')?.value ?? '0';
      let localHour = parseInt(hourStr, 10);
      const localMinute = parseInt(minuteStr, 10);
      // Intl can emit '24' for midnight on some platforms; normalise.
      if (localHour === 24) localHour = 0;

      if (localHour !== prefHour || localMinute !== prefMinute) return;

      // No expo token — generation still happens via getOrGenerateTodaysBrief
      // when the coach opens the app, so skip the push silently.
      if (!prefs.coach.expo_push_token) return;

      const briefDate = bucketDateLocal(now, effectiveTimezone);

      // P1-2: don't claim the attempt slot until we know there's
      // actually something to push. Generation can be in-flight (status
      // 'generating', summary null) on this minute — claiming the
      // attempt here would exhaust the slot for the whole day even
      // though we never call pushToUser. Generate (or read the cached
      // row) first; only proceed when a non-null summary exists.
      const brief = await this.briefService.getOrGenerateTodaysBrief(
        prefs.coach_id,
      );
      if (!brief.summary) {
        this.logger.debug(
          `coach brief push deferred for coach=${prefs.coach_id} — summary not ready yet`,
        );
        return;
      }

      // P1-4 fix round 5: bounded retry against the server-only push
      // ledger. The previous design wrote last_push_attempt_date BEFORE
      // calling pushToUser, so any transient Expo failure exhausted the
      // day's slot and the coach never received the brief. The new
      // design:
      //
      //   1) Ensure the ledger row exists (upsert).
      //   2) Short-circuit if last_push_date already equals briefDate
      //      (success already recorded — don't re-send).
      //   3) Claim a short-lived lease (push_attempt_lease_until =
      //      now+90s) using updateMany WHERE no fresh lease is held
      //      AND we haven't exhausted the daily retry budget. If a
      //      newer day rolls over the attempt counter resets to 0.
      //   4) Race pushToUser vs PUSH_TIMEOUT_MS.
      //   5) On delivered=true — write last_push_date=briefDate AND
      //      clear the lease so retries stop.
      //   6) On any non-delivery outcome — clear the lease (but leave
      //      push_attempts_today incremented). The next minute's cron
      //      sees the slot is free and either retries (budget left) or
      //      stops permanently (budget exhausted).
      //
      // The retry budget caps unbounded calls during an Expo outage
      // while still letting a healthy operator hit "resend" via the
      // ledger reset path.
      await this.prisma.coachBriefPushLedger.upsert({
        where: { coach_id: prefs.coach_id },
        create: { coach_id: prefs.coach_id },
        update: {},
      });

      // Step 2: success already recorded today — don't re-send.
      const ledgerSnapshot =
        await this.prisma.coachBriefPushLedger.findUnique({
          where: { coach_id: prefs.coach_id },
        });
      if (ledgerSnapshot?.last_push_date === briefDate) {
        this.logger.debug(
          `coach brief push already delivered for coach=${prefs.coach_id} date=${briefDate}`,
        );
        return;
      }

      // Step 2b: retry budget exhausted for this briefDate? Stop.
      const isSameDay =
        ledgerSnapshot?.last_push_attempt_date === briefDate;
      const attemptsSoFar = isSameDay
        ? ledgerSnapshot?.push_attempts_today ?? 0
        : 0;
      if (attemptsSoFar >= MAX_PUSH_ATTEMPTS) {
        this.logger.warn(
          `coach brief push retry budget exhausted for coach=${prefs.coach_id} date=${briefDate} attempts=${attemptsSoFar}`,
        );
        return;
      }

      // Step 3: lease the slot. updateMany WHERE no fresh lease is
      // held lets exactly one cron instance proceed at a time.
      const leaseUntil = new Date(Date.now() + PUSH_ATTEMPT_LEASE_MS);
      const nowTs = new Date();
      // The new attempt counter: if last_push_attempt_date is rolling
      // forward, reset to 1; otherwise increment.
      const nextAttemptCount = isSameDay ? attemptsSoFar + 1 : 1;
      const leaseClaim = await this.prisma.coachBriefPushLedger.updateMany({
        where: {
          coach_id: prefs.coach_id,
          OR: [
            { push_attempt_lease_until: null },
            { push_attempt_lease_until: { lt: nowTs } },
          ],
        },
        data: {
          last_push_attempt_date: briefDate,
          push_attempts_today: nextAttemptCount,
          push_attempt_lease_until: leaseUntil,
        },
      });
      if (leaseClaim.count === 0) {
        this.logger.debug(
          `coach brief push lease held by another instance for coach=${prefs.coach_id}`,
        );
        return;
      }

      const notifBody = brief.summary.narrative.slice(0, 160);

      // P2-6: AbortController feeds the same signal into pushToUser AND
      // the timeout, so when the 10s deadline trips we actually cancel
      // the in-flight Expo round-trip rather than letting it complete
      // silently after the scheduler has moved on.
      const abortController = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new CoachBriefPushTimeoutError();
          abortController.abort(err);
          reject(err);
        }, PUSH_TIMEOUT_MS);
      });

      // P1-5 fix round 5: pushToUser now returns a typed delivery
      // result. We must consult `delivered`, NOT the absence of a
      // thrown error — a pre-fix-round-5 transport error was swallowed
      // inside pushToUser and we wrote last_push_date anyway.
      let pushDelivered = false;
      let pushOutcome = 'unknown';
      try {
        const raceResult = await Promise.race([
          this.notifications.pushToUser(
            prefs.coach_id,
            'Your daily brief is ready',
            notifBody,
            { deep_link: 'tgp://coach/brief/today', brief_date: briefDate },
            abortController.signal,
          ),
          timeoutPromise,
        ]);
        // raceResult is the PushDeliveryResult when pushToUser wins
        // the race; if the timeout wins, timeoutPromise rejected and
        // we are in the catch block instead.
        pushDelivered = raceResult.delivered;
        pushOutcome = raceResult.code;
      } catch (err) {
        pushOutcome =
          err instanceof CoachBriefPushTimeoutError
            ? 'timeout'
            : 'thrown';
        this.logger.warn(
          `coach brief push failed or timed out for coach ${prefs.coach_id} on ${briefDate}: ${errorMessageOf(err)}`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!pushDelivered) {
        // P1-4: clear the lease so the next minute's cron can retry
        // (subject to MAX_PUSH_ATTEMPTS). Leave push_attempts_today
        // incremented so the budget tracks accurately.
        await this.prisma.coachBriefPushLedger.updateMany({
          where: { coach_id: prefs.coach_id },
          data: { push_attempt_lease_until: null },
        });
        this.logger.debug(
          `coach brief push not delivered for coach=${prefs.coach_id} outcome=${pushOutcome} attempt=${nextAttemptCount}/${MAX_PUSH_ATTEMPTS}`,
        );
        return;
      }

      // P1-4 + P1-5: only when pushToUser reported delivered=true do
      // we mark this briefDate as delivered. Clearing the lease in the
      // same update prevents another instance from re-attempting.
      await this.prisma.coachBriefPushLedger.updateMany({
        where: { coach_id: prefs.coach_id },
        data: {
          last_push_date: briefDate,
          push_attempt_lease_until: null,
        },
      });

      this.logger.log(
        `coach brief push sent: coach=${prefs.coach_id} date=${briefDate}`,
      );
    } catch (err) {
      this.logger.error(
        `coach brief dispatch failed for coach=${prefs.coach_id}: ${errorMessageOf(err)}`,
      );
    }
  }
}
