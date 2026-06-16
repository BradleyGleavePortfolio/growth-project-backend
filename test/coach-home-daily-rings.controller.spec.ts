/**
 * ED.2 (Roman three-arc router) — GET /coach/home/daily-rings.
 *
 * Asserts:
 *   (a) CoachHomeController carries a class-level @Roles('coach') decorator
 *       (R80 / L10 lesson — a new coach handler missing @Roles trips the
 *       roles-enforced.spec.ts pin; the class-level decorator keeps it OFF the
 *       LEGACY_GUARD_ALLOWLIST);
 *   (b) the route returns the CALLING coach's own counts, scoped to
 *       req.user.id (no path/query lets a caller name another coach);
 *   (c) flag OFF → fully-zeroed shape, NO Prisma reads;
 *   (d) flag ON → composes the three arcs from existing repositories;
 *   (e) zero-row safety — a coach with no data gets zeros, not a throw;
 *   (f) no cross-coach leak — every Prisma `where` is keyed on the caller id;
 *   (g) CoachGuard rejects students (403) and admits coach/owner;
 *   (h) 30s in-memory cache: a second call inside the TTL does not re-read
 *       Prisma; the cache self-invalidates at the UTC day boundary.
 */
import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { AuthedRequest } from '../src/auth/auth-request';
import { CoachHomeController } from '../src/coach/home/coach-home.controller';
import {
  CoachHomeService,
  zeroedDailyRings,
  DAILY_RINGS_CACHE_TTL_MS,
  DailyRingsRepo,
  DailyRingsSchema,
} from '../src/coach/home/coach-home.service';
import { Events } from '../src/analytics/events';
import {
  isThreeArcCountsEnabled,
  FEATURE_ROMAN_THREE_ARC_COUNTS_ENV,
} from '../src/coach/home/three-arc-counts.feature';
import { CoachGuard } from '../src/auth/coach.guard';
import { Roles } from '../src/common/decorators/roles.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { AnalyticsService } from '../src/analytics/analytics.service';

// @nestjs/throttler stores per-bucket metadata under THROTTLER:LIMIT<name> /
// THROTTLER:TTL<name>; the unnamed `default` bucket uses the "default" suffix.
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_KEY = 'THROTTLER:TTLdefault';

const KEY = FEATURE_ROMAN_THREE_ARC_COUNTS_ENV;

// req.user is the Prisma User; the controller only reads `req.user.id` and the
// guard only reads `user.role`. We build a structurally-complete-enough double
// via Object.assign onto a bare object so no cast is needed at the call site.
function makeReq(user: { id: string; role: string }): AuthedRequest {
  const req: AuthedRequest = Object.assign(Object.create(null), { user });
  return req;
}

