// PF-5-BE (LS-PAYFAIL B5, LO-PAYFAIL B-PF-1): what the coach brief says about
// failed payments. An active DunningState is one of three things, and the
// brief says each one apart with the owner's approved words (PF-W1..PF-W4):
//   - inside the 10 days: "1 payment failed. TGP is reminding the client to update their card."
//   - Day-10 lock:        "Access is paused on 1 plan after 10 days unpaid. It comes back when the client pays."
//   - refund/dispute hold: "1 plan is on hold after a refund or a bank dispute. Only you can restart it."
// It never promises a card retry and never says nothing is needed.
//
// The fake Postgres below answers the brief's dunning SQL the way Postgres
// would for the three FILTER clauses dunningBriefSql builds.
import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  briefPaymentLines,
  buildBriefPrompt,
  buildFallbackNarrative,
  buildHeadCoachActionItems,
  dunningBriefSql,
  readDunningBrief,
  validateClaudeNarrative,
  buildHeadCoachSystemPrompt,
  buildSoloCoachSystemPrompt,
  type BriefAiInput,
} from '../src/coach/brief/coach-brief.service';
import {
  DUNNING_V2_REVERSAL_REASON,
  FULL_REFUND_PAUSE_REASON,
} from '../src/checkout/dunning-v2/dunning-v2.service';
import { clientDataSubject, noClientDataSubject } from '../src/ai-egress/ai-egress.types';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeHeadCoachContext,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';
import type { BriefContext, BriefContextHeadCoach } from '../src/coach/brief/coach-brief.types';

const W1 = '1 payment failed. TGP is reminding the client to update their card.';
const W2 = 'Access is paused on 1 plan after 10 days unpaid. It comes back when the client pays.';
const W3 = '1 plan is on hold after a refund or a bank dispute. Only you can restart it.';
const W3_HEAD = '1 plan is on hold after a refund or a bank dispute. Only their coach can restart it.';
const RETRY_PROMISE = /retr(y|ies|ied|ying)|run automatically|nothing is needed/i;

type Row = {
  status: string;
  locked_out_at: Date | null;
  last_failure_reason: string | null;
  client_canceled_at: Date | null;
  last_failed_amount_cents: number;
};

const LOCKED_AT = new Date('2026-10-28T17:00:00Z');
const inWindow = (): Row => ({ status: 'active', locked_out_at: null, last_failure_reason: 'card_declined', client_canceled_at: null, last_failed_amount_cents: 14900 });
const dayTenLock = (): Row => ({ status: 'active', locked_out_at: LOCKED_AT, last_failure_reason: 'card_declined', client_canceled_at: null, last_failed_amount_cents: 14900 });
const refundHold = (): Row => ({ status: 'active', locked_out_at: LOCKED_AT, last_failure_reason: FULL_REFUND_PAUSE_REASON, client_canceled_at: null, last_failed_amount_cents: 0 });
const disputeHold = (): Row => ({ status: 'active', locked_out_at: LOCKED_AT, last_failure_reason: DUNNING_V2_REVERSAL_REASON, client_canceled_at: null, last_failed_amount_cents: 0 });

const isOnHold = (r: Row) => [DUNNING_V2_REVERSAL_REASON, FULL_REFUND_PAUSE_REASON].includes(r.last_failure_reason ?? '');

