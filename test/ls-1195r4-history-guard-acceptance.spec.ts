import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  buildFallbackNarrative,
  dunningBriefSql,
} from '../src/coach/brief/coach-brief.service';
import {
  COACH_ACCOUNT_HOLD_REASON,
  coachAccountWaitingLine,
} from '../src/checkout/dunning-v2/coach-account-hold';
import {
  DUNNING_V2_REVERSAL_REASON,
  FULL_REFUND_PAUSE_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import type { ConsentService } from '../src/consent/consent.service';
import {
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeMockConfig,
  makeMockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

const COACH = 'review-coach';
const CLIENT = 'review-client';
const DAY = '2026-10-05';
const NOW = new Date('2026-10-05T22:00:00.000Z');
const SAVED_AT = new Date('2026-10-05T16:00:00.000Z');

function world(day = DAY) {
  const state = {
    withdrawnAt: null as Date | null,
    moved: false,
    blocked: false,
    waiting: 1,
  };
  const context = makeBriefContext({
    date: day,
    roster_size: 1,
    dunning_in_progress: 1,
    coach_account_waiting: 0,
  });
  let row: Record<string, unknown> = {
    id: 'review-brief',
    coach_id: COACH,
    brief_date: day,
    status: 'generated',
    generated_at: SAVED_AT,
    generation_started_at: null,
    narrative: buildFallbackNarrative(context),
    brief_context: { ...context, scope_client_ids: [CLIENT] },
    action_items: [],
    generated_by: 'fallback',
    brief_mode: 'solo_coach',
    created_at: SAVED_AT,
  };
  const prisma = {
    ...makeMockPrisma(),
    clientCoachConsent: {
      findFirst: jest.fn(async () =>
        state.withdrawnAt ? { revoked_at: state.withdrawnAt } : null,
      ),
    },
  };
  wireSoloDefaults(prisma, { coachId: COACH, clientIds: [CLIENT] });
  prisma.user.findUnique.mockResolvedValue({ name: 'Review Coach', role: 'coach' });
  prisma.user.findMany.mockReset().mockImplementation(async ({ where }) => {
    if (where.check_ins || where.onboarding_intake) return [];
    return state.moved
      ? []
      : [{ id: CLIENT, coach_id: COACH, name: 'Review Client', created_at: SAVED_AT }];
  });
  prisma.coachBrief.findMany.mockImplementation(async () => [{ ...row }]);
  prisma.coachBrief.count.mockResolvedValue(1);
  prisma.coachBrief.findUnique.mockImplementation(async () => ({ ...row }));
  const save = async ({ data }: { data: object }) => (row = { ...row, ...data });
  prisma.coachBrief.updateMany.mockImplementation(async (args: { data: object }) => {
    await save(args);
    return { count: 1 };
  });
  prisma.coachBrief.create.mockImplementation(save);
  prisma.coachBrief.update.mockImplementation(save);
  prisma.userBlock.findMany.mockImplementation(async () =>
    state.blocked
      ? [{ blocker_id: COACH, blocked_id: CLIENT, created_at: new Date(NOW.getTime() + 1) }]
      : [],
  );
  prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes('"DunningState"')
      ? [{ count: 0n, total: 0n, locked: 0n, locked_total: 0n, on_hold: 0n, waiting: BigInt(state.waiting) }]
      : [],
  );
  const consent = fakeOf<ConsentService>({
    grantedScopesByClient: async (_coach: string, ids: readonly string[], scopes: readonly string[]) =>
      new Map(ids.map((id) => [id, new Set(scopes)])),
  });
  const service = new CoachBriefService(
    asPrismaService(prisma),
    asConfig(makeMockConfig()),
    grantAllEgress(),
    undefined,
    consent,
  );
  const narrative = jest.spyOn(service, 'callClaude').mockImplementation(async (ctx) => ({
    narrative: buildFallbackNarrative(ctx),
    generated_by: 'fallback',
  }));
  return { state, prisma, service, narrative, row: () => ({ ...row }) };
}

describe('LS-1195R4 independent history rewrite boundary acceptance', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['sharing', 'moved', 'block'] as const)(
    'checks the %s guard after reading the rewritten row back',
    async (guard) => {
      const w = world();
      w.prisma.coachBrief.update.mockImplementation(async ({ data }: { data: object }) => {
        const rewritten = { ...w.row(), ...data };
        if (guard === 'sharing') w.state.withdrawnAt = new Date(NOW.getTime() + 1);
        if (guard === 'moved') w.state.moved = true;
        if (guard === 'block') w.state.blocked = true;
        w.prisma.coachBrief.findUnique.mockResolvedValue(rewritten);
        return rewritten;
      });

      const out = await w.service.getBriefHistory(COACH, 1, 10);

      expect(w.narrative).toHaveBeenCalledTimes(1);
      expect(w.prisma.coachBrief.update).toHaveBeenCalledTimes(1);
      expect(out.items[0].status).toBe('generated');
      expect(out.items[0].summary).toBeNull();
      expect(out.total).toBe(1);
      expect(out.page).toBe(1);
      expect(out.limit).toBe(10);
      expect(w.prisma.coachBrief.findUnique).toHaveBeenCalledWith({
        where: { CoachBrief_coach_date_key: { coach_id: COACH, brief_date: DAY } },
      });
    },
  );

  it('a history rewrite never touches the scheduler push ledger', async () => {
    const w = world();
    const out = await w.service.getBriefHistory(COACH, 2, 7);

    expect(out.items[0].summary?.narrative).toContain(coachAccountWaitingLine(1));
    expect(out.items[0].summary?.narrative).not.toContain('update their card');
    expect(w.prisma.coachBriefPushLedger.upsert).not.toHaveBeenCalled();
    expect(w.prisma.coachBriefPushLedger.updateMany).not.toHaveBeenCalled();
    expect(w.prisma.coachBrief.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 7,
      take: 7,
      where: expect.objectContaining({ coach_id: COACH }),
    }));
  });

  it('a count-query failure rejects instead of returning the obsolete card text', async () => {
    const w = world();
    w.prisma.$queryRaw.mockRejectedValueOnce(new Error('review count unavailable'));

    await expect(w.service.getBriefHistory(COACH, 1, 10)).rejects.toThrow('review count unavailable');
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(w.narrative).not.toHaveBeenCalled();
  });

  it('a failed rewrite rejects instead of falling back to the old summary', async () => {
    const w = world();
    w.prisma.coachBrief.update.mockRejectedValueOnce(new Error('review write unavailable'));

    await expect(w.service.getBriefHistory(COACH, 1, 10)).rejects.toThrow('review write unavailable');
    expect(w.prisma.coachBrief.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ coach_id: COACH, brief_date: DAY, status: 'generating' }),
      data: { status: 'failed', generation_started_at: null },
    }));
  });

  it('the coach-local previous day never queries or rewrites despite a hold change', async () => {
    // UTC is already October 6, but the coach in Los Angeles is still on October 5.
    jest.setSystemTime(new Date('2026-10-06T03:30:00.000Z'));
    const w = world('2026-10-04');
    const out = await w.service.getBriefHistory(COACH, 1, 10);

    expect(out.items[0].brief_date).toBe('2026-10-04');
    expect(out.items[0].summary?.narrative).toContain('update their card');
    expect(w.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
  });

  it('the coach-local today is refreshed even when its UTC date is yesterday', async () => {
    jest.setSystemTime(new Date('2026-10-06T03:30:00.000Z'));
    const w = world();
    const out = await w.service.getBriefHistory(COACH, 1, 10);

    expect(out.items[0].brief_date).toBe(DAY);
    expect(out.items[0].summary?.narrative).toContain(coachAccountWaitingLine(1));
    expect(w.narrative).toHaveBeenCalledTimes(1);
  });

  it('two readers of the same stale snapshot take one force lease and one narrative', async () => {
    const w = world();
    const stale = w.row();
    w.prisma.coachBrief.findMany
      .mockResolvedValueOnce([{ ...stale }])
      .mockResolvedValueOnce([{ ...stale }]);
    let claimed = false;
    w.prisma.coachBrief.updateMany.mockImplementation(async ({ data }: { data: object }) => {
      if (claimed) return { count: 0 };
      claimed = true;
      w.prisma.coachBrief.findUnique.mockResolvedValue({
        ...stale, ...data,
      });
      return { count: 1 };
    });
    w.prisma.coachBrief.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'review unique row',
      { code: 'P2002', clientVersion: 'review' },
    ));
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    w.narrative.mockImplementation(async (ctx) => {
      entered();
      await waiting;
      return { narrative: buildFallbackNarrative(ctx), generated_by: 'fallback' };
    });
    w.prisma.coachBrief.update.mockImplementation(async ({ data }: { data: object }) => {
      const rewritten = { ...stale, ...data };
      w.prisma.coachBrief.findUnique.mockResolvedValue(rewritten);
      return rewritten;
    });

    const first = w.service.getBriefHistory(COACH, 1, 10);
    const second = w.service.getBriefHistory(COACH, 1, 10);
    await started;
    const inFlight = await second;
    expect(inFlight.items[0].status).toBe('generating');
    expect(inFlight.items[0].summary).toBeNull();
    release();
    const finished = await first;

    expect(finished.items[0].summary?.narrative).toContain(coachAccountWaitingLine(1));
    expect(w.narrative).toHaveBeenCalledTimes(1);
    expect(w.prisma.coachBrief.update).toHaveBeenCalledTimes(1);
  });
});

