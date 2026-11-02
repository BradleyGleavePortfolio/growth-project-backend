/**
 * FR-1195R3 F1 (LS-1195R3 B1, ruling R10): the history read shows today's
 * brief by the same hold gate as today's read; earlier days stay as written.
 * FR-1195R3 F2 (LO-1195R3 C1, ruling R-1195-C1): PF-W9 counts only renewals
 * held on the coach's own Stripe account; a head coach's brief does not count
 * a hold on a sub-coach's account, the sub-coach's own brief does.
 * PF-W9 and PF-W1 as approved; no new words.
 */
import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  buildFallbackNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import type { BriefContext, BriefContextHeadCoach } from '../src/coach/brief/coach-brief.types';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import {
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeHeadCoachContext,
  makeMockConfig,
  makeMockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

// 09:00 in Los Angeles on 2026-10-05 (the coach has no zone set).
const MORNING = new Date('2026-10-05T16:00:00.000Z');
const LATER = new Date('2026-10-05T22:00:00.000Z');
const TODAY = '2026-10-05';
const EARLIER = '2026-10-04';
const PF_W1_CARD = 'TGP is reminding the client to update their card.';
const PF_W9 = coachAccountWaitingLine(1);

type Live = { failing: number; waiting: number };

function storedRow(id: string, briefDate: string, context: BriefContext | BriefContextHeadCoach, scope: string[], mode = 'solo_coach') {
  return {
    id,
    coach_id: 'coach-1',
    brief_date: briefDate,
    status: 'generated',
    generated_at: MORNING,
    generation_started_at: null,
    narrative: withCoachAccountWaiting(buildFallbackNarrative(context), context),
    brief_context: { ...context, scope_client_ids: scope },
    action_items: [],
    generated_by: 'fallback',
    brief_mode: mode,
    created_at: MORNING,
  };
}

/** A solo coach whose history page holds today's brief and, if given, an earlier one. */
function soloWorld(today: BriefContext | null, earlier: BriefContext | null, live: Live) {
  let todayRow: Record<string, unknown> | null = today ? storedRow('brief-today', TODAY, today, ['client-1']) : null;
  const earlierRow = earlier ? storedRow('brief-earlier', EARLIER, earlier, ['client-1']) : null;
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: 'coach-1', clientIds: ['client-1'] });
  prisma.user.findMany.mockReset().mockResolvedValue([
    { id: 'client-1', coach_id: 'coach-1', created_at: MORNING, name: 'Review Buyer' },
  ]);
  prisma.user.findUnique.mockResolvedValue({ name: 'Review Coach', role: 'coach' });
  prisma.coachBrief.findMany.mockImplementation(async () => [todayRow, earlierRow].filter(Boolean));
  prisma.coachBrief.count.mockImplementation(async () => [todayRow, earlierRow].filter(Boolean).length);
  prisma.coachBrief.findUnique.mockImplementation(async () => todayRow);
  const save = async ({ data }: { data: object }) => (todayRow = { ...todayRow, ...data });
  prisma.coachBrief.create.mockImplementation(save);
  prisma.coachBrief.update.mockImplementation(save);
  prisma.coachBrief.updateMany.mockImplementation(async (args: { data: object }) => {
    await save(args);
    return { count: 1 };
  });
  const dunningQueries: Prisma.Sql[] = [];
  prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
    if (!query.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n, mrr_cents: 0n }];
    dunningQueries.push(query);
    return [{
      count: BigInt(live.failing),
      total: BigInt(live.failing * 15000),
      locked: 0n,
      locked_total: 0n,
      on_hold: 0n,
      waiting: BigInt(live.waiting),
    }];
  });
  const service = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  return { prisma, service, dunningQueries, earlierRow };
}

// Held renewals: one on the head coach's own Stripe account, one on a
// seated sub-coach's (he sells on his own account to a team client).
const HELD = [
  { seller: 'coach-1', client: 'buyer-a' },
  { seller: 'sub-1', client: 'buyer-b' },
];

