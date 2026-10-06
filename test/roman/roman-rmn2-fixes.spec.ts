/**
 * Fix round 2 (B-RMN2-122, agent 122) for #668 @ dabed738: Sol's B-668-1
 * (a pool remainder smaller than one reply) and B-668-3 (one meal validating
 * a whole-day total) through the real converter. Harness adapted from the
 * AUD-SOL-RMN1-122 normal-use probe. Red on dabed738, green with the fix.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RomanSession } from '@prisma/client';
import { RomanService, postCheckContextOf } from '../../src/roman/roman.service';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { ROMAN_COACH_POOL_EMPTY_MESSAGE } from '../../src/roman/roman.constants';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { postCheckRomanReply } from '../../src/roman/guardrails/roman-post-check';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'rmn2-client', role: 'student', tier: 'free' as const };
const SESSION = fakeOf<RomanSession>({
  id: 'rmn2-session', user_id: CLIENT.id, surface: 'client',
  day_key: 'rmn2-day', message_count: 1, exclamation_used: false,
  quips_in_session: 0, subject_context_json: null, deleted_at: null,
});

let savedFlag: string | undefined;
let savedCap: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  savedCap = process.env.ROMAN_DAILY_COST_CAP_USD;
  process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  process.env.ROMAN_DAILY_COST_CAP_USD = '100';
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
  else process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = savedFlag;
  if (savedCap === undefined) delete process.env.ROMAN_DAILY_COST_CAP_USD;
  else process.env.ROMAN_DAILY_COST_CAP_USD = savedCap;
  jest.restoreAllMocks();
});

function setup(initialUsedCents: number, inputTokens = 6000) {
  const row = {
    id: 'rmn2-budget', coach_user_id: 'rmn2-coach',
    period_start: new Date('2026-10-01T00:00:00Z'),
    period_end: new Date('2099-11-01T00:00:00Z'),
    base_actual_cents: 4000, value_multiplier: new Prisma.Decimal(5),
    base_displayed_cents: 20000, pack_paid_cents: 0, pack_displayed_cents: 0,
    total_pack_actual_cents: 0, actual_used_cents: initialUsedCents,
  };
  const romanSession = { updateMany: jest.fn(async () => ({ count: 1 })) };
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'rmn2-reply', ...data,
    })),
    findMany: jest.fn(async () => [{ role: 'user', content: 'What should I train today?' }]),
  };
  const aiRequestAudit = {
    create: jest.fn(async () => ({ request_id: 'rmn2-request' })),
    aggregate: jest.fn(async () => ({ _sum: {
      prompt_token_estimate: 18000, response_token_estimate: 2000,
    } })),
    update: jest.fn(async () => ({})),
  };
  const coachAIBudget = {
    findUnique: jest.fn(async () => ({ ...row })),
    updateMany: jest.fn(async ({ where, data }: {
      where: { actual_used_cents: { lte: number } };
      data: { actual_used_cents: { increment: number } };
    }) => {
      // Honor the exact real update predicate, with no competing actor.
      if (row.actual_used_cents > where.actual_used_cents.lte) return { count: 0 };
      row.actual_used_cents += data.actual_used_cents.increment;
      return { count: 1 };
    }),
  };
  const prisma = fakeOf<ConstructorParameters<typeof CoachAIBudgetService>[0]>({
    user: { findUnique: jest.fn(async () => ({ coach_id: 'rmn2-coach' })) },
    teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
    coachAIBudget, romanSession, romanMessage, aiRequestAudit,
    // C2 (#669): the daily reservation runs inside a transaction behind an
    // advisory lock, so the tx carries the ledger and $executeRaw too.
    $transaction: jest.fn(async (fn: (tx: object) => Promise<unknown>) =>
      fn({ romanSession, romanMessage, aiRequestAudit, $executeRaw: jest.fn(async () => 1) })),
  });
  const client = {
    messages: {
      stream: jest.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: inputTokens } } };
          yield { type: 'content_block_delta', delta: {
            type: 'text_delta', text: 'Keep the plan as written.',
          } };
          yield { type: 'message_delta', usage: { output_tokens: 300 } };
        },
      })),
      create: jest.fn(),
    },
  };
  const handle = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(client));
  const budget = new CoachAIBudgetService(prisma);
  const usage = jest.spyOn(budget, 'recordUsage');
  const svc = new RomanService(prisma, grantAllEgress(), handle, null, null, budget);
  return { svc, row, client, usage };
}

async function turn(svc: RomanService): Promise<void> {
  for await (const _chunk of svc.streamAssistantTurn(
    CLIENT, SESSION, { userMessage: 'What should I train today?' },
  )) {
    // Consume the complete normal provider response before the next turn.
  }
}

const MEALS_CTX = fakeOf<RomanClientContext>({
  targets: { source: 'coach_set', calories: 2000, protein_g: 120, carbs_g: 200, fat_g: 60 },
  today: {
    date: '2026-10-05', kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25,
    meals_logged: 2, remaining_kcal: 1220, remaining_protein_g: 60,
    remaining_carbs_g: 130, remaining_fat_g: 35, pct_kcal: 39, pct_protein: 50,
    entries: [
      { meal: 'breakfast', name: 'Breakfast', kcal: 330, protein_g: 30 },
      { meal: 'lunch', name: 'Lunch', kcal: 450, protein_g: 30 },
    ],
  },
  last_7_days: {
    days_logged: 0, avg_kcal_on_logged_days: null, avg_protein_g_on_logged_days: null,
    days_within_10pct_kcal: null, days: [],
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
  wearables: { days: [], avg_7d: { active_kcal: null } },
  meal_plan: null,
});

const EXHAUSTED = { response: { code: 'COACH_AI_BUDGET_EXHAUSTED', message: ROMAN_COACH_POOL_EMPTY_MESSAGE } };

describe('B-668-1 (Sol) a pool remainder smaller than one reply is never answered for free', () => {
  it('control: an affordable turn is answered and debits its 2-cent cost', async () => {
    const { svc, row, client, usage } = setup(0);
    await turn(svc);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({
      coachId: 'rmn2-coach', actualCostCents: 2, capability: 'roman.chat',
    }));
    expect(row.actual_used_cents).toBe(2);
  });

  it('one cent left: every turn gets the capacity message before the provider', async () => {
    const { svc, row, client } = setup(3999);
    await expect(svc.assertCoachPoolOpen(CLIENT)).rejects.toMatchObject(EXHAUSTED);
    for (let i = 0; i < 2; i++) await expect(turn(svc)).rejects.toMatchObject(EXHAUSTED);
    expect(client.messages.stream).not.toHaveBeenCalled();
    expect(row.actual_used_cents).toBe(3999);
  });

  it('a reply costing more than the remainder consumes it, and the next turn is refused', async () => {
    // 10 cents left admits a turn; 60,000 prompt tokens cost over 12 cents
    // at Sonnet 5.5's $2 / MTok input.
    const { svc, row, client } = setup(3990, 60000);
    await turn(svc);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    expect(row.actual_used_cents).toBe(4000);
    await expect(turn(svc)).rejects.toMatchObject(EXHAUSTED);
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
  });
});

describe('B-668-3 (Sol) a lunch entry cannot validate a whole-day logged total', () => {
  const context = postCheckContextOf(MEALS_CTX);

  it('rejected: You have logged 450 kcal today.', () => {
    const checked = postCheckRomanReply('You have logged 450 kcal today.', { routerClass: 'normal', context });
    expect(checked.rewritten).toBe(true);
    expect(checked.guardrails_applied).toContain('ungrounded_number');
  });

  it.each(['You have logged 780 kcal today.', 'You logged 450 kcal at lunch today.'])(
    'accepted: %s',
    (reply) => {
      expect(postCheckRomanReply(reply, { routerClass: 'normal', context }))
        .toEqual({ text: reply, guardrails_applied: [], rewritten: false });
    },
  );
});
