/**
 * CREDIT-METER-130 — the coach AI pool is metered at the exact provider cost.
 *
 * Before: the AI Guide, the gateway, Roman turns and Roman background jobs
 * rounded every call UP to a whole hard-cost cent, and the coach AI tools
 * rounded to the nearest cent, so a 0.5-cent call debited 1 cent (6.25
 * displayed cents per hard-cost cent instead of 3.125) and a 0.46-cent
 * draft debited nothing.
 * After: every path passes the exact cost. The pool keeps the period total
 * in millionths of a cent (actual_used_micro_cents) and actual_used_cents is
 * its ceiling, so a period rounds up once (under one hard-cost cent per
 * coach). canCharge, the hard stop and the displayed math read the
 * whole-cent figure as before; the monthly rollover resets both.
 *
 * The report's calls at Sonnet 5.5's $2 / $10 per million tokens:
 * 1,500 in / 200 out = 0.5 cents; 6,000 / 400 = 1.6; 20,000 / 1,500 = 5.5.
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { AiService, aiGuideCostCents } from '../src/ai/ai.service';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { COACH_AI_MODEL } from '../src/ai/coach/coach-ai.constants';
import { RomanService } from '../src/roman/roman.service';
import {
  RomanBackgroundSpendService,
  type RomanBackgroundReservation,
} from '../src/roman/background/roman-background-spend';
import { ROMAN_MODEL_PHASE_1 } from '../src/roman/anthropic-client.provider';
import { ROMAN_MEMORY_CAPABILITY } from '../src/roman/roman.constants';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { AnthropicProviderAdapter } from '../src/ai/gateway/providers/anthropic-provider.adapter';
import type { AnthropicAdapter } from '../src/ai/adapters/anthropic.adapter';
import type { CoachAIStateService } from '../src/ai/coach/coach-ai-state.service';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

const COACH = 'coach-meter';
const DAY = 86_400_000;
const CALLS: ReadonlyArray<readonly [number, number, number]> = [
  [1_500, 200, 0.5],
  [6_000, 400, 1.6],
  [20_000, 1_500, 5.5],
];

interface Row {
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
  actual_used_micro_cents: bigint;
  total_pack_actual_cents: number;
  last_rollover_at: Date | null;
}
type Where = Record<string, unknown>;
const INT_COLUMNS = [
  'base_actual_cents',
  'base_displayed_cents',
  'pack_paid_cents',
  'pack_displayed_cents',
  'actual_used_cents',
  'total_pack_actual_cents',
] as const;

/** One CoachAIBudget row in memory. Like Postgres, an Int column refuses a fraction. */
function pool(over: Partial<Row> = {}) {
  const row: Row = {
    id: 'budget-1',
    coach_user_id: COACH,
    period_start: new Date(Date.now() - 5 * DAY),
    period_end: new Date(Date.now() + 20 * DAY),
    base_actual_cents: 4000,
    value_multiplier: new Prisma.Decimal(3.125),
    base_displayed_cents: 12500,
    pack_paid_cents: 0,
    pack_displayed_cents: 0,
    actual_used_cents: 0,
    actual_used_micro_cents: BigInt(0),
    total_pack_actual_cents: 0,
    last_rollover_at: null,
    ...over,
  };
  let beforeNextWrite: (() => void) | null = null;
  const matches = (where: Where): boolean => {
    const end = (where.period_end ?? {}) as { gt?: Date; lte?: Date };
    const used = where.actual_used_cents as number | { lte?: number } | undefined;
    const micro = where.actual_used_micro_cents as bigint | number | undefined;
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.coach_user_id !== undefined && where.coach_user_id !== row.coach_user_id) return false;
    if (end.gt !== undefined && !(row.period_end > end.gt)) return false;
    if (end.lte !== undefined && !(row.period_end <= end.lte)) return false;
    if (typeof used === 'number' && row.actual_used_cents !== used) return false;
    if (typeof used === 'object' && used.lte !== undefined && row.actual_used_cents > used.lte) return false;
    if (micro !== undefined && row.actual_used_micro_cents !== BigInt(micro)) return false;
    return true;
  };
  const write = (data: Where): void => {
    for (const col of INT_COLUMNS) {
      const op = data[col] as number | { increment?: number; decrement?: number } | undefined;
      if (op === undefined) continue;
      const next = typeof op === 'number' ? op : row[col] + (op.increment ?? 0) - (op.decrement ?? 0);
      if (!Number.isInteger(next)) throw new Error(`Int column ${col} cannot hold ${next}`);
      row[col] = next;
    }
    if (data.actual_used_micro_cents !== undefined) {
      row.actual_used_micro_cents = BigInt(data.actual_used_micro_cents as bigint | number);
    }
    if (data.period_start !== undefined) row.period_start = data.period_start as Date;
    if (data.period_end !== undefined) row.period_end = data.period_end as Date;
    if (data.last_rollover_at !== undefined) row.last_rollover_at = data.last_rollover_at as Date;
  };
  const coachAIBudget = {
    findUnique: jest.fn(async ({ where }: { where: Where }) => (matches(where) ? { ...row } : null)),
    upsert: jest.fn(async () => ({ ...row })),
    findMany: jest.fn(async ({ where }: { where: Where }) => (matches(where) ? [{ ...row }] : [])),
    updateMany: jest.fn(async ({ where, data }: { where: Where; data: Where }) => {
      const race = beforeNextWrite;
      beforeNextWrite = null;
      race?.();
      if (!matches(where)) return { count: 0 };
      write(data);
      return { count: 1 };
    }),
  };
  const prisma = fakeOf<PrismaService>({
    coachAIBudget,
    teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
    aiRequestAudit: {
      create: jest.fn(async () => ({ id: 'audit-1' })),
      update: jest.fn(async () => ({})),
    },
  });
  const raceNextWrite = (fn: () => void) => {
    beforeNextWrite = fn;
  };
  return { row, prisma, budget: new CoachAIBudgetService(prisma), raceNextWrite };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('CREDIT-METER-130 — every debit path passes the exact provider cost', () => {
  it.each(CALLS)('AI Guide: %i in / %i out costs exactly %s cents', (tokensIn, tokensOut, cents) => {
    expect(aiGuideCostCents(tokensIn, tokensOut)).toBe(cents);
  });

  it('AI Guide: four 0.5-cent answers use 2 hard-cost cents and show 6 used, not 4 and 13', async () => {
    const p = pool();
    const svc = new AiService(fakeOf({}), fakeOf({}), fakeOf({}), fakeOf({}), grantAllEgress());
    for (let n = 0; n < 4; n++) await svc['debitCoachPool'](p.budget, COACH, 1_500, 200, 'client-1');
    expect(p.row.actual_used_cents).toBe(2);
    expect(p.row.actual_used_micro_cents).toBe(BigInt(2_000_000));
    // 2 hard-cost cents x 3.125 = 6.25 displayed cents.
    await expect(p.budget.getBudgetDto(COACH)).resolves.toMatchObject({ used_displayed_cents: 6 });
  });

  it('gateway: five 1.6-cent calls use 8 hard-cost cents, not 10', async () => {
    const env = { ...process.env };
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_GATEWAY_CAPABILITIES = 'client_chat';
    try {
      const p = pool();
      const anthropic = {
        name: 'anthropic',
        complete: jest.fn(async () => ({
          provider: 'anthropic',
          model: COACH_AI_MODEL,
          text: 'ok',
          enabled: true,
          promptTokenEstimate: 6_000,
          responseTokenEstimate: 400,
          meta: {},
        })),
      };
      const registry = new AiProviderRegistry(new StubProviderAdapter(), fakeOf(anthropic));
      const svc = new AiGatewayService(
        p.prisma,
        new AiGatewayConfig(),
        new AiRedactionService(),
        registry,
        grantAllEgress(),
        p.budget,
      );
      for (let n = 0; n < 5; n++) {
        await svc.invoke({
          capability: 'client_chat',
          requester: { id: COACH, role: 'coach' },
          userMessage: 'How is the week going?',
          systemPrompt: 'x',
        });
      }
      expect(anthropic.complete).toHaveBeenCalledTimes(5);
      expect(p.row.actual_used_cents).toBe(8);
      expect(p.row.actual_used_micro_cents).toBe(BigInt(8_000_000));
    } finally {
      process.env = env;
    }
  });

  it('Roman: two 5.5-cent turns use 11 hard-cost cents, not 12', async () => {
    const p = pool();
    const svc = new RomanService(p.prisma, grantAllEgress(), null, null, null, p.budget);
    for (let n = 0; n < 2; n++) await svc['debitCoachPool'](COACH, 20_000, 1_500, `req-${n}`);
    expect(p.row.actual_used_cents).toBe(11);
    expect(p.row.actual_used_micro_cents).toBe(BigInt(11_000_000));
  });

  it('Roman background: four 0.5-cent jobs use 2 hard-cost cents, not 4', async () => {
    const p = pool();
    const svc = new RomanBackgroundSpendService(p.prisma, p.budget);
    const reservation: RomanBackgroundReservation = {
      requestId: 'roman-bg-1',
      capability: ROMAN_MEMORY_CAPABILITY,
      model: ROMAN_MODEL_PHASE_1,
      poolCoachId: COACH,
    };
    for (let n = 0; n < 4; n++) await svc.settle(reservation, 1_500, 200);
    expect(p.row.actual_used_cents).toBe(2);
  });

  it('coach AI tools: four 0.5-cent drafts use 2 cents, not 4, and a 0.46-cent draft is not free', async () => {
    const tools = (budget: CoachAIBudgetService) =>
      new CoachAIService(fakeOf({}), fakeOf({}), fakeOf({}), fakeOf({}), fakeOf({}), fakeOf({}), budget);
    const p = pool();
    for (let n = 0; n < 4; n++) await tools(p.budget)['recordSpend'](COACH, 'meal_plan', 'client-1', 1_500, 200);
    expect(p.row.actual_used_cents).toBe(2);
    const q = pool();
    // 1,400 in / 180 out = 0.46 cents: rounded to the nearest cent it was 0.
    await tools(q.budget)['recordSpend'](COACH, 'meal_plan', 'client-1', 1_400, 180);
    expect(q.row.actual_used_cents).toBe(1);
    expect(q.row.actual_used_micro_cents).toBe(BigInt(460_000));
  });
});