// ExecutionContext double for the CoachGuard unit checks — only
// switchToHttp().getRequest().user is read. A plain typed assertion to
// ExecutionContext keeps the R0/R80 ban-scan clean (no unsafe widening casts)
// while the guard sees the shape it needs.
function guardCtx(user: { id: string; role: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as ExecutionContext;
}

/**
 * Minimal Prisma double. `checkIn.count` and `coachBrief.count` are jest fns
 * whose resolved values are driven per-test; `coachMessage.findMany` returns a
 * list of { client_id } rows; `conversationReview.count` returns the reviewed
 * count. Every fn records its `where` so we can assert coach-scoping.
 */
interface PrismaDouble {
  repo: DailyRingsRepo;
  checkInCount: jest.Mock;
  coachBriefCount: jest.Mock;
  conversationReviewCount: jest.Mock;
  coachMessageFindMany: jest.Mock;
}

function buildPrisma(opts: {
  checkInSubmitted?: number;
  checkInReviewed?: number;
  briefOpened?: number;
  reviewReviewed?: number;
  senderClients?: Array<{ client_id: string | null }>;
} = {}): PrismaDouble {
  const checkInCount = jest.fn(
    async (args: { where: Record<string, unknown> }): Promise<number> => {
      // reviewed query carries coach_reviewed_at: { not: null }
      if (args?.where?.coach_reviewed_at) return opts.checkInReviewed ?? 0;
      return opts.checkInSubmitted ?? 0;
    },
  );
  const coachBriefCount = jest.fn(async (): Promise<number> => opts.briefOpened ?? 0);
  const conversationReviewCount = jest.fn(
    async (): Promise<number> => opts.reviewReviewed ?? 0,
  );
  const coachMessageFindMany = jest.fn(
    async (): Promise<Array<{ client_id: string | null }>> =>
      opts.senderClients ?? [],
  );
  const repo: DailyRingsRepo = {
    checkIn: { count: checkInCount },
    coachBrief: { count: coachBriefCount },
    conversationReview: { count: conversationReviewCount },
    coachMessage: { findMany: coachMessageFindMany },
  };
  return {
    repo,
    checkInCount,
    coachBriefCount,
    conversationReviewCount,
    coachMessageFindMany,
  };
}

function setFlag(on: boolean) {
  if (on) process.env[KEY] = 'true';
  else delete process.env[KEY];
}

describe('CoachHomeController — ED.2 GET /coach/home/daily-rings', () => {
  const prevFlag = process.env[KEY];
  afterAll(() => {
    if (prevFlag === undefined) delete process.env[KEY];
    else process.env[KEY] = prevFlag;
  });
  beforeEach(() => setFlag(false));

  // ── (a) class-level @Roles('coach') ────────────────────────────────────
  it('carries a class-level @Roles(\'coach\') decorator (roles-enforced pin)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, CoachHomeController);
    expect(roles).toEqual(['coach']);
  });

  // ── (c) flag OFF → zeroed shape, no Prisma reads ───────────────────────
  it('returns a fully-zeroed shape when the flag is OFF and reads no Prisma', async () => {
    setFlag(false);
    const prisma = buildPrisma({ checkInSubmitted: 9, checkInReviewed: 4 });
    const ctrl = new CoachHomeController(new CoachHomeService(prisma.repo));

    const res = await ctrl.dailyRings(makeReq({ id: 'coach-1', role: 'coach' }));

    expect(res).toEqual(zeroedDailyRings());
    expect(prisma.checkInCount).not.toHaveBeenCalled();
    expect(prisma.coachBriefCount).not.toHaveBeenCalled();
    expect(prisma.conversationReviewCount).not.toHaveBeenCalled();
    expect(prisma.coachMessageFindMany).not.toHaveBeenCalled();
  });

  // ── (d) flag ON → composes three arcs ──────────────────────────────────
  it('composes the three arcs from existing repositories when the flag is ON', async () => {
    setFlag(true);
    const prisma = buildPrisma({
      checkInSubmitted: 6,
      checkInReviewed: 4,
      briefOpened: 1,
      reviewReviewed: 2,
      senderClients: [{ client_id: 'a' }, { client_id: 'b' }, { client_id: 'c' }],
    });
    const svc = new CoachHomeService(prisma.repo);
    const res = await svc.getDailyRings('coach-1');

    expect(res).toEqual({
      checkIns: { reviewed: 4, submitted: 6 },
      brief: { opened: true },
      review: { reviewed: 2, totalConversations: 3 },
    });
  });

  it('brief.opened is false when no read brief row exists today', async () => {
    setFlag(true);
    const prisma = buildPrisma({ briefOpened: 0 });
    const svc = new CoachHomeService(prisma.repo);
    const res = await svc.getDailyRings('coach-1');
    expect(res.brief.opened).toBe(false);
  });

  // ── (e) zero-row safety ────────────────────────────────────────────────
  it('returns zeros (no throw) for a coach with no data', async () => {
    setFlag(true);
    const prisma = buildPrisma({}); // all default 0 / empty
    const svc = new CoachHomeService(prisma.repo);
    const res = await svc.getDailyRings('coach-empty');
    expect(res).toEqual(zeroedDailyRings());
  });

  it('ignores client_id-null sender rows when counting conversations', async () => {
    setFlag(true);
    const prisma = buildPrisma({
      senderClients: [{ client_id: 'a' }, { client_id: null }, { client_id: 'b' }],
    });
    const svc = new CoachHomeService(prisma.repo);
    const res = await svc.getDailyRings('coach-1');
    expect(res.review.totalConversations).toBe(2);
  });

  // ── (f) no cross-coach leak ─────────────────────────────────────────────
  it('scopes EVERY Prisma read to the calling coach id (no cross-coach leak)', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 1, briefOpened: 1, reviewReviewed: 1 });
    const svc = new CoachHomeService(prisma.repo);
    await svc.getDailyRings('coach-7');

    for (const call of prisma.checkInCount.mock.calls) {
      expect(call[0].where.coach_id).toBe('coach-7');
    }
    expect(prisma.coachBriefCount.mock.calls[0][0].where.coach_id).toBe('coach-7');
    expect(prisma.conversationReviewCount.mock.calls[0][0].where.coach_id).toBe('coach-7');
    expect(prisma.coachMessageFindMany.mock.calls[0][0].where.coach_id).toBe('coach-7');
    // the review-arc "to review" query excludes the coach's own messages
    expect(prisma.coachMessageFindMany.mock.calls[0][0].where.NOT.sender_id).toBe('coach-7');
  });

  it('uses the controller req.user.id as the only coach input', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 2 });
    const svc = new CoachHomeService(prisma.repo);
    const spy = jest.spyOn(svc, 'getDailyRings');
    const ctrl = new CoachHomeController(svc);
    await ctrl.dailyRings(makeReq({ id: 'coach-only', role: 'coach' }));
    expect(spy).toHaveBeenCalledWith('coach-only');
  });

  // ── (h) 30s cache + UTC-day self-invalidation ───────────────────────────
  it('caches the response for 30s — a second call inside the TTL does not re-read Prisma', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3, checkInReviewed: 1 });
    const svc = new CoachHomeService(prisma.repo);
    const t0 = new Date('2026-06-14T10:00:00.000Z');
    const first = await svc.getDailyRings('coach-1', t0);
    const callsAfterFirst = prisma.checkInCount.mock.calls.length;

    // 10s later — within the 30s TTL
    const second = await svc.getDailyRings('coach-1', new Date(t0.getTime() + 10_000));
    expect(second).toEqual(first);
    expect(prisma.checkInCount.mock.calls.length).toBe(callsAfterFirst);
  });

  it('self-invalidates the cache at the UTC day boundary (never serves stale yesterday)', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3 });
    const svc = new CoachHomeService(prisma.repo);
    await svc.getDailyRings('coach-1', new Date('2026-06-14T23:59:50.000Z'));
    const callsDay1 = prisma.checkInCount.mock.calls.length;
    // crossing into the next UTC day → fresh key → re-reads
    await svc.getDailyRings('coach-1', new Date('2026-06-15T00:00:10.000Z'));
    expect(prisma.checkInCount.mock.calls.length).toBeGreaterThan(callsDay1);
  });

  it('re-reads Prisma after the TTL expires', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3 });
    const svc = new CoachHomeService(prisma.repo);
    const t0 = new Date('2026-06-14T10:00:00.000Z');
    await svc.getDailyRings('coach-1', t0);
    const callsAfterFirst = prisma.checkInCount.mock.calls.length;
    await svc.getDailyRings('coach-1', new Date(t0.getTime() + DAILY_RINGS_CACHE_TTL_MS + 1));
    expect(prisma.checkInCount.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // ── (g) CoachGuard role gate ────────────────────────────────────────────
  const guard = new CoachGuard();

  it('is role-guarded: a student is rejected (403)', () => {
    expect(() =>
      guard.canActivate(guardCtx({ id: 's1', role: 'student' })),
    ).toThrow(ForbiddenException);
  });

  it('allows coaches and owners through the guard', () => {
    expect(guard.canActivate(guardCtx({ id: 'c1', role: 'coach' }))).toBe(true);
    expect(guard.canActivate(guardCtx({ id: 'o1', role: 'owner' }))).toBe(true);
  });

  // ── F1 (R79) explicit throttle metadata pin ─────────────────────────────
  it('F1 — dailyRings carries an explicit 60/min @Throttle metadata pin', () => {
    expect(
      Reflect.getMetadata(
        THROTTLER_LIMIT_KEY,
        CoachHomeController.prototype.dailyRings,
      ),
    ).toBe(60);
    expect(
      Reflect.getMetadata(
        THROTTLER_TTL_KEY,
        CoachHomeController.prototype.dailyRings,
      ),
    ).toBe(60_000);
  });

  // ── F2 strict response envelope ─────────────────────────────────────────
  describe('F2 — DailyRingsSchema strict envelope', () => {
    it('accepts the canonical zeroed shape', () => {
      expect(() => DailyRingsSchema.parse(zeroedDailyRings())).not.toThrow();
    });

    it('throws when an extra top-level field is present', () => {
      const widened = { ...zeroedDailyRings(), extra: 1 };
      expect(() => DailyRingsSchema.parse(widened)).toThrow();
    });

    it('throws when an extra nested field is present', () => {
      const base = zeroedDailyRings();
      const widened = {
        ...base,
        checkIns: { ...base.checkIns, sneaky: true },
      };
      expect(() => DailyRingsSchema.parse(widened)).toThrow();
    });
  });

  // ── F4 cache stale-entry pruning ────────────────────────────────────────
  it('F4 — prunes prior-UTC-day entries on a later-day call', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3 });
    const svc = new CoachHomeService(prisma.repo);
    // seed a day-1 entry
    await svc.getDailyRings('coach-1', new Date('2026-06-15T12:00:00.000Z'));
    const map: Map<string, unknown> = (
      svc as unknown as { cache: Map<string, unknown> }
    ).cache;
    expect(map.has('coach-1:2026-06-15')).toBe(true);
    // advance to a later UTC day → the stale day-1 key must be pruned
    await svc.getDailyRings('coach-1', new Date('2026-06-16T09:00:00.000Z'));
    expect(map.has('coach-1:2026-06-15')).toBe(false);
    expect(map.has('coach-1:2026-06-16')).toBe(true);
  });

  // ── F5 telemetry: emit once on flag-ON miss, never on hit or flag-OFF ───
  describe('F5 — coach_daily_rings_fetched telemetry', () => {
    it('captures once on a flag-ON cache MISS with non-PII numeric props', async () => {
      setFlag(true);
      const prisma = buildPrisma({
        checkInSubmitted: 6,
        checkInReviewed: 4,
        briefOpened: 1,
        reviewReviewed: 2,
        senderClients: [{ client_id: 'a' }, { client_id: 'b' }],
      });
      const analytics = new AnalyticsService();
      const capture = jest.spyOn(analytics, 'capture').mockImplementation(() => {});
      const svc = new CoachHomeService(prisma.repo, analytics);
      await svc.getDailyRings('coach-1', new Date('2026-06-16T10:00:00.000Z'));
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith('coach-1', Events.COACH_DAILY_RINGS_FETCHED, {
        checkIns_reviewed: 4,
        checkIns_submitted: 6,
        brief_opened: true,
        review_reviewed: 2,
        review_total: 2,
      });
    });

    it('does NOT capture on a cache HIT', async () => {
      setFlag(true);
      const prisma = buildPrisma({ checkInSubmitted: 3 });
      const analytics = new AnalyticsService();
      const capture = jest.spyOn(analytics, 'capture').mockImplementation(() => {});
      const svc = new CoachHomeService(prisma.repo, analytics);
      const t0 = new Date('2026-06-16T10:00:00.000Z');
      await svc.getDailyRings('coach-1', t0); // miss → 1 capture
      await svc.getDailyRings('coach-1', new Date(t0.getTime() + 5_000)); // hit
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('does NOT capture on the flag-OFF zeroed path', async () => {
      setFlag(false);
      const prisma = buildPrisma({ checkInSubmitted: 3 });
      const analytics = new AnalyticsService();
      const capture = jest.spyOn(analytics, 'capture').mockImplementation(() => {});
      const svc = new CoachHomeService(prisma.repo, analytics);
      await svc.getDailyRings('coach-1');
      expect(capture).not.toHaveBeenCalled();
    });
  });

  // ── feature-flag resolution (default-OFF invariant) ─────────────────────
  describe('isThreeArcCountsEnabled', () => {
    it('exports the canonical env var name', () => {
      expect(KEY).toBe('FEATURE_ROMAN_THREE_ARC_COUNTS');
    });
    it('is OFF when unset', () => {
      expect(isThreeArcCountsEnabled({})).toBe(false);
    });
    it.each(['true', 'TRUE', 'True'])('is ON when exactly %p', (v) => {
      expect(isThreeArcCountsEnabled({ [KEY]: v })).toBe(true);
    });
    it.each(['false', '1', 'yes', '', ' true '])('is OFF for %p', (v) => {
      expect(isThreeArcCountsEnabled({ [KEY]: v })).toBe(false);
    });
  });
});
