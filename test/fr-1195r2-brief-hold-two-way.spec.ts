/**
 * FR-1195R2 F3 (LS-1195R2 B3, operator ruling R10, two-way): a brief for
 * today that was written before one of the coach's renewals entered or left
 * the hold is written again on its next read, the way a brief written before
 * a sharing change already is (B-872-SOL-130-1). Briefs of earlier days stay
 * as written. PF-W9 and PF-W1 as approved; no new words.
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
const PF_W1_CARD = 'TGP is reminding the client to update their card.';
const PF_W9 = coachAccountWaitingLine(1);

type Live = { failing: number; waiting: number };

function world(
  stored: { brief_date: string; context: BriefContext | BriefContextHeadCoach; mode?: string },
  live: Live,
) {
  const narrative = withCoachAccountWaiting(buildFallbackNarrative(stored.context), stored.context);
  let row: Record<string, unknown> = {
    id: 'brief-1',
    coach_id: 'coach-1',
    brief_date: stored.brief_date,
    status: 'generated',
    generated_at: MORNING,
    generation_started_at: null,
    narrative,
    brief_context: { ...stored.context, scope_client_ids: ['client-1'] },
    action_items: [],
    generated_by: 'fallback',
    brief_mode: stored.mode ?? 'solo_coach',
    created_at: MORNING,
  };
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: 'coach-1', clientIds: ['client-1'] });
  prisma.user.findMany.mockReset().mockResolvedValue([
    { id: 'client-1', coach_id: 'coach-1', created_at: MORNING, name: 'Review Buyer' },
  ]);
  prisma.user.findUnique.mockResolvedValue({ name: 'Review Coach' });
  prisma.coachBrief.findUnique.mockImplementation(async () => row);
  const save = async ({ data }: { data: object }) => (row = { ...row, ...data });
  prisma.coachBrief.create.mockImplementation(save);
  prisma.coachBrief.update.mockImplementation(save);
  prisma.coachBrief.updateMany.mockImplementation(async (args: { data: object }) => {
    await save(args);
    return { count: 1 };
  });
  const dunningQueries: Prisma.Sql[] = [];
  prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
    if (!query.strings.join('?').includes('"DunningState"')) {
      return [{ count: 0n, total: 0n, mrr_cents: 0n }];
    }
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
  return { prisma, service, dunningQueries, row: () => row };
}

describe('FR-1195R2 F3: today\'s brief follows the hold both ways; earlier days stay', () => {
  beforeEach(() => jest.useFakeTimers({ now: MORNING, doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => jest.useRealTimers());

  it('written in the morning, the hold starts later that day: the next read shows PF-W9 and no PF-W1 for it', async () => {
    const live: Live = { failing: 1, waiting: 0 };
    const context = makeBriefContext({ date: TODAY, roster_size: 1, dunning_in_progress: 1 });
    const w = world({ brief_date: TODAY, context }, live);

    const morning = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(morning.summary?.narrative).toContain(PF_W1_CARD);
    expect(morning.summary?.narrative).not.toContain(PF_W9);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();

    jest.setSystemTime(LATER);
    live.failing = 0;
    live.waiting = 1;
    const after = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(after.summary?.narrative).toContain(PF_W9);
    expect(after.summary?.narrative).not.toContain(PF_W1_CARD);
    expect(after.summary?.brief_context.coach_account_waiting).toBe(1);
    expect(after.summary?.brief_context.dunning_in_progress).toBe(0);

    // Written once: the read after that keeps it.
    const calls = w.prisma.coachBrief.updateMany.mock.calls.length;
    const again = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(again.summary?.narrative).toBe(after.summary?.narrative);
    expect(w.prisma.coachBrief.updateMany.mock.calls.length).toBe(calls);
  });

  it('the hold ends after the brief was written: the next read drops PF-W9', async () => {
    const live: Live = { failing: 0, waiting: 1 };
    const context = makeBriefContext({ date: TODAY, roster_size: 1, coach_account_waiting: 1 });
    const w = world({ brief_date: TODAY, context }, live);

    const held = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(held.summary?.narrative).toContain(PF_W9);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();

    jest.setSystemTime(LATER);
    live.waiting = 0;
    const after = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(after.summary?.narrative).not.toContain(PF_W9);
    expect(after.summary?.narrative).not.toContain(PF_W1_CARD);
    expect(after.summary?.brief_context.coach_account_waiting).toBeUndefined();
  });

  it('a brief of an earlier day stays as written when the hold changes', async () => {
    const live: Live = { failing: 0, waiting: 1 };
    const context = makeBriefContext({ date: '2026-10-04', roster_size: 1, dunning_in_progress: 1 });
    const w = world({ brief_date: '2026-10-04', context }, live);
    const before = w.row().narrative;

    jest.setSystemTime(LATER);
    const out = await w.service.generateBrief('coach-1', 'America/Los_Angeles', '2026-10-04');
    expect(out.summary?.narrative).toBe(before);
    expect(out.summary?.narrative).not.toContain(PF_W9);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(w.dunningQueries).toHaveLength(0);
  });

  it("a head coach's brief is counted by the clients it was built from and the team's sellers", async () => {
    const live: Live = { failing: 0, waiting: 1 };
    const context = makeHeadCoachContext({ date: TODAY, dunning_in_progress: 0, dunning_amount_cents: 0, coach_account_waiting: 1 });
    const w = world({ brief_date: TODAY, context, mode: 'head_coach' }, live);
    w.prisma.teamSubCoachAssignment.findMany.mockResolvedValue([{ sub_coach_id: 'sub-1' }]);

    const out = await w.service.getOrGenerateTodaysBrief('coach-1');
    expect(out.summary?.narrative).toContain(PF_W9);
    expect(w.prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(w.dunningQueries).toHaveLength(1);
    expect(w.dunningQueries[0].values).toEqual(expect.arrayContaining([['client-1'], ['coach-1', 'sub-1']]));
  });
});