describe('CREDIT-METER-130 — the pool rounds once per period', () => {
  it("the report's three calls (0.5 + 1.6 + 5.5 = 7.6 cents) leave 8 whole cents used, 25 displayed", async () => {
    const p = pool();
    for (const [, , cents] of CALLS) {
      await expect(
        p.budget.recordUsage({ coachId: COACH, actualCostCents: cents, capability: 'client_chat' }),
      ).resolves.toMatchObject({ recorded: true });
    }
    expect(p.row.actual_used_micro_cents).toBe(BigInt(7_600_000));
    expect(p.row.actual_used_cents).toBe(8);
    await expect(p.budget.getBudgetDto(COACH)).resolves.toMatchObject({
      used_displayed_cents: 25,
      remaining_displayed_cents: 12_475,
    });
  });

  it('the hard stop keeps its meaning: under one cent left reads as used up and a larger cost is refused', async () => {
    const p = pool({ actual_used_cents: 3999, actual_used_micro_cents: BigInt(3_998_600_000) });
    await p.budget.recordUsage({ coachId: COACH, actualCostCents: 0.5, capability: 'client_chat' });
    expect(p.row.actual_used_cents).toBe(4000);
    const { budget } = await p.budget.canCharge(COACH, 0);
    expect(budget.actual_used_cents).toBe(budget.total_actual_available_cents);
    await expect(
      p.budget.recordUsage({ coachId: COACH, actualCostCents: 1, capability: 'client_chat' }),
    ).resolves.toMatchObject({ recorded: false });
    expect(p.row.actual_used_micro_cents).toBe(BigInt(3_999_100_000));
    expect(p.row.actual_used_cents).toBe(4000);
  });

  it('the monthly rollover resets the exact total with the whole-cent figure', async () => {
    const p = pool({
      period_end: new Date(Date.now() - DAY),
      actual_used_cents: 8,
      actual_used_micro_cents: BigInt(7_600_000),
    });
    await expect(p.budget.rolloverDueBudgets(new Date())).resolves.toEqual({ rolled: 1 });
    expect(p.row.actual_used_cents).toBe(0);
    expect(p.row.actual_used_micro_cents).toBe(BigInt(0));
  });

  it('a row last debited in whole cents never shows less used than before', async () => {
    // Written before the exact column existed (or by a machine still on the
    // old code during a rollout): 120 whole cents, no exact total.
    const p = pool({ actual_used_cents: 120 });
    await p.budget.recordUsage({ coachId: COACH, actualCostCents: 0.5, capability: 'client_chat' });
    expect(p.row.actual_used_cents).toBe(120);
    await p.budget.recordUsage({ coachId: COACH, actualCostCents: 0.5, capability: 'client_chat' });
    expect(p.row.actual_used_cents).toBe(121);
  });

  it('a debit that loses a race to another debit reads the row again and still lands', async () => {
    const p = pool();
    p.raceNextWrite(() => {
      // Another reply's 1.6-cent debit lands between this read and this write.
      p.row.actual_used_cents = 2;
      p.row.actual_used_micro_cents = BigInt(1_600_000);
    });
    await expect(
      p.budget.recordUsage({ coachId: COACH, actualCostCents: 0.5, capability: 'client_chat' }),
    ).resolves.toMatchObject({ recorded: true });
    expect(p.row.actual_used_micro_cents).toBe(BigInt(2_100_000));
    expect(p.row.actual_used_cents).toBe(3);
  });
});