// The no-owner helper as it stood at c6db75ed. This independent baseline
// pins text and parameters, not just a regular expression over the query.
function priorRoundDunningSql(scope: Prisma.Sql): Prisma.Sql {
  const held = Prisma.sql`ds."last_failure_reason" IS NOT DISTINCT FROM ${COACH_ACCOUNT_HOLD_REASON}`;
  const onHold = Prisma.sql`COALESCE(ds."last_failure_reason", '') IN (${DUNNING_V2_REVERSAL_REASON}, ${FULL_REFUND_PAUSE_REASON})`;
  const inWindow = Prisma.sql`NOT (${onHold}) AND ds."locked_out_at" IS NULL AND ds."client_canceled_at" IS NULL AND NOT (${held})`;
  const locked = Prisma.sql`NOT (${onHold}) AND ds."locked_out_at" IS NOT NULL AND NOT (${held})`;
  return Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE ${inWindow})::bigint AS count,
      COALESCE(SUM(ds."last_failed_amount_cents") FILTER (WHERE ${inWindow}), 0)::bigint AS total,
      COUNT(*) FILTER (WHERE ${locked})::bigint AS locked,
      COALESCE(SUM(ds."last_failed_amount_cents") FILTER (WHERE ${locked}), 0)::bigint AS locked_total,
      COUNT(*) FILTER (WHERE ${onHold})::bigint AS on_hold,
      COUNT(*) FILTER (WHERE ${held} AND ds."client_canceled_at" IS NULL)::bigint AS waiting
    FROM "DunningState" ds
    JOIN "ClientPurchase" cp ON cp."id" = ds."purchase_id"
    WHERE ds."status" = 'active'
      AND ${scope}
  `;
}

describe('LS-1195R4 independent SQL compatibility acceptance', () => {
  it.each([
    Prisma.sql`cp."coach_user_id" = ${COACH}`,
    Prisma.sql`cp."client_user_id" = ANY(${[CLIENT]}::text[]) AND cp."coach_user_id" = ANY(${[COACH, 'review-sub']}::text[])`,
  ])('preserves prior-round SQL text and values without an owner', (scope) => {
    const expected = priorRoundDunningSql(scope);
    const actual = dunningBriefSql(scope);
    expect(actual.sql).toBe(expected.sql);
    expect(actual.text).toBe(expected.text);
    expect(actual.values).toEqual(expected.values);
  });

  it('limits only the waiting FILTER when the owner is supplied', () => {
    const scope = Prisma.sql`cp."client_user_id" = ANY(${[CLIENT]}::text[]) AND cp."coach_user_id" = ANY(${[COACH, 'review-sub']}::text[])`;
    const baseline = dunningBriefSql(scope);
    const owned = dunningBriefSql(scope, COACH);
    const clause = ' AND cp."coach_user_id" = ?';
    expect(owned.sql).toBe(baseline.sql.replace(
      'ds."client_canceled_at" IS NULL)::bigint AS waiting',
      `ds."client_canceled_at" IS NULL${clause})::bigint AS waiting`,
    ));
    const beforeScope = baseline.values.length - scope.values.length;
    expect(owned.values).toEqual([
      ...baseline.values.slice(0, beforeScope),
      COACH,
      ...baseline.values.slice(beforeScope),
    ]);
  });
});