// Answers dunningBriefSql the way Postgres would: each FILTER is recognised
// by its own clause text, so a query that drops a clause counts wrongly here.
function answerDunningSql(sql: Prisma.Sql, rows: Row[]) {
  const text = sql.strings.join('?');
  expect(text).toMatch(/"DunningState"/);
  expect(text).toMatch(/ds\."status" = 'active'/);
  expect(sql.values).toEqual(expect.arrayContaining([DUNNING_V2_REVERSAL_REASON, FULL_REFUND_PAUSE_REASON]));
  // inside the 10 days: not on hold, not locked, client has not ended the plan,
  // not waiting on the coach's Stripe account (PF-7-BE, merged in MAIN-1195)
  expect(text).toMatch(/FILTER \(WHERE NOT \(COALESCE\(ds\."last_failure_reason", ''\) IN \(\?, \?\)\) AND ds\."locked_out_at" IS NULL AND ds\."client_canceled_at" IS NULL AND NOT \(ds\."last_failure_reason" IS NOT DISTINCT FROM \?\)\)/);
  // Day-10 lock: not on hold, locked
  expect(text).toMatch(/FILTER \(WHERE NOT \(COALESCE\(ds\."last_failure_reason", ''\) IN \(\?, \?\)\) AND ds\."locked_out_at" IS NOT NULL AND NOT \(ds\."last_failure_reason" IS NOT DISTINCT FROM \?\)\)/);
  const active = rows.filter((r) => r.status === 'active');
  const win = active.filter((r) => !isOnHold(r) && r.locked_out_at === null && r.client_canceled_at === null);
  const lock = active.filter((r) => !isOnHold(r) && r.locked_out_at !== null);
  const hold = active.filter(isOnHold);
  const sum = (xs: Row[]) => BigInt(xs.reduce((a, r) => a + r.last_failed_amount_cents, 0));
  return [{ count: BigInt(win.length), total: sum(win), locked: BigInt(lock.length), locked_total: sum(lock), on_hold: BigInt(hold.length) }];
}

function wireSolo(rows: Row[], anthropic?: ReturnType<typeof makeMockAnthropic>) {
  const prisma = makeMockPrisma();
  wireSoloDefaults(prisma, { coachId: 'coach1', clientIds: ['c1'] });
  prisma.$queryRaw.mockImplementation(async (arg: Prisma.Sql) => {
    if (!arg.strings.join('?').includes('"DunningState"')) return [{ count: 0n, total: 0n }];
    return answerDunningSql(arg, rows);
  });
  const svc = new CoachBriefService(
    asPrismaService(prisma),
    asConfig(makeMockConfig()),
    grantAllEgress(),
    ...(anthropic ? [asAnthropic(anthropic)] : []),
  );
  return { prisma, svc };
}

const aggregateSolo = (svc: CoachBriefService) =>
  svc['aggregateSoloContext']('coach1', ['c1'], 'America/Los_Angeles', '2026-10-30', 'solo_coach');

function callClaude(svc: CoachBriefService, ctx: BriefContext | BriefContextHeadCoach) {
  const ai: BriefAiInput = {
    ctx,
    subject:
      ctx.brief_mode === 'head_coach'
        ? noClientDataSubject('coach_business_metrics', 'coach1')
        : clientDataSubject(['client-1'], 'coach', 'base', 'coach1'),
  };
  return svc.callClaude(ctx, ai);
}

describe('PF-5-BE dunningBriefSql: the three states are counted apart', () => {
  it('reads the old column names for inside the 10 days, plus locked and on hold', () => {
    expect(readDunningBrief({ count: 2n, total: 29800n, locked: 1n, locked_total: 14900n, on_hold: 3n })).toEqual({
      inWindow: 2, inWindowCents: 29800, locked: 1, lockedCents: 14900, onHold: 3,
    });
    expect(readDunningBrief(undefined)).toEqual({ inWindow: 0, inWindowCents: 0, locked: 0, lockedCents: 0, onHold: 0 });
  });

  it('keeps the scope the caller gives (solo: own sales; head coach: tenant clients)', () => {
    const solo = dunningBriefSql(Prisma.sql`cp."coach_user_id" = ${'coach1'}`);
    expect(solo.strings.join('?')).toMatch(/AND cp\."coach_user_id" = \?/);
    expect(solo.values).toContain('coach1');
    const head = dunningBriefSql(Prisma.sql`cp."client_user_id" = ANY(${['c1', 'c2']}::text[])`);
    expect(head.strings.join('?')).toMatch(/cp\."client_user_id" = ANY\(\?::text\[\]\)/);
  });
});