/** Counts HELD the way the dunning brief SQL scopes it (sellers, clients, owner). */
function heldBySql(query: Prisma.Sql): number {
  let owner: unknown;
  let sellers: unknown[] | undefined;
  let clients: unknown[] | undefined;
  query.values.forEach((value, i) => {
    const before = query.strings[i];
    if (before.endsWith('IS NULL AND cp."coach_user_id" = ')) owner = value;
    else if (before.endsWith('cp."coach_user_id" = ANY(')) sellers = value as unknown[];
    else if (before.endsWith('cp."client_user_id" = ANY(')) clients = value as unknown[];
    else if (before.endsWith('cp."coach_user_id" = ')) sellers = [value];
  });
  return HELD.filter(
    (h) =>
      (!sellers || sellers.includes(h.seller)) &&
      (!clients || clients.includes(h.client)) &&
      (owner === undefined || h.seller === owner),
  ).length;
}

/** A head coach (coach-1) with a seated sub-coach (sub-1) and two team clients. */
function headWorld(stored: BriefContextHeadCoach) {
  let row: Record<string, unknown> = storedRow('brief-head', TODAY, stored, ['buyer-a', 'buyer-b'], 'head_coach');
  const prisma = makeMockPrisma();
  prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
  prisma.teamSubCoachAssignment.count.mockResolvedValue(1);
  prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
    { sub_coach_id: 'sub-1', sub_coach: { id: 'sub-1', name: 'Review Sub' } },
  ]);
  prisma.subCoachAssignment.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ name: 'Review Head', role: 'coach' });
  prisma.user.findMany.mockResolvedValue([
    { id: 'buyer-a', coach_id: 'coach-1', created_at: MORNING },
    { id: 'buyer-b', coach_id: 'coach-1', created_at: MORNING },
  ]);
  prisma.chargeSettlement.aggregate.mockResolvedValue({ _sum: { gross_cents: 0 }, _count: { _all: 0 } });
  prisma.coachBrief.findMany.mockImplementation(async () => [row]);
  prisma.coachBrief.count.mockResolvedValue(1);
  prisma.coachBrief.findUnique.mockImplementation(async () => row);
  const save = async ({ data }: { data: object }) => (row = { ...row, ...data });
  prisma.coachBrief.create.mockImplementation(save);
  prisma.coachBrief.update.mockImplementation(save);
  prisma.coachBrief.updateMany.mockImplementation(async (args: { data: object }) => {
    await save(args);
    return { count: 1 };
  });
  prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
    if (!query.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n, mrr_cents: 0n }];
    return [{ count: 0n, total: 0n, locked: 0n, locked_total: 0n, on_hold: 0n, waiting: BigInt(heldBySql(query)) }];
  });
  const service = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  return { prisma, service };
}

describe('FR-1195R3 F1: the history read shows today by the same hold gate', () => {
  beforeEach(() => jest.useFakeTimers({ now: LATER, doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => jest.useRealTimers());

  it('the hold starts after today\'s brief: history read twice shows PF-W9 both times, no PF-W1, written once', async () => {
    const live: Live = { failing: 0, waiting: 1 };
    const today = makeBriefContext({ date: TODAY, roster_size: 1, dunning_in_progress: 1 });
    const w = soloWorld(today, null, live);

    const first = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(first.items[0].summary?.narrative).toContain(PF_W9);
    expect(first.items[0].summary?.narrative).not.toContain(PF_W1_CARD);
    expect(first.items[0].summary?.brief_context.coach_account_waiting).toBe(1);
    const writes = w.prisma.coachBrief.updateMany.mock.calls.length;
    expect(writes).toBeGreaterThan(0);

    const second = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(second.items[0].summary?.narrative).toContain(PF_W9);
    expect(second.items[0].summary?.narrative).not.toContain(PF_W1_CARD);
    expect(second.items[0].summary?.narrative).toBe(first.items[0].summary?.narrative);
    expect(w.prisma.coachBrief.updateMany.mock.calls.length).toBe(writes);
  });

  it('the hold ends after today\'s brief: history drops PF-W9 for today', async () => {
    const live: Live = { failing: 0, waiting: 0 };
    const today = makeBriefContext({ date: TODAY, roster_size: 1, coach_account_waiting: 1 });
    const w = soloWorld(today, null, live);

    const out = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(out.items[0].summary?.narrative).not.toContain(PF_W9);
    expect(out.items[0].summary?.narrative).not.toContain(PF_W1_CARD);
    expect(out.items[0].summary?.brief_context.coach_account_waiting).toBeUndefined();
  });

  it('an earlier day\'s history row stays as written while today\'s follows the hold', async () => {
    const live: Live = { failing: 0, waiting: 1 };
    const today = makeBriefContext({ date: TODAY, roster_size: 1, dunning_in_progress: 1 });
    const earlier = makeBriefContext({ date: EARLIER, roster_size: 1, dunning_in_progress: 1 });
    const w = soloWorld(today, earlier, live);
    const before = w.earlierRow?.narrative;

    const out = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].summary?.narrative).toContain(PF_W9);
    expect(out.items[1].brief_date).toBe(EARLIER);
    expect(out.items[1].summary?.narrative).toBe(before);
    expect(out.items[1].summary?.narrative).toContain(PF_W1_CARD);
    expect(out.items[1].summary?.narrative).not.toContain(PF_W9);
    for (const call of w.prisma.coachBrief.updateMany.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(EARLIER);
    }
  });

  it('the history read writes nothing when the hold has not changed', async () => {
    const live: Live = { failing: 1, waiting: 0 };
    const today = makeBriefContext({ date: TODAY, roster_size: 1, dunning_in_progress: 1 });
    const w = soloWorld(today, null, live);
    const out = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(out.items[0].summary?.narrative).toContain(PF_W1_CARD);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(w.dunningQueries).toHaveLength(1);
  });
});

