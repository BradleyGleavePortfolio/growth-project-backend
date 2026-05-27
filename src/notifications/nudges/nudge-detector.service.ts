/**
 * NudgeDetectorService — the four trigger detectors (spec §1).
 *
 * Each detector is a pure read of database state, producing zero-or-more
 * NudgeCandidate records with deterministic signal_keys. The detector
 * does NOT decide whether to send; that's the engine. The detector also
 * does NOT enforce ownership boundaries between triggers; the engine's
 * 48h frequency cap is what prevents a user from receiving two nudges
 * for adjacent reasons. Detectors do, however, scope their windows
 * (e.g. inactivity owns "≥7 days stale"; missed-checkin owns "2–6 days")
 * so the cron isn't producing redundant candidates per pass.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { NudgeCandidate, NudgeTriggerType } from './nudge.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Spec §1 windows. Centralised so tests and detectors agree on the
 * exact boundaries. Tweaking a window must come with a test update.
 */
export const DETECTOR_WINDOWS = {
  /** missed_checkin: last check-in ≥2 days and <7 days ago. */
  missedCheckinMinDays: 2,
  missedCheckinMaxDays: 7,
  /** streak_broken: prior streak length threshold. */
  streakBrokenMinPriorLength: 7,
  /** onboarding_abandoned: account age window in hours. */
  onboardingAbandonedMinHours: 48,
  onboardingAbandonedMaxHours: 96,
  /** inactive: last activity (notification, check-in) days ago. */
  inactiveMinDays: 7,
  inactiveMaxDays: 14,
} as const;

@Injectable()
export class NudgeDetectorService {
  private readonly logger = new Logger(NudgeDetectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Run every detector in turn. Returns the flat list of candidates. */
  async scanAll(now: Date = new Date()): Promise<NudgeCandidate[]> {
    const [a, b, c, d] = await Promise.all([
      this.detectMissedCheckin(now),
      this.detectStreakBroken(now),
      this.detectOnboardingAbandoned(now),
      this.detectInactive(now),
    ]);
    return [...a, ...b, ...c, ...d];
  }

  /**
   * Missed daily check-in 2+ days (spec §1a).
   * Owns the 2–6 day window so it does not stomp the 7-day inactivity detector.
   */
  async detectMissedCheckin(now: Date): Promise<NudgeCandidate[]> {
    const minThreshold = new Date(
      now.getTime() - DETECTOR_WINDOWS.missedCheckinMaxDays * DAY_MS,
    );
    const maxThreshold = new Date(
      now.getTime() - DETECTOR_WINDOWS.missedCheckinMinDays * DAY_MS,
    );

    // Users whose most-recent check-in date sits within (minThreshold, maxThreshold].
    // We pull each user's most recent check-in, then filter.
    const rows = await this.prisma.checkIn.groupBy({
      by: ['user_id'],
      _max: { date: true },
    });

    const candidates: NudgeCandidate[] = [];
    for (const row of rows) {
      const lastDate = row._max.date;
      if (!lastDate) continue;
      if (lastDate < minThreshold) continue; // covered by inactivity
      if (lastDate >= maxThreshold) continue; // still fresh
      const todayKey = isoDate(now);
      candidates.push({
        user_id: row.user_id,
        trigger_type: NudgeTriggerType.MISSED_CHECKIN,
        signal_key: `missed_checkin:${todayKey}`,
        context: {},
      });
    }
    return candidates;
  }

  /**
   * Streak broken ≥7 days (spec §1b).
   *
   * Heuristic: a user whose most recent check-in is exactly 1–2 days
   * ago (today missed, possibly yesterday too) but whose preceding
   * consecutive run was ≥7. We compute the prior streak by walking
   * back from the most recent check-in row until we hit a gap.
   */
  async detectStreakBroken(now: Date): Promise<NudgeCandidate[]> {
    const lookbackStart = new Date(now.getTime() - 90 * DAY_MS);
    // Pull users whose most recent check-in is 1 or 2 days stale —
    // narrow enough to keep the lookback affordable.
    const recent = await this.prisma.checkIn.findMany({
      where: { date: { gte: lookbackStart } },
      orderBy: [{ user_id: 'asc' }, { date: 'desc' }],
      select: { user_id: true, date: true },
    });

    const byUser = new Map<string, Date[]>();
    for (const r of recent) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r.date);
    }

