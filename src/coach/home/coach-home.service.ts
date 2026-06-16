// src/coach/home/coach-home.service.ts
//
// ED.2 (Roman three-arc router) — composes today's three completion counts
// for the Coach Home rings widget:
//
//   check-ins → reviewed / submitted  (CheckIn rows for this coach, today)
//   brief     → opened (boolean)       (CoachBrief.read_at for today's brief)
//   review    → reviewed / total       (ConversationReview vs Conversations
//                                        with new client messages today)
//
// Scoping: every read is keyed on the CALLING coach's id (coach_id). There is
// no path/query parameter that lets a caller name another coach, so there is
// no cross-coach leak (mirrors CoachEffectivenessController §scoping).
//
// Flag: behind FEATURE_ROMAN_THREE_ARC_COUNTS (default OFF). While OFF the
// service short-circuits to a fully-zeroed shape WITHOUT touching Prisma, so
// the disabled feature does no work and advertises nothing.
//
// Cache: the response is polled on Coach Home focus, so we memoise per-coach
// for 30s (light in-memory map). The cache is keyed on (coachId, utcDay) so it
// self-invalidates at the UTC day boundary and never serves a stale yesterday.
// DO NOT add a Prisma model — this service only reads existing repositories.

import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { Events } from '../../analytics/events';
import { isThreeArcCountsEnabled } from './three-arc-counts.feature';

// Narrow structural slice of PrismaService this service reads. Declaring the
// dependency as this interface (rather than the full PrismaService) lets the
// controller spec supply a typed in-memory double WITHOUT an unsafe widening
// cast — keeping the R0/R80 ban-scan clean. PrismaService satisfies it
// structurally at the DI boundary. Every method here is read-only; this service
// NEVER writes and NEVER adds a Prisma model.
export interface DailyRingsRepo {
  checkIn: { count(args: { where: Record<string, unknown> }): Promise<number> };
  coachBrief: { count(args: { where: Record<string, unknown> }): Promise<number> };
  conversationReview: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
  coachMessage: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { client_id: true };
      distinct: ['client_id'];
    }): Promise<Array<{ client_id: string | null }>>;
  };
}

// Runtime response envelope. `.strict()` at every level rejects any field the
// contract does not name, so a future change that widens a nested object (a
// silent API leak) throws at parse time instead of shipping. Both the zeroed
// and the computed responses are parsed before they leave the service (and
// before they enter the cache).
export const DailyRingsSchema = z
  .object({
    checkIns: z.object({ reviewed: z.number(), submitted: z.number() }).strict(),
    brief: z.object({ opened: z.boolean() }).strict(),
    review: z
      .object({ reviewed: z.number(), totalConversations: z.number() })
      .strict(),
  })
  .strict();

export type DailyRingsResponse = z.infer<typeof DailyRingsSchema>;

interface CacheEntry {
  expiresAt: number;
  value: DailyRingsResponse;
}

/** Fully-zeroed shape returned when the flag is OFF or a coach has no data. */
export function zeroedDailyRings(): DailyRingsResponse {
  return {
    checkIns: { reviewed: 0, submitted: 0 },
    brief: { opened: false },
    review: { reviewed: 0, totalConversations: 0 },
  };
}

/** Cache TTL in ms — the widget polls on Coach Home focus (brief §Backend). */
export const DAILY_RINGS_CACHE_TTL_MS = 30_000;

@Injectable()
export class CoachHomeService {
  // Per-coach memo. Keyed by `${coachId}:${utcDay}` so it self-invalidates at
  // the UTC day boundary — a coach polling across midnight never sees a stale
  // yesterday count.
  private readonly cache = new Map<string, CacheEntry>();

  // Injected by the PrismaService DI token but typed as the narrow read-only
  // slice (DailyRingsRepo) so tests can pass a typed double without a cast.
  // AnalyticsService is global + optional at the call site (no-op when PostHog
  // is unconfigured) so existing specs that construct the service with only a
  // Prisma double keep working.
  constructor(
    @Inject(PrismaService) private readonly prisma: DailyRingsRepo,
    private readonly analytics?: AnalyticsService,
  ) {}