describe('PF-5-BE solo coach brief: each dunning state with its approved line', () => {
  it.each([
    ['inside the 10 days', [inWindow()], { dunning_in_progress: 1, dunning_locked: 0, dunning_on_hold: 0 }, W1],
    ['a Day-10 lock', [dayTenLock()], { dunning_in_progress: 0, dunning_locked: 1, dunning_on_hold: 0 }, W2],
    ['a full-refund pause', [refundHold()], { dunning_in_progress: 0, dunning_locked: 0, dunning_on_hold: 1 }, W3],
    ['a bank dispute pause', [disputeHold()], { dunning_in_progress: 0, dunning_locked: 0, dunning_on_hold: 1 }, W3],
  ])('%s', async (_label, rows, counts, line) => {
    const { svc } = wireSolo(rows);
    const { context } = await aggregateSolo(svc);
    expect(context).toEqual(expect.objectContaining(counts));
    const fallback = buildFallbackNarrative(context);
    expect(fallback).toContain(line);
    expect(fallback).not.toMatch(RETRY_PROMISE);
    const prompt = buildBriefPrompt(context);
    expect(prompt).toContain(line);
    expect(prompt).not.toMatch(RETRY_PROMISE);
    expect(briefPaymentLines(context)).toEqual([line]);
  });

  it('a client who ended the plan mid-cycle is not "being reminded"', async () => {
    const { svc } = wireSolo([{ ...inWindow(), client_canceled_at: LOCKED_AT }]);
    const { context } = await aggregateSolo(svc);
    expect(context.dunning_in_progress).toBe(0);
    expect(briefPaymentLines(context)).toEqual([]);
  });

  it('all three states: one fallback element, check-in and waiting lines survive the 5-element cap', async () => {
    const ctx = makeBriefContext({
      revenue_today_cents: 9800,
      paid_today_count: 1,
      dunning_in_progress: 3,
      dunning_locked: 2,
      dunning_on_hold: 1,
      unread_messages: 2,
      weight_logs_flagged: 1,
    });
    const text = buildFallbackNarrative(ctx);
    expect(text).toContain(
      '3 payments failed. TGP is reminding the clients to update their card. ' +
        'Access is paused on 2 plans after 10 days unpaid. It comes back when the clients pay. ' +
        '1 plan is on hold after a refund or a bank dispute. Only you can restart it.',
    );
    expect(text).toMatch(/checked in/i);
    expect(text).toMatch(/waiting/i);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toMatch(RETRY_PROMISE);
  });

  it('the owner example: inside the 10 days plus a hold reads as approved', () => {
    const ctx = makeBriefContext({ dunning_in_progress: 1, dunning_on_hold: 1 });
    expect(buildFallbackNarrative(ctx)).toContain(
      '1 payment failed. TGP is reminding the client to update their card. 1 plan is on hold after a refund or a bank dispute. Only you can restart it.',
    );
  });

  it('the system prompts promise no retry and ask for the payment lines word for word', () => {
    for (const p of [buildSoloCoachSystemPrompt(), buildHeadCoachSystemPrompt()]) {
      expect(p).not.toMatch(/run automatically|say the retries/i);
      expect(p).toMatch(/PAYMENT LINES are given, copy each one word for word/);
      expect(p).toMatch(/never say a payment is being retried or that nothing is needed from the coach/);
    }
  });
});