describe('CREDIT-METER-130 U3 — the gateway never takes its 5-cent no-token-counts default', () => {
  it('a real call always reports both counts (0 / 0 when the SDK omits usage), so it keeps the 1-cent floor', async () => {
    const env = { ...process.env };
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_GATEWAY_CAPABILITIES = 'client_chat';
    try {
      const p = pool();
      // AnthropicAdapter.complete's result when the SDK response has no usage
      // (src/ai/adapters/anthropic.adapter.ts:132-133 default both to 0).
      const complete = jest.fn(async () => ({
        text: 'ok',
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: COACH_AI_MODEL,
        latencyMs: 1,
      }));
      const real = new AnthropicProviderAdapter(
        fakeOf<AnthropicAdapter>({ complete }),
        fakeOf<CoachAIStateService>({ isReady: () => true }),
      );
      const svc = new AiGatewayService(
        p.prisma,
        new AiGatewayConfig(),
        new AiRedactionService(),
        new AiProviderRegistry(new StubProviderAdapter(), real),
        grantAllEgress(),
        p.budget,
      );
      await svc.invoke({
        capability: 'client_chat',
        requester: { id: COACH, role: 'coach' },
        userMessage: 'How is the week going?',
        systemPrompt: 'x',
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(p.row.actual_used_micro_cents).toBe(BigInt(1_000_000));
      expect(p.row.actual_used_cents).toBe(1);
    } finally {
      process.env = env;
    }
  });
});