describe('FR-1195R3 F2: PF-W9 counts only renewals held on the coach\'s own Stripe account', () => {
  beforeEach(() => jest.useFakeTimers({ now: LATER, doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => jest.useRealTimers());

  it('head coach with one hold on his own account and one on a sub-coach\'s: his brief counts 1', async () => {
    const w = headWorld(makeHeadCoachContext({ date: TODAY, dunning_in_progress: 0, dunning_amount_cents: 0 }));
    const { context } = await w.service['aggregateHeadCoachContext']('coach-1', 'America/Los_Angeles', TODAY);
    expect(context.coach_account_waiting).toBe(1);
    expect(buildFallbackNarrative(context)).toContain(PF_W9);
    expect(buildFallbackNarrative(context)).not.toContain(coachAccountWaitingLine(2));
  });

  it('the head coach\'s history read of today follows his own hold only', async () => {
    const w = headWorld(makeHeadCoachContext({ date: TODAY, dunning_in_progress: 0, dunning_amount_cents: 0 }));
    const out = await w.service.getBriefHistory('coach-1', 1, 10);
    expect(out.items[0].summary?.narrative).toContain(PF_W9);
    expect(out.items[0].summary?.narrative).not.toContain(coachAccountWaitingLine(2));
    expect(out.items[0].summary?.brief_context.coach_account_waiting).toBe(1);
    // Stored count now equals his own live count: the next read keeps it.
    const writes = w.prisma.coachBrief.updateMany.mock.calls.length;
    await w.service.getBriefHistory('coach-1', 1, 10);
    expect(w.prisma.coachBrief.updateMany.mock.calls.length).toBe(writes);
  });

  it('a head brief stored with his own count is not written again for a sub-coach\'s hold', async () => {
    const w = headWorld(makeHeadCoachContext({
      date: TODAY, dunning_in_progress: 0, dunning_amount_cents: 0, coach_account_waiting: 1,
    }));
    const out = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(out.summary?.narrative).toContain(PF_W9);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
  });

  it('the sub-coach\'s own brief counts the hold on his account', async () => {
    const prisma = makeMockPrisma();
    wireSoloDefaults(prisma, { coachId: 'sub-1', clientIds: ['buyer-b'] });
    prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (!query.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n }];
      return [{ count: 0n, total: 0n, locked: 0n, locked_total: 0n, on_hold: 0n, waiting: BigInt(heldBySql(query)) }];
    });
    const service = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
    const agg = await service['aggregateSoloContext']('sub-1', ['buyer-b'], 'America/Los_Angeles', TODAY, 'sub_coach');
    expect(agg.context.coach_account_waiting).toBe(1);
    expect(buildFallbackNarrative(agg.context)).toContain(PF_W9);
  });
});
