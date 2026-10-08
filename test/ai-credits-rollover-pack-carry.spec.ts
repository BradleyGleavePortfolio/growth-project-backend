/**
 * CREDIT-REFILL-130 — monthly rollover keeps only the UNUSED part of a
 * credit pack (bought or granted).
 *
 * Before: rolloverDueBudgets reset actual_used_cents to 0 and left the pack
 * columns untouched, so a pack the coach had already spent came back in full
 * on the 1st of every month (a one-time $25 pack became $25 of AI, and $8 of
 * TGP provider cost, every month). The base allowance is spent first because
 * it expires at rollover; whatever the closing period used beyond the base
 * came out of pack credit and is gone. The coach keeps exactly the pack
 * balance the app showed as remaining at close.
 *
 * Numbers use the production values (multiplier 3.125, base 4000 actual
 * cents = 12500 displayed cents).
 */
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { bankersRoundPaidToActual } from '../src/ai-credits/bankers-round.util';

type Row = {
  id: string;
  coach_user_id: string;
  period_start: Date;
  period_end: Date;
  base_actual_cents: number;
  value_multiplier: Prisma.Decimal;
  base_displayed_cents: number;
  pack_paid_cents: number;
  pack_displayed_cents: number;
  actual_used_cents: number;
  total_pack_actual_cents: number;
  last_rollover_at: Date | null;
};

type NumOp = number | { increment?: number; decrement?: number };

function applyNum(current: number, op: NumOp): number {
  if (typeof op === 'number') return op;
  return current + (op.increment ?? 0) - (op.decrement ?? 0);
}

const NUMERIC_COLUMNS = [
  'base_actual_cents',
  'base_displayed_cents',
  'pack_paid_cents',
  'pack_displayed_cents',
  'actual_used_cents',
  'total_pack_actual_cents',
] as const;

function makePrisma(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>): boolean => {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.coach_user_id !== undefined && r.coach_user_id !== where.coach_user_id) return false;
    const pe = where.period_end as { lte?: Date; gt?: Date } | undefined;
    if (pe?.lte !== undefined && !(r.period_end <= pe.lte)) return false;
    if (pe?.gt !== undefined && !(r.period_end > pe.gt)) return false;
    const used = where.actual_used_cents as number | { lte?: number } | undefined;
    if (typeof used === 'number' && r.actual_used_cents !== used) return false;
    if (typeof used === 'object' && used.lte !== undefined && r.actual_used_cents > used.lte) {
      return false;
    }
    return true;
  };
  const write = (r: Row, data: Record<string, unknown>): void => {
    for (const col of NUMERIC_COLUMNS) {
      if (data[col] !== undefined) r[col] = applyNum(r[col], data[col] as NumOp);
    }
    if (data.value_multiplier !== undefined) r.value_multiplier = data.value_multiplier as Prisma.Decimal;
    if (data.period_start !== undefined) r.period_start = data.period_start as Date;
    if (data.period_end !== undefined) r.period_end = data.period_end as Date;
    if (data.last_rollover_at !== undefined) r.last_rollover_at = data.last_rollover_at as Date;
  };
  return {
    coachAIBudget: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = rows.find((x) => matches(x, where));
        return r ? { ...r } : null;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of rows) {
            if (!matches(r, where)) continue;
            write(r, data);
            count++;
          }
          return { count };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const r = rows.find((x) => matches(x, where));
          if (!r) throw new Error('budget not found');
          write(r, data);
          return { ...r };
        },
      ),
    },
  };
}

const COACH = 'coach-refill';
const DAY = 86_400_000;

/** A budget whose period closed yesterday, at the production numbers. */
function closedPeriod(over: Partial<Row>): Row {
  const now = Date.now();
  return {
    id: 'b_1',
    coach_user_id: COACH,
    period_start: new Date(now - 31 * DAY),
    period_end: new Date(now - DAY),
    base_actual_cents: 4000,
    value_multiplier: new Prisma.Decimal(3.125),
    base_displayed_cents: 12500,
    pack_paid_cents: 0,
    pack_displayed_cents: 0,
    actual_used_cents: 0,
    total_pack_actual_cents: 0,
    last_rollover_at: null,
    ...over,
  };
}

/** One $25 pack as applyCreditPack books it: $25 displayed, 800 actual. */
const PACK_25 = {
  pack_paid_cents: 2500,
  pack_displayed_cents: 2500,
  total_pack_actual_cents: bankersRoundPaidToActual(2500, 3.125),
};

