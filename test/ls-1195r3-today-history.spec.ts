import { Prisma } from '@prisma/client';
import { CoachBriefService, buildFallbackNarrative } from '../src/coach/brief/coach-brief.service';
import { COACH_ACCOUNT_HOLD_REASON, coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import {
  asConfig, asPrismaService, makeBriefContext, makeMockConfig, makeMockPrisma, wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { RESTRICTED, T0, buildWorld } from './support/pf7-hold-world';

describe('LS-1195R3 current-day history reader class check', () => {
  const savedV2 = process.env['FEATURE_DUNNING_V2'];
  const savedHold = process.env['FEATURE_COACH_ACCOUNT_HOLD'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (savedV2 === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = savedV2;
    if (savedHold === undefined) delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    else process.env['FEATURE_COACH_ACCOUNT_HOLD'] = savedHold;
  });

  it('the history API reading today does not return an obsolete client-card-reminder summary', async () => {
    const w = buildWorld();
    await w.fail();
    const context = makeBriefContext({
      coach_name: 'Review Coach', coach_first_name: 'Review', roster_size: 1,
      dunning_in_progress: 1, coach_account_waiting: 0,
    });
    let stored: Record<string, unknown> = {
      id: 'brief-current-day-history', coach_id: 'coach-1', brief_date: '2026-10-05',
      status: 'generated', generated_at: T0, generation_started_at: null,
      narrative: buildFallbackNarrative(context),
      brief_context: { ...context, scope_client_ids: ['client-1'] },
      action_items: [], generated_by: 'fallback', brief_mode: 'solo_coach', created_at: T0,
    };
    const prisma = makeMockPrisma();
    wireSoloDefaults(prisma, { coachId: 'coach-1', clientIds: ['client-1'] });
    prisma.user.findUnique.mockResolvedValue({ name: 'Review Coach', role: 'coach' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'client-1', coach_id: 'coach-1', created_at: T0, name: 'Review Buyer' },
    ]);
    prisma.coachBrief.findMany.mockImplementation(async () => [stored]);
    prisma.coachBrief.count.mockResolvedValue(1);
    prisma.coachBrief.findUnique.mockImplementation(async () => stored);
    const save = async ({ data }: { data: object }) => (stored = { ...stored, ...data });
    prisma.coachBrief.create.mockImplementation(save);
    prisma.coachBrief.update.mockImplementation(save);
    prisma.coachBrief.updateMany.mockImplementation(async (args: { data: object }) => {
      await save(args);
      return { count: 1 };
    });
    prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (!query.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n }];
      const held = w.state()?.last_failure_reason === COACH_ACCOUNT_HOLD_REASON;
      return [{ count: held ? 0n : 1n, total: held ? 0n : 15000n, waiting: held ? 1n : 0n }];
    });
    const service = new CoachBriefService(
      asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress(),
    );
    w.account.value = RESTRICTED;
    await w.fail();
    expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);

    const history = await service.getBriefHistory('coach-1', 1, 10);
    expect(history.items[0].summary?.narrative).toContain(coachAccountWaitingLine(1));
    expect(history.items[0].summary?.narrative).not.toContain('TGP is reminding the client to update their card.');
  });
});
