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
 * Subscription states that mean the user is *not* paying / not entitled
 * and therefore must not receive growth-prompt nudges. See audit P2-3.
 *
 * Coach side: CoachSubscription.status. Authority is billing.service.ts —
 * only 'active' and 'trialing' grant entitlement; everything else is a
 * lapsed state.
 *
 * Client side: ClientPurchase.entitlement_active is the source of truth.
 * If the user has no active entitlement on any purchase they are excluded.
 *
 * A user with NO subscription rows at all (e.g. brand-new sign-up before
 * paywall, free-tier coach) is considered *eligible* — exclusion only
 * kicks in when there's a row and it's in a non-active state.
 */
const ACTIVE_COACH_SUB_STATES = new Set(['active', 'trialing']);

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
    const all = [...a, ...b, ...c, ...d];
    return this.filterInactiveSubscriptions(all);
  }

  /**
   * Subscription-state gate (audit P2-3).
   *
   * Drops candidates for users whose billing state is non-active:
   *  - Coaches with CoachSubscription.status in {canceled, past_due,
   *    paused, unpaid, incomplete} — i.e. anything that isn't
   *    'active' or 'trialing'.
   *  - Clients whose only ClientPurchase rows have
   *    entitlement_active=false (canceled/past_due/expired/etc.).
   *
   * Users with no subscription rows at all are kept — they may be free
   * tier or pre-paywall, both of which we still want to engage.
   *
   * Coordinates with PR #281 (Dunning v1) which owns the lapsed-state
   * lifecycle; we only *read* the resulting state column here.
   */
  private async filterInactiveSubscriptions(
    candidates: NudgeCandidate[],
  ): Promise<NudgeCandidate[]> {
    if (candidates.length === 0) return candidates;
    const userIds = Array.from(new Set(candidates.map((c) => c.user_id)));

    // Single batched read per side. Both indexes (CoachSubscription.coach_id
    // is @unique, ClientPurchase has user_id index) make this cheap.
    const [coachSubs, clientPurchases] = await Promise.all([
      this.prisma.coachSubscription.findMany({
        where: { coach_id: { in: userIds } },
        select: { coach_id: true, status: true },
      }),
      this.prisma.clientPurchase.findMany({
        where: { client_user_id: { in: userIds } },
        select: { client_user_id: true, entitlement_active: true },
      }),
    ]);

    // Coach side: a row in non-active state excludes the user. (A coach
    // has exactly one CoachSubscription row — coach_id is @unique.)
    const excludedCoach = new Set<string>();
    for (const row of coachSubs) {
      if (!ACTIVE_COACH_SUB_STATES.has(row.status)) {
        excludedCoach.add(row.coach_id);
      }
    }

    // Client side: a user is excluded when they have purchase rows AND
    // none of them are entitlement_active. If any purchase is active,
    // they're entitled.
    const purchasesByUser = new Map<string, boolean[]>();
    for (const row of clientPurchases) {
      if (!purchasesByUser.has(row.client_user_id)) {
        purchasesByUser.set(row.client_user_id, []);
      }
      purchasesByUser.get(row.client_user_id)!.push(row.entitlement_active);
    }
    const excludedClient = new Set<string>();
    for (const [uid, flags] of purchasesByUser) {
      if (flags.length > 0 && !flags.some((f) => f === true)) {
        excludedClient.add(uid);
      }
    }

    return candidates.filter(
      (c) => !excludedCoach.has(c.user_id) && !excludedClient.has(c.user_id),
    );
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
   *
   * Timezone correctness (audit P2-2 refix):
   * ────────────────────────────────────────────────────────
   * "Days" here are *calendar* days in the user's local timezone, not
   * fixed 24h UTC windows. The pre-refix code did `floor((now - latest) /
   * 86_400_000)` which silently mis-counts on DST transition days (a 23h
   * or 25h local day rounds the wrong way and either fires a day late
   * or skips a candidate entirely). Now we pull each user's tz from
   * NotificationPreferences, format every check-in date and `now` to a
   * YYYY-MM-DD string in that zone, and difference the date strings.
   * Same fallback default ('America/Los_Angeles') as the rest of the
   * notifications stack so users without a prefs row are still handled.
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
    if (byUser.size === 0) return [];

    // Batch-fetch timezone for every candidate user (one round-trip).
    // Users without a prefs row fall back to the schema default.
    const userIds = Array.from(byUser.keys());
    const prefRows = await this.prisma.notificationPreferences.findMany({
      where: { user_id: { in: userIds } },
      select: { user_id: true, timezone: true },
    });
    const tzByUser = new Map<string, string>();
    for (const r of prefRows) tzByUser.set(r.user_id, r.timezone);

    const candidates: NudgeCandidate[] = [];
    for (const [user_id, dates] of byUser) {
      const tz = tzByUser.get(user_id) ?? 'America/Los_Angeles';
      // dates are desc-sorted, calendar-date rows.
      const latest = dates[0];
      if (!latest) continue;
      const daysSinceLatest = calendarDayDiff(now, latest, tz);
      // "Just broken": today missed, yesterday or day-before was the
      // last entry. Outside that window we're either still on streak
      // or so stale that inactivity owns it.
      if (daysSinceLatest < 1 || daysSinceLatest > 2) continue;

      // Walk backwards counting consecutive-day entries in the user's
      // local calendar.
      let priorStreak = 1;
      for (let i = 1; i < dates.length; i++) {
        const gap = calendarDayDiff(dates[i - 1], dates[i], tz);
        if (gap === 1) priorStreak++;
        else break;
      }
      if (priorStreak < DETECTOR_WINDOWS.streakBrokenMinPriorLength) continue;

      candidates.push({
        user_id,
        trigger_type: NudgeTriggerType.STREAK_BROKEN,
        signal_key: `streak_broken:${localDateKey(latest, tz)}:${priorStreak}`,
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
   *
   * Implementation note (audit P2-1 refix):
   * ────────────────────────────────────────────────────────
   * The original implementation issued two awaited SELECTs PER USER
   * per tick — ~20k queries on a 10k-user dataset, every 15 minutes.
   * The refixed version is three round-trips total regardless of
   * dataset size: one user findMany, one checkIn groupBy, one
   * notification groupBy. Merge happens in memory.
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
    if (users.length === 0) return [];

    const userIds = users.map((u) => u.id);

    // Single round-trip per source. Filtering by `user_id IN (...)`
    // lets Postgres use the existing (user_id, logged_at) /
    // (user_id, read_at) indexes on each table. Memory cost is O(n)
    // where n = distinct (user_id, source) pairs that have *any*
    // history — bounded by `users.length` per source.
    const [checkinAgg, notifAgg] = await Promise.all([
      this.prisma.checkIn.groupBy({
        by: ['user_id'],
        where: { user_id: { in: userIds } },
        _max: { logged_at: true },
      }),
      this.prisma.notification.groupBy({
        by: ['user_id'],
        where: { user_id: { in: userIds }, read_at: { not: null } },
        _max: { read_at: true },
      }),
    ]);

    const lastCheckinByUser = new Map<string, Date | null>();
    for (const row of checkinAgg) {
      lastCheckinByUser.set(row.user_id, row._max.logged_at ?? null);
    }
    const lastNotifByUser = new Map<string, Date | null>();
    for (const row of notifAgg) {
      lastNotifByUser.set(row.user_id, row._max.read_at ?? null);
    }

    const candidates: NudgeCandidate[] = [];
    for (const u of users) {
      const lastActivity = maxDate(
        lastCheckinByUser.get(u.id) ?? null,
        lastNotifByUser.get(u.id) ?? null,
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

/**
 * Calendar-day difference in a given IANA timezone.
 *
 * Returns the integer number of local-calendar days between `earlier`
 * and `later` (later - earlier). Unlike `floorDays`, this is immune to
 * DST transitions because we project both timestamps onto their local
 * YYYY-MM-DD label and difference the labels as UTC midnights — DST
 * doesn't move calendar days, only the clock.
 *
 * Used by detectStreakBroken (audit P2-2). Exported for testing.
 */
export function calendarDayDiff(
  later: Date,
  earlier: Date,
  timezone: string,
): number {
  const laterKey = localDateKey(later, timezone);
  const earlierKey = localDateKey(earlier, timezone);
  // Reinterpret the two YYYY-MM-DD strings as UTC midnights so we can
  // subtract them safely — both have 24h "days" by construction.
  const laterMs = Date.parse(`${laterKey}T00:00:00Z`);
  const earlierMs = Date.parse(`${earlierKey}T00:00:00Z`);
  return Math.round((laterMs - earlierMs) / DAY_MS);
}

/** YYYY-MM-DD for an instant projected into `timezone`. */
export function localDateKey(d: Date, timezone: string): string {
  // Intl.DateTimeFormat with 'en-CA' yields YYYY-MM-DD reliably.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
