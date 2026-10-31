import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  buildFallbackNarrative,
} from '../src/coach/brief/coach-brief.service';
import {
  COACH_ACCOUNT_HOLD_REASON,
  coachAccountWaitingLine,
} from '../src/checkout/dunning-v2/coach-account-hold';
import {
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeMockConfig,
  makeMockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import { HOUR, RESTRICTED, T0, at, buildWorld } from './support/pf7-hold-world';

describe('LS-1195R2 B3: today reads the hold after a brief was already generated', () => {
  const saved = {
    v2: process.env['FEATURE_DUNNING_V2'],
    hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'],
  };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['FEATURE_DUNNING_V2', saved.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', saved.hold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([false, true])(
    'a hold beginning after the cached brief is reflected on today, prior card cycle=%s',
    async (priorCardCycle) => {
      const w = buildWorld();
      if (priorCardCycle) await w.fail();
      const context = makeBriefContext({
        coach_name: 'Review Coach',
        coach_first_name: 'Review',
        roster_size: 1,
        dunning_in_progress: priorCardCycle ? 1 : 0,
        dunning_amount_cents: priorCardCycle ? 15000 : 0,
      });
      let row: Record<string, unknown> = {
        id: 'review-cached-brief',
        coach_id: 'coach-1',
        brief_date: '2026-10-05',
        status: 'generated',
        generated_at: T0,
        generation_started_at: null,
        narrative: buildFallbackNarrative(context),
        brief_context: { ...context, scope_client_ids: ['client-1'] },
        action_items: [],
        generated_by: 'fallback',
        brief_mode: 'solo_coach',
        created_at: T0,
      };
      const prisma = makeMockPrisma();
      wireSoloDefaults(prisma, { coachId: 'coach-1', clientIds: ['client-1'] });
      prisma.user.findMany.mockReset().mockResolvedValue([
        { id: 'client-1', coach_id: 'coach-1', created_at: T0, name: 'Review Buyer' },
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
      prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
        if (!query.strings.join('?').includes('"DunningState"')) {
          return [{ count: 0n, total: 0n, mrr_cents: 0n }];
        }
        const held = w.state()?.last_failure_reason === COACH_ACCOUNT_HOLD_REASON;
        return [{
          count: !held && priorCardCycle ? 1n : 0n,
          total: !held && priorCardCycle ? 15000n : 0n,
          locked: 0n,
          locked_total: 0n,
          on_hold: 0n,
          waiting: held ? 1n : 0n,
        }];
      });
      const service = new CoachBriefService(
        asPrismaService(prisma),
        asConfig(makeMockConfig()),
        grantAllEgress(),
      );
      const before = await service.getOrGenerateTodaysBrief('coach-1');
      expect(before.summary?.narrative).toBe(row.narrative);
      expect(before.summary?.narrative).not.toContain(coachAccountWaitingLine(1));

      jest.setSystemTime(at(HOUR));
      w.account.value = { ...RESTRICTED };
      await w.fail();
      expect(w.state()).toMatchObject({
        status: 'active',
        step_index: -1,
        last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
      });
      const after = await service.getOrGenerateTodaysBrief('coach-1');

      expect(after.summary?.narrative).toContain(coachAccountWaitingLine(1));
      expect(after.summary?.narrative).not.toContain(
        'TGP is reminding the client to update their card.',
      );
      expect(after.summary?.brief_context.coach_account_waiting).toBe(1);
      expect(after.summary?.brief_context.dunning_in_progress).toBe(0);
    },
  );
});