  /**
   * Today's three-arc counts for the calling coach.
   *
   * @param coachId  always `req.user.id` — never client-supplied.
   * @param now      injectable clock for deterministic tests.
   */
  async getDailyRings(
    coachId: string,
    now: Date = new Date(),
  ): Promise<DailyRingsResponse> {
    // Flag OFF → zeroed shape, no Prisma reads, no cache pollution, no
    // telemetry. Parsed through the strict schema so the OFF path obeys the
    // same response contract as the ON path.
    if (!isThreeArcCountsEnabled()) {
      return DailyRingsSchema.parse(zeroedDailyRings());
    }

    const utcDay = now.toISOString().split('T')[0]; // YYYY-MM-DD (UTC)
    const cacheKey = `${coachId}:${utcDay}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now.getTime()) {
      // Cache HIT — no telemetry (only misses represent a real fetch).
      return cached.value;
    }

    // Lazy prune: drop any entry keyed to a UTC day other than today. The
    // cache key is `${coachId}:${utcDay}`, so a long-lived process otherwise
    // accumulates one stale entry per coach per past day. Pruning here (before
    // the new set) bounds the map to "coaches seen today" without a timer.
    this.pruneStaleEntries(utcDay);

    const startOfDay = new Date(`${utcDay}T00:00:00.000Z`);
    const endOfDay = new Date(`${utcDay}T23:59:59.999Z`);

    const [checkIns, brief, review] = await Promise.all([
      this.countCheckIns(coachId, startOfDay, endOfDay),
      this.briefOpened(coachId, utcDay),
      this.countReview(coachId, startOfDay, endOfDay),
    ]);

    const value = DailyRingsSchema.parse({ checkIns, brief, review });
    this.cache.set(cacheKey, {
      value,
      expiresAt: now.getTime() + DAILY_RINGS_CACHE_TTL_MS,
    });

    // Telemetry on flag-ON cache MISS only — never on a hit, never on the
    // flag-OFF zeroed path. Non-PII: the coach id (opaque distinctId) plus the
    // numeric/boolean ring state only.
    this.analytics?.capture(coachId, Events.COACH_DAILY_RINGS_FETCHED, {
      checkIns_reviewed: checkIns.reviewed,
      checkIns_submitted: checkIns.submitted,
      brief_opened: brief.opened,
      review_reviewed: review.reviewed,
      review_total: review.totalConversations,
    });

    return value;
  }

  /** Delete cache entries whose UTC-day key suffix is not today's. */
  private pruneStaleEntries(utcDay: string): void {
    const todaySuffix = `:${utcDay}`;
    for (const key of this.cache.keys()) {
      if (!key.endsWith(todaySuffix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Check-ins arc — submitted vs reviewed for THIS coach's roster, today.
   * submitted = CheckIn rows attached to the coach with today's `date`.
   * reviewed  = of those, the ones the coach has stamped `coach_reviewed_at`
   *             (most-recent-review semantics; non-null = reviewed).
   * `date` is a `@db.Date` column so it stores midnight UTC; we match the
   * exact day via a [startOfDay, endOfDay] range to stay index-friendly on
   * `@@index([coach_id, date])`.
   */
  private async countCheckIns(
    coachId: string,
    startOfDay: Date,
    endOfDay: Date,
  ): Promise<{ reviewed: number; submitted: number }> {
    const dateWindow = { gte: startOfDay, lte: endOfDay };
    const [submitted, reviewed] = await Promise.all([
      this.prisma.checkIn.count({
        where: { coach_id: coachId, date: dateWindow },
      }),
      this.prisma.checkIn.count({
        where: {
          coach_id: coachId,
          date: dateWindow,
          coach_reviewed_at: { not: null },
        },
      }),
    ]);
    return { reviewed, submitted };
  }

  /**
   * Brief arc — has THIS coach opened today's brief? The brief-render path
   * stamps `read_at` when the coach opens the brief in-app, so opened =
   * today's CoachBrief row exists AND `read_at` is non-null. `brief_date` is
   * the canonical day key (string YYYY-MM-DD) on the unique
   * (coach_id, brief_date) pair.
   */
  private async briefOpened(
    coachId: string,
    utcDay: string,
  ): Promise<{ opened: boolean }> {
    const count = await this.prisma.coachBrief.count({
      where: {
        coach_id: coachId,
        brief_date: utcDay,
        read_at: { not: null },
      },
    });
    return { opened: count > 0 };
  }

  /**
   * Review arc — client message threads this coach has reviewed today vs the
   * total threads carrying new client messages today.
   *
   * reviewed: ConversationReview rows for this coach whose `coach_reviewed_at`
   *           lands within today's UTC window (most-recent semantics — a fresh
   *           review re-stamps the row, so a same-day review counts).
   * total:    distinct clients who sent the coach a CoachMessage today. A
   *           client message is one in the coach's thread whose `sender_id`
   *           is NOT the coach (the coach's own replies don't count as
   *           something to review). We count distinct `client_id`s rather
   *           than raw messages so a chatty client is one conversation, not
   *           many.
   */
  private async countReview(
    coachId: string,
    startOfDay: Date,
    endOfDay: Date,
  ): Promise<{ reviewed: number; totalConversations: number }> {
    const window = { gte: startOfDay, lte: endOfDay };
    const [reviewed, senders] = await Promise.all([
      this.prisma.conversationReview.count({
        where: { coach_id: coachId, coach_reviewed_at: window },
      }),
      this.prisma.coachMessage.findMany({
        where: {
          coach_id: coachId,
          // Client-sent: anyone other than the coach in the thread. The
          // coach's own replies are not "to review".
          NOT: { sender_id: coachId },
          created_at: window,
        },
        select: { client_id: true },
        distinct: ['client_id'],
      }),
    ]);
    const totalConversations = senders.filter(
      (s) => s.client_id != null,
    ).length;
    return { reviewed, totalConversations };
  }
}
