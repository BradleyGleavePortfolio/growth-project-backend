// test/lo-payfail-coach-brief-paused-dunning.spec.ts
//
// LO-PAYFAIL B-PF-1 (audit of backend main 436cf4bc, agent 186): the coach
// brief tells the coach every active DunningState is a failed payment "being
// retried automatically, so nothing is needed from you there".
//
// Three kinds of active DunningState are not being retried at all:
//   - a dispute pause (dunning-v2.service.ts pauseForDispute: locked at once,
//     billing paused, the coach decides whether to restart);
//   - a full-refund pause (pauseAfterFullRefund: same);
//   - a Day-10 lock (lockCycle): Stripe's last retry ran on Day 7.
// Every one of them has locked_out_at set. The brief's count query
// (coach-brief.service.ts:1063-1071 solo, :1519-1528 head coach) only asks
// status = 'active', so the coach of a client whose plan is paused for a
// dispute reads that TGP is retrying the payment and nothing is needed.
//
// Same class as AUD-FIN-MONEY-129 B-2 (dunning-v2.copy.ts:10-15): Stripe runs
// no retry for a hard decline, so the client push lines stopped promising one;
// the coach brief still does. This test only pins the three states where no
// retry can run; the words for a cycle inside its window are the fixer's call.
//
// The fake below answers the DunningState count the way Postgres would for
// the SQL it is given: a query that leaves out locked cycles
// (locked_out_at IS NULL) does not count them.
import { CoachBriefService, buildBriefPrompt, buildFallbackNarrative } from '../src/coach/brief/coach-brief.service';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma, wireSoloDefaults } from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

type State = { label: string; status: 'active'; locked_out_at: Date | null; last_failed_amount_cents: number };

function sqlText(arg: unknown): string {
  const a = arg as { sql?: unknown; strings?: unknown };
  if (a && typeof a.sql === 'string') return a.sql;
  if (a && Array.isArray(a.strings)) return (a.strings as string[]).join('?');
  if (Array.isArray(arg)) return (arg as string[]).join('?');
  return String(arg);
}

function wire(states: State[]) {
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: 'coach1', clientIds: ['c1'] });
  prisma.$queryRaw.mockImplementation(async (arg: unknown) => {
    const text = sqlText(arg);
    if (!text.includes('"DunningState"')) return [{ count: 0n, total: 0n }];
    const leavesOutLocked = /locked_out_at"?\s+IS\s+NULL/i.test(text);
    const counted = states.filter((s) => s.status === 'active' && (!leavesOutLocked || s.locked_out_at === null));
    return [
      {
        count: BigInt(counted.length),
        total: BigInt(counted.reduce((sum, s) => sum + s.last_failed_amount_cents, 0)),
      },
    ];
  });
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  return { prisma, svc };
}

const LOCKED_AT = new Date('2026-10-28T17:00:00Z');

describe('LO-PAYFAIL B-PF-1: the coach brief never says a paused or locked plan is being retried', () => {
  it.each([
    ['a dispute pause (billing paused, restart is the coach decision)'],
    ['a full-refund pause'],
    ['a Day-10 lock (Stripe retries ended on Day 7)'],
  ])("coach brief does not tell the coach %s is being retried and needs nothing from them", async (label) => {
    const { svc } = wire([{ label, status: 'active', locked_out_at: LOCKED_AT, last_failed_amount_cents: 8900 }]);
    const agg = await svc['aggregateSoloContext']('coach1', ['c1'], 'America/Los_Angeles', '2026-10-30', 'solo_coach');
    expect(buildFallbackNarrative(agg.context)).not.toMatch(/being retried automatically/i);
    expect(buildBriefPrompt(agg.context)).not.toMatch(/run automatically; nothing is needed from the coach/i);
  });
});