describe('PF-5-BE head coach brief: each dunning state with its approved line', () => {
  it.each([
    ['inside the 10 days', { dunning_in_progress: 1, dunning_amount_cents: 14900 }, '1 payment worth $149.00 failed. TGP is reminding the client to update their card.', '1 failed payment ($149.00)'],
    ['a Day-10 lock', { dunning_in_progress: 0, dunning_amount_cents: 0, dunning_locked: 1, dunning_locked_amount_cents: 14900 }, W2, '1 failed payment ($149.00)'],
    ['a full-refund or dispute pause', { dunning_in_progress: 0, dunning_amount_cents: 0, dunning_on_hold: 1 }, W3_HEAD, null],
  ])('%s', (_label, over, line, todo) => {
    const ctx = makeHeadCoachContext(over);
    const fallback = buildFallbackNarrative(ctx);
    expect(fallback).toContain(line);
    expect(fallback).not.toMatch(RETRY_PROMISE);
    expect(fallback).not.toMatch(/No failed payments/);
    const prompt = buildBriefPrompt(ctx);
    expect(prompt).toContain(line);
    expect(prompt).not.toMatch(RETRY_PROMISE);
    const item = buildHeadCoachActionItems(ctx).find((i) => i.type === 'dunning_queue');
    if (todo) {
      expect(item?.detail).toBe(todo);
    } else {
      expect(item).toBeUndefined();
    }
  });

  it('PF-W4: 3 payments worth $447.00, then the lock and hold lines; to-do "3 failed payments ($447.00)"', () => {
    const ctx = makeHeadCoachContext({ dunning_in_progress: 3, dunning_amount_cents: 44700, dunning_locked: 1, dunning_locked_amount_cents: 14900, dunning_on_hold: 1 });
    expect(buildFallbackNarrative(ctx)).toContain(
      '3 payments worth $447.00 failed. TGP is reminding the clients to update their card. ' + W2 + ' ' + W3_HEAD,
    );
    const only = makeHeadCoachContext({ dunning_in_progress: 3, dunning_amount_cents: 44700 });
    expect(buildHeadCoachActionItems(only).find((i) => i.type === 'dunning_queue')?.detail).toBe('3 failed payments ($447.00)');
    // a Day-10 lock is still a failed payment on the to-do item
    expect(buildHeadCoachActionItems(ctx).find((i) => i.type === 'dunning_queue')?.detail).toBe('4 failed payments ($596.00)');
  });

  it('no dunning at all still says no failed payments need chasing', () => {
    const ctx = makeHeadCoachContext({ dunning_in_progress: 0, dunning_amount_cents: 0 });
    expect(buildFallbackNarrative(ctx)).toContain('No failed payments need chasing.');
    expect(buildBriefPrompt(ctx)).toContain('PAYMENT LINES: none');
  });
});

