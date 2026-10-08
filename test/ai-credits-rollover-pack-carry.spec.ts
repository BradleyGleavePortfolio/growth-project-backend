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

type Pack = {
  id: string;
  coach_user_id: string;
  budget_id: string;
  paid_cents: number;
  actual_credit_cents: number;
  displayed_credit_cents: number;
  status: string;
  applied_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
  is_free_grant: boolean;
};

function makePrisma(rows: Row[], packs: Pack[] = []) {
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
    // The CHECK constraints production has on these columns.
    if (r.total_pack_actual_cents < 0) throw new Error('violates check constraint "CoachAIBudget_total_pack_actual_nonneg"');
    if (r.pack_paid_cents < 0) throw new Error('violates check constraint "CoachAIBudget_pack_paid_nonneg"');
  };
  const prisma = {
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
    coachCreditPackPurchase: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = packs.find((x) => x.id === where.id);
        return p ? { ...p } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { budget_id: string; status: string; id: { not: string } } }) =>
        packs
          .filter((p) => p.budget_id === where.budget_id && p.status === where.status && p.id !== where.id.not)
          .map((p) => ({ ...p })),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Pack> }) => {
        const p = packs.find((x) => x.id === where.id);
        if (!p) throw new Error('purchase not found');
        Object.assign(p, data);
        return { ...p };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return prisma;
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

// B-870-SOL-F-130-1 (FIX-OPUS-130): a rollover already removed the spent part
// of a pack, so refunding that pack later takes back only what is left of it,
// never another pack's credit, and never goes below 0.
describe('B-870-SOL-F-130-1 — a refund after a rollover takes back only what is left of that pack', () => {
  beforeEach(() => {
    process.env.COACH_AI_MAX_ACTUAL_CENTS = '4000';
    process.env.COACH_AI_VALUE_MULTIPLIER = '3.125';
  });

  const pack = (id: string, daysAgo: number): Pack => ({
    id, coach_user_id: COACH, budget_id: 'b_1', paid_cents: 2500, actual_credit_cents: 800, displayed_credit_cents: 2500,
    status: 'paid', applied_at: new Date(Date.now() - daysAgo * DAY), refunded_at: null,
    created_at: new Date(Date.now() - daysAgo * DAY), is_free_grant: false,
  });
  async function setupWithPacks(row: Row, packs: Pack[]) {
    const rows = [row];
    const moduleRef = await Test.createTestingModule({
      providers: [CoachAIBudgetService, { provide: PrismaService, useValue: makePrisma(rows, packs) }],
    }).compile();
    return { svc: moduleRef.get(CoachAIBudgetService), rows, packs };
  }
  const refund = (svc: CoachAIBudgetService, purchaseId: string) =>
    svc.refundPack({ purchaseId, actorOwnerId: 'owner-1', reason: 'test' });

  it('a partly spent pack: the refund removes the 500 actual / 1562 displayed left, and the receipt is refunded', async () => {
    const { svc, rows, packs } = await setupWithPacks(closedPeriod({ ...PACK_25, actual_used_cents: 4300 }), [pack('p_a', 20)]);
    await svc.rolloverDueBudgets(new Date());

    await expect(refund(svc, 'p_a')).resolves.toMatchObject({ refunded: true });

    expect(rows[0]).toMatchObject({ total_pack_actual_cents: 0, pack_displayed_cents: 0, pack_paid_cents: 0 });
    expect(packs[0].status).toBe('refunded');
    const { budget } = await svc.canCharge(COACH, 0);
    expect(budget.total_actual_available_cents).toBe(4000);
  });

  it('a fully spent pack: the refund removes no more credit and nothing goes below 0', async () => {
    const { svc, rows, packs } = await setupWithPacks(closedPeriod({ ...PACK_25, actual_used_cents: 4800 }), [pack('p_a', 20)]);
    await svc.rolloverDueBudgets(new Date());

    await expect(refund(svc, 'p_a')).resolves.toMatchObject({ refunded: true });

    expect(rows[0]).toMatchObject({ total_pack_actual_cents: 0, pack_displayed_cents: 0, pack_paid_cents: 0 });
    expect(packs[0].status).toBe('refunded');
  });

  it('two packs: refunding the older, partly spent one keeps the newer pack whole', async () => {
    const two = { pack_paid_cents: 5000, pack_displayed_cents: 5000, total_pack_actual_cents: 1600 };
    const { svc, rows } = await setupWithPacks(closedPeriod({ ...two, actual_used_cents: 4300 }), [pack('p_old', 20), pack('p_new', 10)]);
    await svc.rolloverDueBudgets(new Date());
    expect(rows[0]).toMatchObject({ total_pack_actual_cents: 1300, pack_displayed_cents: 4062 });

    await expect(refund(svc, 'p_old')).resolves.toMatchObject({ refunded: true });

    // The newer pack's 800 actual / 2500 displayed stay; only the older pack's 500 / 1562 left.
    expect(rows[0]).toMatchObject({ total_pack_actual_cents: 800, pack_displayed_cents: 2500, pack_paid_cents: 2500 });
  });

  it('before any rollover an unused pack is refunded in full, as before', async () => {
    const open = closedPeriod({ ...PACK_25, period_end: new Date(Date.now() + 10 * DAY) });
    const { svc, rows } = await setupWithPacks(open, [pack('p_a', 2)]);

    await expect(refund(svc, 'p_a')).resolves.toMatchObject({ refunded: true });

    expect(rows[0]).toMatchObject({ total_pack_actual_cents: 0, pack_displayed_cents: 0, pack_paid_cents: 0 });
  });
});
