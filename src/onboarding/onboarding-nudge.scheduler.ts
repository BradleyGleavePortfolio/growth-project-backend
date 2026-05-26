/**
 * OnboardingNudgeScheduler — runs every UTC minute; per-coach matches
 * the dispatch hour against the coach's local clock and fires whichever
 * day-N nudge is due.
 *
 * Why every-minute instead of @Cron('0 9 * * *'):
 *   A single global-UTC cron would land all nudges at one moment (e.g.
 *   17:00 UTC = 09:00 PT but 03:00 JST), which is hostile to coaches in
 *   non-Pacific timezones. The minute-tick + per-coach localisation
 *   pattern matches `coach-brief.scheduler.ts` exactly so the operator
 *   ergonomics are consistent (same kill-switch shape, same retry
 *   bounding, same dashboards).
 *
 * Eligibility per tick:
 *   - role coach or owner
 *   - signup within the last 7 days (or no row yet — created lazily)
 *   - not opted out
 *   - first_client not yet recorded
 *   - day-N number where (N == days_since_signup) ∈ {1, 2, 3, 5, 7}
 *   - day_N_sent is still false on the persisted row
 *
 * Per-coach try/catch isolates failures.  A kill-switch env var
 * (`ONBOARDING_NUDGE_DISABLED=true`) short-circuits the whole tick.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { OnboardingNudgeService } from './onboarding-nudge.service';
import { bucketDateLocal } from '../coach/brief/coach-brief.service';
import type { NudgeDay } from './nudge-content';

// Default dispatch hour (24h, coach-local).  Operators can override
// via ONBOARDING_NUDGE_HOUR_LOCAL if product wants a later slot.
const DEFAULT_DISPATCH_HOUR = 9;

// Eligibility window: do not start sending to a coach whose signup is
// older than this — the sequence only addresses the first week.
const ELIGIBLE_WINDOW_DAYS = 8; // generous: allows day-7 to fire on the 7th day even with clock skew

@Injectable()
export class OnboardingNudgeScheduler {
  private readonly logger = new Logger(OnboardingNudgeScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: OnboardingNudgeService,
    private readonly config: ConfigService,
  ) {}

  /** Every UTC minute — see header comment for why. */
  @Cron('* * * * *', { name: 'onboarding-nudge-dispatch', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.config.get<string>('ONBOARDING_NUDGE_DISABLED') === 'true') return;
    try {
      await this.runOnce(new Date());
    } catch (err) {
      this.logger.error(
        `onboarding nudge tick failed: ${errMsg(err)}`,
      );
    }
  }

  /**
   * Test seam: run a single dispatch pass against an injected `now`.
   * Returns the number of nudges actually fired so the integration
   * test can assert convergence behavior without booting cron.
   */
  async runOnce(now: Date): Promise<number> {
    const dispatchHour = this.dispatchHour();
    const windowStart = new Date(now);
    windowStart.setUTCDate(windowStart.getUTCDate() - ELIGIBLE_WINDOW_DAYS);

    // Candidate coaches: created within the eligibility window, role
    // coach/owner, not soft/hard-deleted. We pull coach_profile.timezone
    // here so per-coach tz lookup is one query, not N.
    const candidates = await this.prisma.user.findMany({
      where: {
        role: { in: ['coach', 'owner'] },
        deletion_scheduled_at: null,
        deleted_at: null,
        created_at: { gte: windowStart },
      },
      select: {
        id: true,
        created_at: true,
        coach_profile: { select: { timezone: true } },
      },
    });

    let fired = 0;
    for (const coach of candidates) {
      try {
        // Lazy ensureState — also resolves coaches who signed up
        // pre-PR with no state row yet.
        const state = await this.service.ensureState(coach.id);
        if (state.opted_out_at) continue;
        if (state.first_client_at) continue;

        const timezone = coach.coach_profile?.timezone || 'America/Los_Angeles';
        if (!this.isDispatchMinute(now, timezone, dispatchHour)) continue;

        const day = this.dueDay(state.signup_at, now, timezone);
        if (day === null) continue;

        const sent = await this.service.sendNudge(coach.id, day);
        if (sent) fired += 1;
      } catch (err) {
        this.logger.error(
          `onboarding nudge dispatch failed coach=${coach.id}: ${errMsg(err)}`,
        );
      }
    }
    if (fired > 0) {
      this.logger.log(`onboarding nudge tick fired ${fired} nudges`);
    }
    return fired;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private dispatchHour(): number {
    const raw = this.config.get<string>('ONBOARDING_NUDGE_HOUR_LOCAL');
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= 0 && n < 24) return n;
    return DEFAULT_DISPATCH_HOUR;
  }

  /**
   * Returns true if `now` (UTC) falls in the configured dispatch hour
   * AND minute 0..1 in the coach's local tz.  We accept minute 0 OR 1
   * to give the cron a 1-minute jitter buffer against tick latency on
   * Fly's scheduler (occasionally the every-minute cron slips ~30s).
   */
  private isDispatchMinute(
    now: Date,
    timezone: string,
    dispatchHour: number,
  ): boolean {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(now);
    } catch {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(now);
    }
    let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(
      parts.find((p) => p.type === 'minute')?.value ?? '0',
      10,
    );
    if (hour === 24) hour = 0; // Intl can emit '24' at midnight on some platforms
    if (hour !== dispatchHour) return false;
    return minute === 0 || minute === 1;
  }

  /**
   * Compute "days since signup" in the coach's local timezone (uses
   * bucketDateLocal so DST + non-PT zones don't drift) and return the
   * matching NudgeDay, or null if today is not a nudge day.
   */
  private dueDay(
    signupAt: Date,
    now: Date,
    timezone: string,
  ): NudgeDay | null {
    const signupBucket = bucketDateLocal(signupAt, timezone);
    const todayBucket = bucketDateLocal(now, timezone);
    const days = daysBetweenIsoBuckets(signupBucket, todayBucket);
    if (days === 1) return 1;
    if (days === 2) return 2;
    if (days === 3) return 3;
    if (days === 5) return 5;
    if (days === 7) return 7;
    return null;
  }
}

// ─── Free helpers ─────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inclusive-of-end day count between two YYYY-MM-DD strings produced
 * by bucketDateLocal.  Returns the integer number of calendar days
 * between `a` and `b` (b - a).  Negative for b < a.
 */
export function daysBetweenIsoBuckets(a: string, b: string): number {
  // Parse as UTC to avoid DST arithmetic — the strings are already
  // local-timezone-bucketed; we only care about the calendar delta.
  const ta = Date.UTC(
    parseInt(a.slice(0, 4), 10),
    parseInt(a.slice(5, 7), 10) - 1,
    parseInt(a.slice(8, 10), 10),
  );
  const tb = Date.UTC(
    parseInt(b.slice(0, 4), 10),
    parseInt(b.slice(5, 7), 10) - 1,
    parseInt(b.slice(8, 10), 10),
  );
  return Math.round((tb - ta) / 86_400_000);
}