async function setup(row: Row) {
  const rows = [row];
  const moduleRef = await Test.createTestingModule({
    providers: [CoachAIBudgetService, { provide: PrismaService, useValue: makePrisma(rows) }],
  }).compile();
  return { svc: moduleRef.get(CoachAIBudgetService), rows };
}

describe('CREDIT-REFILL-130 — rollover keeps only the unused pack credit', () => {
  beforeEach(() => {
    process.env.COACH_AI_MAX_ACTUAL_CENTS = '4000';
    process.env.COACH_AI_VALUE_MULTIPLIER = '3.125';
  });

  it('a $25 pack that was fully spent does not come back next month', async () => {
    expect(PACK_25.total_pack_actual_cents).toBe(800);
    // The coach spent the whole base (4000) and the whole pack (800).
    const { svc, rows } = await setup(closedPeriod({ ...PACK_25, actual_used_cents: 4800 }));
    const before = await svc.getBudgetDto(COACH);
    expect(before.total_displayed_cents).toBe(15000);
    expect(before.remaining_displayed_cents).toBe(0);

    await expect(svc.rolloverDueBudgets(new Date())).resolves.toEqual({ rolled: 1 });

    expect(rows[0].actual_used_cents).toBe(0);
    expect(rows[0].total_pack_actual_cents).toBe(0);
    expect(rows[0].pack_displayed_cents).toBe(0);
    // Money paid stays on record (refund tooling reads it).
    expect(rows[0].pack_paid_cents).toBe(2500);
    const after = await svc.getBudgetDto(COACH);
    expect(after.total_displayed_cents).toBe(12500);
    expect(after.remaining_displayed_cents).toBe(12500);
    // The provider-cost ceiling is the base only: no free 800 cents.
    const { budget } = await svc.canCharge(COACH, 0);
    expect(budget.total_actual_available_cents).toBe(4000);
  });

  it('an unused pack carries over in full', async () => {
    // Only 3000 of the 4000 base was used: the pack is untouched.
    const { svc, rows } = await setup(closedPeriod({ ...PACK_25, actual_used_cents: 3000 }));

    await svc.rolloverDueBudgets(new Date());

    expect(rows[0].total_pack_actual_cents).toBe(800);
    expect(rows[0].pack_displayed_cents).toBe(2500);
    const after = await svc.getBudgetDto(COACH);
    expect(after.total_displayed_cents).toBe(15000);
    expect(after.remaining_displayed_cents).toBe(15000);
  });

  it('a partly spent pack carries exactly the balance the coach saw at close', async () => {
    // Base 4000 + 300 of the pack's 800 actual cents were used.
    const { svc, rows } = await setup(closedPeriod({ ...PACK_25, actual_used_cents: 4300 }));
    const atClose = await svc.getBudgetDto(COACH);
    expect(atClose.remaining_displayed_cents).toBe(1562);

    await svc.rolloverDueBudgets(new Date());

    expect(rows[0].total_pack_actual_cents).toBe(500);
    expect(rows[0].pack_displayed_cents).toBe(1562);
    const after = await svc.getBudgetDto(COACH);
    expect(after.total_displayed_cents).toBe(12500 + 1562);
    expect(after.remaining_displayed_cents).toBe(12500 + 1562);
    const { budget } = await svc.canCharge(COACH, 0);
    expect(budget.total_actual_available_cents).toBe(4500);
  });

  it('an owner free grant that was spent does not come back either', async () => {
    // grantFreeCredits books displayed credit and actual headroom, no money.
    const grant = {
      pack_paid_cents: 0,
      pack_displayed_cents: 1000,
      total_pack_actual_cents: bankersRoundPaidToActual(1000, 3.125),
    };
    const { svc, rows } = await setup(closedPeriod({ ...grant, actual_used_cents: 4320 }));

    await svc.rolloverDueBudgets(new Date());

    expect(rows[0].total_pack_actual_cents).toBe(0);
    expect(rows[0].pack_displayed_cents).toBe(0);
  });

  it('a second run in the same hour changes nothing', async () => {
    const { svc, rows } = await setup(closedPeriod({ ...PACK_25, actual_used_cents: 4300 }));
    const now = new Date();
    await svc.rolloverDueBudgets(now);
    const once = { ...rows[0] };

    await expect(svc.rolloverDueBudgets(now)).resolves.toEqual({ rolled: 0 });

    expect(rows[0]).toEqual(once);
  });
});
