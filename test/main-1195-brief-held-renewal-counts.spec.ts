// MAIN-1195 (merge of backend main into PF-7-BE): main's PF-5-BE brief SQL
// (dunningBriefSql) counts every active DunningState that is not a refund or
// dispute hold as "inside the 10 days" or "Day-10 lock". PF-7-BE adds a third
// kind of active row: a renewal waiting on the coach's Stripe account
// (last_failure_reason 'coach_account_not_ready'). Merged, that row must not
// read as PF-W1 ("TGP is reminding the client"), must not read as PF-W2, and
// must be counted as `waiting` so the brief says PF-W9.
//
// The fake Postgres below answers dunningBriefSql the way Postgres would, and
// only counts a held row apart when the SQL text says so.
import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  briefPaymentLines,
  buildFallbackNarrative,
  dunningBriefSql,
} from '../src/coach/brief/coach-brief.service';
import {
  DUNNING_V2_REVERSAL_REASON,
  FULL_REFUND_PAUSE_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import {
  asConfig,
  asPrismaService,
  makeMockConfig,
  makeMockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

const W1 = '1 payment failed. TGP is reminding the client to update their card.';
const W9_ONE = '1 renewal is waiting on your Stripe account. Fix it in Stripe, and TGP tries again.';

type Row = {
  status: string;
  locked_out_at: Date | null;
  last_failure_reason: string | null;
  client_canceled_at: Date | null;
  last_failed_amount_cents: number;
};

const AT = new Date('2026-10-28T17:00:00Z');
const inWindow = (): Row => ({ status: 'active', locked_out_at: null, last_failure_reason: 'card_declined', client_canceled_at: null, last_failed_amount_cents: 14900 });
const held = (): Row => ({ status: 'active', locked_out_at: null, last_failure_reason: COACH_ACCOUNT_HOLD_REASON, client_canceled_at: null, last_failed_amount_cents: 14900 });

const HELD_CLAUSE = 'AND NOT (ds."last_failure_reason" IS NOT DISTINCT FROM ?)';

function answer(sql: Prisma.Sql, rows: Row[]) {
  const text = sql.strings.join('?');
  const excludesHeld = text.includes(`ds."client_canceled_at" IS NULL ${HELD_CLAUSE})`)
    && text.includes(`ds."locked_out_at" IS NOT NULL ${HELD_CLAUSE})`)
    && sql.values.includes(COACH_ACCOUNT_HOLD_REASON);
  const countsWaiting = /\)::bigint AS waiting/.test(text);
  const isHeld = (r: Row) => excludesHeld && r.last_failure_reason === COACH_ACCOUNT_HOLD_REASON;
  const onHold = (r: Row) => [DUNNING_V2_REVERSAL_REASON, FULL_REFUND_PAUSE_REASON].includes(r.last_failure_reason ?? '');
  const active = rows.filter((r) => r.status === 'active');
  const win = active.filter((r) => !onHold(r) && !isHeld(r) && r.locked_out_at === null && r.client_canceled_at === null);
  const lock = active.filter((r) => !onHold(r) && !isHeld(r) && r.locked_out_at !== null);
  const waiting = active.filter((r) => r.last_failure_reason === COACH_ACCOUNT_HOLD_REASON && r.client_canceled_at === null);
  const sum = (xs: Row[]) => BigInt(xs.reduce((a, r) => a + r.last_failed_amount_cents, 0));
  return [{
    count: BigInt(win.length), total: sum(win), locked: BigInt(lock.length), locked_total: sum(lock),
    on_hold: BigInt(active.filter(onHold).length),
    ...(countsWaiting ? { waiting: BigInt(waiting.length) } : {}),
  }];
}

async function soloContext(rows: Row[]) {
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: 'coach1', clientIds: ['c1'] });
  prisma.$queryRaw.mockImplementation(async (arg: Prisma.Sql) => {
    if (!arg.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n }];
    return answer(arg, rows);
  });
  const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
  const { context } = await svc['aggregateSoloContext']('coach1', ['c1'], 'America/Los_Angeles', '2026-10-30', 'solo_coach');
  return context;
}

describe('MAIN-1195: a renewal waiting on the coach Stripe account in the merged brief SQL', () => {
  it('dunningBriefSql leaves a held renewal out of the 10 days and the lock, and counts it as waiting', () => {
    const sql = dunningBriefSql(Prisma.sql`cp."coach_user_id" = ${'coach1'}`);
    const text = sql.strings.join('?');
    expect(text).toContain(`ds."client_canceled_at" IS NULL ${HELD_CLAUSE})`);
    expect(text).toContain(`ds."locked_out_at" IS NOT NULL ${HELD_CLAUSE})`);
    expect(text).toMatch(/COUNT\(\*\) FILTER \(WHERE ds\."last_failure_reason" IS NOT DISTINCT FROM \? AND ds\."client_canceled_at" IS NULL\)::bigint AS waiting/);
    expect(sql.values).toContain(COACH_ACCOUNT_HOLD_REASON);
  });

  it('solo: only a held renewal -> no PF-W1/PF-W2, PF-W9 one form', async () => {
    const ctx = await soloContext([held()]);
    expect(ctx).toEqual(expect.objectContaining({ dunning_in_progress: 0, dunning_locked: 0, dunning_on_hold: 0, coach_account_waiting: 1 }));
    expect(briefPaymentLines(ctx)).toEqual([]);
    const text = buildFallbackNarrative(ctx);
    expect(text).toContain(W9_ONE);
    expect(text).not.toMatch(/payments? failed|reminding/);
  });

  it('solo: a held renewal and a real failed payment -> PF-W1 for 1 (not 2) and PF-W9 for 1', async () => {
    const ctx = await soloContext([held(), inWindow()]);
    expect(ctx).toEqual(expect.objectContaining({ dunning_in_progress: 1, coach_account_waiting: 1 }));
    expect(briefPaymentLines(ctx)).toEqual([W1]);
    const text = buildFallbackNarrative(ctx);
    expect(text).toContain(W1);
    expect(text).toContain(W9_ONE);
    expect(text).not.toContain('2 payments failed');
  });

  it('solo: a client who ended a held plan is not waiting', async () => {
    const ctx = await soloContext([{ ...held(), client_canceled_at: AT }]);
    expect(ctx.dunning_in_progress).toBe(0);
    expect(ctx.coach_account_waiting).toBeUndefined();
  });
});