    const candidates: NudgeCandidate[] = [];
    for (const [user_id, dates] of byUser) {
      // dates are desc-sorted, calendar-date rows.
      const latest = dates[0];
      if (!latest) continue;
      const daysSinceLatest = floorDays(now, latest);
      // "Just broken": today missed, yesterday or day-before was the
      // last entry. Outside that window we're either still on streak
      // or so stale that inactivity owns it.
      if (daysSinceLatest < 1 || daysSinceLatest > 2) continue;

      // Walk backwards counting consecutive-day entries.
      let priorStreak = 1;
      for (let i = 1; i < dates.length; i++) {
        const gap = floorDays(dates[i - 1], dates[i]);
        if (gap === 1) priorStreak++;
        else break;
      }
      if (priorStreak < DETECTOR_WINDOWS.streakBrokenMinPriorLength) continue;

      candidates.push({
        user_id,
        trigger_type: NudgeTriggerType.STREAK_BROKEN,
        signal_key: `streak_broken:${isoDate(latest)}:${priorStreak}`,
        context: { prior_streak_length: priorStreak },
      });
    }
    return candidates;
  }

  /**
   * Onboarding abandoned (spec §1c).
   * User created 48–96h ago, profile.onboardingCompleted is not true.
   * The lower bound prevents nudging brand-new users who are still
   * mid-flow; the upper bound caps the window so a long-abandoned user
   * is not re-nudged forever (inactivity will cover them later).
   */
  async detectOnboardingAbandoned(now: Date): Promise<NudgeCandidate[]> {
    const ceiling = new Date(
      now.getTime() - DETECTOR_WINDOWS.onboardingAbandonedMinHours * 3600 * 1000,
    );
    const floor = new Date(
      now.getTime() - DETECTOR_WINDOWS.onboardingAbandonedMaxHours * 3600 * 1000,
    );

    const users = await this.prisma.user.findMany({
      where: {
        created_at: { gte: floor, lte: ceiling },
        archived_at: null,
        deleted_at: null,
        profile: {
          is: { onboardingCompleted: false },
        },
      },
      select: { id: true, name: true, created_at: true },
    });

    return users.map((u) => ({
      user_id: u.id,
      trigger_type: NudgeTriggerType.ONBOARDING_ABANDONED,
      signal_key: `onboarding_abandoned:${isoDate(u.created_at)}`,
      context: { first_name: deriveFirstName(u.name) },
    }));
  }

  /**
   * Inactivity 7+ days, capped at 14d so we don't nudge churned users
   * indefinitely. Uses the most recent activity row across Notification
   * and CheckIn as the proxy — both are written by the user's actions
   * and are indexed by user_id + a timestamp column.
   */
  async detectInactive(now: Date): Promise<NudgeCandidate[]> {
    const oldest = new Date(
      now.getTime() - DETECTOR_WINDOWS.inactiveMaxDays * DAY_MS,
    );
    const newest = new Date(
      now.getTime() - DETECTOR_WINDOWS.inactiveMinDays * DAY_MS,
    );

    // Users with no activity newer than `newest`. We scope to users who
    // have any history at all (created_at older than the inactive window)
    // so brand-new sign-ups don't show up here.
    const users = await this.prisma.user.findMany({
      where: {
        created_at: { lte: newest },
        archived_at: null,
        deleted_at: null,
      },
      select: { id: true, name: true },
    });

    const candidates: NudgeCandidate[] = [];
    for (const u of users) {
      const [lastCheckin, lastNotif] = await Promise.all([
        this.prisma.checkIn.findFirst({
          where: { user_id: u.id },
          orderBy: { logged_at: 'desc' },
          select: { logged_at: true },
        }),
        this.prisma.notification.findFirst({
          where: { user_id: u.id, read_at: { not: null } },
          orderBy: { read_at: 'desc' },
          select: { read_at: true },
        }),
      ]);
      const lastActivity = maxDate(
        lastCheckin?.logged_at ?? null,
        lastNotif?.read_at ?? null,
      );
      // If we have no activity row at all the user is dormant from day
      // one — let onboarding-abandoned own the early window; we only
      // fire here when there *was* activity that has since gone quiet.
      if (!lastActivity) continue;
      if (lastActivity > newest) continue; // still active
      if (lastActivity < oldest) continue; // beyond our window

      const dayKey = isoDate(lastActivity);
      candidates.push({
        user_id: u.id,
        trigger_type: NudgeTriggerType.INACTIVE,
        signal_key: `inactive:${dayKey}`,
        context: { first_name: deriveFirstName(u.name) },
      });
    }
    return candidates;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function floorDays(later: Date, earlier: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / DAY_MS);
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() > b.getTime() ? a : b;
}

function deriveFirstName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0];
}