describe('PF-5-BE AI writer on and off', () => {
  const soloAi = (lines: string) =>
    `Sarah, five of seven clients checked in today. ${lines} Two clients still need a nudge before tonight.`;

  it.each([
    ['inside the 10 days', { dunning_in_progress: 1 }, W1],
    ['a Day-10 lock', { dunning_locked: 1 }, W2],
    ['a refund or dispute hold', { dunning_on_hold: 1 }, W3],
  ])('solo, %s: AI text with the approved line is kept', async (_l, over, line) => {
    const anthropic = makeMockAnthropic(soloAi(line));
    const { svc } = wireSolo([], anthropic);
    const out = await callClaude(svc, makeBriefContext(over));
    expect(out.generated_by).toBe('ai');
    expect(out.narrative).toContain(line);
    const body = anthropic.messages.create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(JSON.stringify(body)).toContain(line);
  });

  it.each([
    ['a retry promise', 'One failed payment is being retried automatically.'],
    ['a paraphrase of the approved line', 'One client still owes a payment.'],
  ])('solo: AI text with %s is refused and the fallback says the approved line', async (_l, bad) => {
    const anthropic = makeMockAnthropic(soloAi(bad));
    const { svc } = wireSolo([], anthropic);
    const ctx = makeBriefContext({ dunning_on_hold: 1 });
    const out = await callClaude(svc, ctx);
    expect(out.generated_by).toBe('fallback');
    expect(out.narrative).toContain(W3);
    expect(out.narrative).not.toMatch(RETRY_PROMISE);
  });

  it('head coach: AI text must carry the head-coach lines word for word', async () => {
    const ctx = makeHeadCoachContext({ dunning_in_progress: 1, dunning_amount_cents: 14900, dunning_on_hold: 1 });
    const lines = briefPaymentLines(ctx).join(' ');
    const good = `Sarah, the team brought in money today. ${lines}`;
    const anthropic = makeMockAnthropic(good);
    const { svc } = wireSolo([], anthropic);
    const out = await callClaude(svc, ctx);
    expect(out.generated_by).toBe('ai');
    expect(out.narrative).toContain(W3_HEAD);
  });

  it.each([
    ['solo', makeBriefContext({ dunning_locked: 1 }), W2],
    ['head coach', makeHeadCoachContext({ dunning_in_progress: 0, dunning_amount_cents: 0, dunning_on_hold: 1 }), W3_HEAD],
  ])('AI writer off (%s, no AI input): the fallback says the approved line', async (_l, ctx, line) => {
    const anthropic = makeMockAnthropic('unused');
    const { svc } = wireSolo([], anthropic);
    const out = await svc.callClaude(ctx, null);
    expect(out.generated_by).toBe('fallback');
    expect(out.narrative).toContain(line);
    expect(out.narrative).not.toMatch(RETRY_PROMISE);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('validateClaudeNarrative: retry words and a missing payment line are both refused', () => {
    const base = 'Sarah, five clients checked in. Two still need a nudge.';
    expect(validateClaudeNarrative(base, 'Sarah')).toBeNull();
    expect(validateClaudeNarrative(`${base} TGP will retry the card.`, 'Sarah')).toBe('payment_retry_promise');
    expect(validateClaudeNarrative(base, 'Sarah', [W1])).toBe('missing_payment_line');
    expect(validateClaudeNarrative(`Sarah, five clients checked in. ${W1}`, 'Sarah', [W1])).toBeNull();
  });

  // FR-1191R2 (LO-1191R2B C2): the same promise in other words is refused, and
  // no approved line (alone or together) is ever refused.
  const base = 'Sarah, five clients checked in. Two still need a nudge.';
  it.each([
    'Stripe will charge the card again tomorrow.',
    'The payment will be attempted again on Friday.',
    'TGP will try the card once more.',
    'The failed payment is being handled automatically.',
    'No action is needed from you on that payment.',
    'Nothing needed from you there.',
  ])('validateClaudeNarrative refuses a retry promise in other words: %s', (bad) => {
    expect(validateClaudeNarrative(`${base} ${bad}`, 'Sarah')).toBe('payment_retry_promise');
  });
  it.each([
    ['W1', [W1]],
    ['W2', [W2]],
    ['W3', [W3]],
    ['W3 (head coach)', [W3_HEAD]],
    ['all three', [W1, W2, W3]],
  ])('validateClaudeNarrative keeps the approved line(s): %s', (_l, lines) => {
    expect(validateClaudeNarrative(`${base} ${lines.join(' ')}`, 'Sarah', lines)).toBeNull();
  });

  // FR-1191R2 (LO-1191R2B C1): the repair prompt counts the payment lines
  // apart, like the system prompts and the validator.
  it('the repair prompt does not count the payment lines in the 2 to 4 sentences or 450 characters', async () => {
    const anthropic = makeMockAnthropic(soloAi('One client still owes a payment.'));
    const { svc } = wireSolo([], anthropic);
    await callClaude(svc, makeBriefContext({ dunning_on_hold: 1 }));
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
    const repair = JSON.stringify(anthropic.messages.create.mock.calls[1][0]);
    expect(repair).toContain('2 to 4 complete sentences, not counting the payment lines');
    expect(repair).toContain('not counting the payment lines; with them the whole brief stays under 600 characters');
    expect(repair).toContain(W3);
  });
});
