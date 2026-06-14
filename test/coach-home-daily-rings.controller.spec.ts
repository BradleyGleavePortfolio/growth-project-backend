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
import { ForbiddenException } from '@nestjs/common';
import { CoachHomeController } from '../src/coach/home/coach-home.controller';
import {
  CoachHomeService,
  zeroedDailyRings,
  DAILY_RINGS_CACHE_TTL_MS,
} from '../src/coach/home/coach-home.service';
import {
  isThreeArcCountsEnabled,
  FEATURE_ROMAN_THREE_ARC_COUNTS_ENV,
} from '../src/coach/home/three-arc-counts.feature';
import { CoachGuard } from '../src/auth/coach.guard';
import { Roles } from '../src/common/decorators/roles.decorator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';

const KEY = FEATURE_ROMAN_THREE_ARC_COUNTS_ENV;

function makeReq(user: any) {
  return { user } as any;
}

/**
 * Minimal Prisma double. `checkIn.count` and `coachBrief.count` are jest fns
 * whose resolved values are driven per-test; `coachMessage.findMany` returns a
 * list of { client_id } rows; `conversationReview.count` returns the reviewed
 * count. Every fn records its `where` so we can assert coach-scoping.
 */
function buildPrisma(opts: {
  checkInSubmitted?: number;
  checkInReviewed?: number;
  briefOpened?: number;
  reviewReviewed?: number;
  senderClients?: Array<{ client_id: string | null }>;
} = {}) {
  const checkInCount = jest.fn(async (args: any) => {
    // reviewed query carries coach_reviewed_at: { not: null }
    if (args?.where?.coach_reviewed_at) return opts.checkInReviewed ?? 0;
    return opts.checkInSubmitted ?? 0;
  });
  const coachBriefCount = jest.fn(async () => opts.briefOpened ?? 0);
  const conversationReviewCount = jest.fn(async () => opts.reviewReviewed ?? 0);
  const coachMessageFindMany = jest.fn(async () => opts.senderClients ?? []);
  return {
    checkIn: { count: checkInCount },
    coachBrief: { count: coachBriefCount },
    conversationReview: { count: conversationReviewCount },
    coachMessage: { findMany: coachMessageFindMany },
  } as any;
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
    const ctrl = new CoachHomeController(new CoachHomeService(prisma));

    const res = await ctrl.dailyRings(makeReq({ id: 'coach-1', role: 'coach' }));

    expect(res).toEqual(zeroedDailyRings());
    expect(prisma.checkIn.count).not.toHaveBeenCalled();
    expect(prisma.coachBrief.count).not.toHaveBeenCalled();
    expect(prisma.conversationReview.count).not.toHaveBeenCalled();
    expect(prisma.coachMessage.findMany).not.toHaveBeenCalled();
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
    const svc = new CoachHomeService(prisma);
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
    const svc = new CoachHomeService(prisma);
    const res = await svc.getDailyRings('coach-1');
    expect(res.brief.opened).toBe(false);
  });

  // ── (e) zero-row safety ────────────────────────────────────────────────
  it('returns zeros (no throw) for a coach with no data', async () => {
    setFlag(true);
    const prisma = buildPrisma({}); // all default 0 / empty
    const svc = new CoachHomeService(prisma);
    const res = await svc.getDailyRings('coach-empty');
    expect(res).toEqual(zeroedDailyRings());
  });

  it('ignores client_id-null sender rows when counting conversations', async () => {
    setFlag(true);
    const prisma = buildPrisma({
      senderClients: [{ client_id: 'a' }, { client_id: null }, { client_id: 'b' }],
    });
    const svc = new CoachHomeService(prisma);
    const res = await svc.getDailyRings('coach-1');
    expect(res.review.totalConversations).toBe(2);
  });

  // ── (f) no cross-coach leak ─────────────────────────────────────────────
  it('scopes EVERY Prisma read to the calling coach id (no cross-coach leak)', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 1, briefOpened: 1, reviewReviewed: 1 });
    const svc = new CoachHomeService(prisma);
    await svc.getDailyRings('coach-7');

    for (const call of (prisma.checkIn.count as jest.Mock).mock.calls) {
      expect(call[0].where.coach_id).toBe('coach-7');
    }
    expect((prisma.coachBrief.count as jest.Mock).mock.calls[0][0].where.coach_id).toBe('coach-7');
    expect((prisma.conversationReview.count as jest.Mock).mock.calls[0][0].where.coach_id).toBe('coach-7');
    expect((prisma.coachMessage.findMany as jest.Mock).mock.calls[0][0].where.coach_id).toBe('coach-7');
    // the review-arc "to review" query excludes the coach's own messages
    expect((prisma.coachMessage.findMany as jest.Mock).mock.calls[0][0].where.NOT.sender_id).toBe('coach-7');
  });

  it('uses the controller req.user.id as the only coach input', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 2 });
    const svc = new CoachHomeService(prisma);
    const spy = jest.spyOn(svc, 'getDailyRings');
    const ctrl = new CoachHomeController(svc);
    await ctrl.dailyRings(makeReq({ id: 'coach-only', role: 'coach' }));
    expect(spy).toHaveBeenCalledWith('coach-only');
  });

  // ── (h) 30s cache + UTC-day self-invalidation ───────────────────────────
  it('caches the response for 30s — a second call inside the TTL does not re-read Prisma', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3, checkInReviewed: 1 });
    const svc = new CoachHomeService(prisma);
    const t0 = new Date('2026-06-14T10:00:00.000Z');
    const first = await svc.getDailyRings('coach-1', t0);
    const callsAfterFirst = (prisma.checkIn.count as jest.Mock).mock.calls.length;

    // 10s later — within the 30s TTL
    const second = await svc.getDailyRings('coach-1', new Date(t0.getTime() + 10_000));
    expect(second).toEqual(first);
    expect((prisma.checkIn.count as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
  });

  it('self-invalidates the cache at the UTC day boundary (never serves stale yesterday)', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3 });
    const svc = new CoachHomeService(prisma);
    await svc.getDailyRings('coach-1', new Date('2026-06-14T23:59:50.000Z'));
    const callsDay1 = (prisma.checkIn.count as jest.Mock).mock.calls.length;
    // crossing into the next UTC day → fresh key → re-reads
    await svc.getDailyRings('coach-1', new Date('2026-06-15T00:00:10.000Z'));
    expect((prisma.checkIn.count as jest.Mock).mock.calls.length).toBeGreaterThan(callsDay1);
  });

  it('re-reads Prisma after the TTL expires', async () => {
    setFlag(true);
    const prisma = buildPrisma({ checkInSubmitted: 3 });
    const svc = new CoachHomeService(prisma);
    const t0 = new Date('2026-06-14T10:00:00.000Z');
    await svc.getDailyRings('coach-1', t0);
    const callsAfterFirst = (prisma.checkIn.count as jest.Mock).mock.calls.length;
    await svc.getDailyRings('coach-1', new Date(t0.getTime() + DAILY_RINGS_CACHE_TTL_MS + 1));
    expect((prisma.checkIn.count as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // ── (g) CoachGuard role gate ────────────────────────────────────────────
  const guard = new CoachGuard();
  const ctx = (user: any) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

  it('is role-guarded: a student is rejected (403)', () => {
    expect(() => guard.canActivate(ctx({ id: 's1', role: 'student' }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows coaches and owners through the guard', () => {
    expect(guard.canActivate(ctx({ id: 'c1', role: 'coach' }))).toBe(true);
    expect(guard.canActivate(ctx({ id: 'o1', role: 'owner' }))).toBe(true);
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
