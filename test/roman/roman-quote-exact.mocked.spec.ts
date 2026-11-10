// test/roman/roman-quote-exact.mocked.spec.ts
//
// ROMAN-QUOTE-READERS-BE (T4): a quote proves only as the phone's exact excerpt (LS-1236R1 C1 = LO-1236R1 C1). The
// crisis lists the Roman router imports (src/ai/ai-crisis-router.ts) are swapped for made-up tokens that mean
// nothing, one of them a two-token pattern (LO-1236R1 probe P1), so no crisis wording is written here and each case
// shows exactly which characters the deterministic check read. Case numbers are the job's. The real controller and
// RomanService over b#1236's in-memory harness. No network, no DB.

import { FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV } from '../../src/roman/roman.feature';
import { ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import * as router from '../../src/roman/guardrails/safety-router';
import { romanQuoteExcerpt as srcExcerpt } from '../../src/roman/guardrails/roman-quote';
import {
  CHAT, MODEL_SAYS, NEUTRAL_BODY, NEUTRAL_REPLY, ROMAN_MESSAGE_MAX_LENGTH, ROMAN_QUOTE_MAX, romanQuoteExcerpt, withRomanQuote, world,
} from './roman-quote-safety.harness';

jest.mock('../../src/ai/ai-crisis-router', () => {
  const actual = jest.requireActual('../../src/ai/ai-crisis-router');
  return {
    ...actual,
    CRISIS_EMERGENCY_PATTERNS: [/\bzorvex\b/i, /\bglimmet\s+snorpa\b/i],
    CRISIS_SELF_HARM_PATTERNS: [/\bbramblet\b/i],
  };
});
// Records what the check receives; the real classifier (over the lists above) answers.
jest.mock('../../src/roman/guardrails/safety-router', () => {
  const actual = jest.requireActual('../../src/roman/guardrails/safety-router');
  return { ...actual, classifySafety: jest.fn((...a: [string, string?]) => actual.classifySafety(...a)) };
});
const classify = router.classifySafety as unknown as jest.Mock<router.SafetyRouteResult, [string, string?]>;
const read = () => classify.mock.calls.map((c) => c[0]);
/** The phone's limit for a body (withRomanQuote, harness copy); the behaviour cases use only the phone's copy. */
const phoneLimit = (body: string) => Math.min(ROMAN_QUOTE_MAX, ROMAN_MESSAGE_MAX_LENGTH - body.length - 4);

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const CRISIS = FEATURE_ROMAN_CRISIS_ALERT_ENV;
let saved: Array<string | undefined> = [];
beforeEach(() => {
  saved = [process.env[FLAG], process.env[CRISIS]];
  process.env[FLAG] = 'true';
  delete process.env[CRISIS];
  classify.mockClear();
});
afterEach(() => {
  [FLAG, CRISIS].forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
});

const FILLER = ' Start with two easy rounds, rest a minute between them, and keep the pace slow enough to talk the whole way.';
/** A model-written reply longer than the phone's cut whose first word is the first made-up token. */
const GLIMMET_REPLY = `Glimmet is the warm-up we start with on Mondays.${FILLER}${FILLER}`;
/** A model-written reply longer than the cut whose opening holds a listed token. */
const ZORVEX_LONG = `Zorvex is the name of the stretch we did on Monday.${FILLER}${FILLER}`;
/** A short one, under the cut: the phone quotes it whole. */
const ZORVEX_SHORT = 'Zorvex is the name of the stretch we did on Monday. Hold it for thirty seconds each side.';
/** Neutral, longer than the cut. */
const LONG_NEUTRAL = `Here is your plan for the week.${FILLER}${FILLER}`;
const NEAR_CAP = 'Thanks, I will do that. '.repeat(325).trim(); // 7,799 characters: the phone's limit shrinks to 197
/** Case 3: every form the phone makes. */
const FORMS: Array<[string, string, string, unknown]> = [
  ['a whole reply under the limit', NEUTRAL_REPLY, NEUTRAL_BODY, null],
  ['a cut at 200', LONG_NEUTRAL, NEUTRAL_BODY, null],
  ['a limit shrunk by a body near 7,800 characters', LONG_NEUTRAL, NEAR_CAP, null],
  ['** and __', '**Squats** first, then __rest__ for two minutes and walk it off.', NEUTRAL_BODY, null],
  ['newlines', 'Line one of the plan.\n\nLine two of the plan.\nLine three.', NEUTRAL_BODY, null],
  ['whitespace runs', 'Warm   up\t\tfor  five minutes,   then  stretch.', NEUTRAL_BODY, null],
  ['a Copilot row with [n]', 'Your protein is on track [1]. Keep the same breakfast [2].', NEUTRAL_BODY, { sources: [] }],
  ['a reply that itself ends in U+2026', 'We can pick the rest of this up tomorrow…', NEUTRAL_BODY, null],
  ['a long reply that itself ends in U+2026', `${LONG_NEUTRAL} More tomorrow…`, NEUTRAL_BODY, null],
];

describe('the made-up lists stand in for the real ones', () => {
  it('the two-token pattern matches only across both tokens; the long replies are longer than the cut', () => {
    expect(router.classifySafety('glimmet snorpa').short_circuit).toBe(true);
    expect(router.classifySafety('> Glimmet\n\nsnorpa').short_circuit).toBe(true);
    expect(router.classifySafety('snorpa').short_circuit).toBe(false);
    expect(router.classifySafety(GLIMMET_REPLY).short_circuit).toBe(false);
    expect(router.classifySafety(NEUTRAL_BODY).class).toBe('normal');
    for (const r of [GLIMMET_REPLY, ZORVEX_LONG, LONG_NEUTRAL]) expect(r.length).toBeGreaterThan(200);
    expect(ZORVEX_SHORT.length).toBeLessThan(200);
  });
});

describe('ROMAN-QUOTE-READERS-BE: a quote proves only as the phone\'s exact excerpt', () => {
  it('1 (Red, LO-1236R1 P1): a hand-typed first token on the quote line, the second as the body: both checks read the whole turn; the fixed reply', async () => {
    const w = world();
    w.store(CHAT, 'roman', GLIMMET_REPLY);
    const sent = '> Glimmet\n\nsnorpa';
    const { done } = await w.send(sent);
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    // The pre-check and the answering check (streamAssistantTurn) both read the text as sent.
    expect(read()).toEqual([sent, sent]);
    expect(w.modelCalls).toHaveLength(0);
    expect(done?.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
  });

  it.each([
    ['the first few words of a reply, shorter than the cut, no U+2026', '> Zorvex is the name\n\n'],
    ['a cut with U+2026 at a length the phone would not make for this body', `> ${romanQuoteExcerpt(ZORVEX_LONG, 60)}\n\n`],
  ])('2 (Red): %s: whole turn, short-circuit', async (_name, head) => {
    const w = world();
    w.store(CHAT, 'roman', ZORVEX_LONG);
    const sent = `${head}${NEUTRAL_BODY}`;
    const { done } = await w.send(sent);
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(read()).toEqual([sent, sent]);
    expect(done?.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
  });

  it.each(FORMS)('3: %s: proven, every check reads the body alone', async (_name, reply, body, copilot) => {
    const w = world();
    w.store(CHAT, 'roman', reply, copilot);
    // The room's view of the reply (GET messages: a Copilot row without its [n]), quoted the phone's way.
    const view = (await w.list()).messages.find((m) => m.role === 'roman')!.content;
    const sent = withRomanQuote(view, body);
    expect(sent.startsWith('> ')).toBe(true);
    const { done } = await w.send(sent);
    expect(read().length).toBeGreaterThan(0);
    expect(read().every((t) => t === body)).toBe(true);
    expect(done?.text).toBe(MODEL_SAYS);
  });

  it.each(FORMS)('3: the src excerpt equals the phone\'s copy for this form: %s', (_name, reply, body) => {
    const view = reply.replace(/ ?\[\d+\]/g, ''); // the room's view of a Copilot row (withoutCites)
    expect(srcExcerpt(view, phoneLimit(body))).toBe(romanQuoteExcerpt(view, phoneLimit(body)));
  });

  it('3: the src excerpt equals the phone\'s copy on every limit from 1 to 200 and past the reply\'s length', () => {
    const forms = [NEUTRAL_REPLY, LONG_NEUTRAL, '**a** __b__  c\n\nd\te', 'We can pick this up tomorrow…', ` ${LONG_NEUTRAL} `];
    for (const f of forms) for (let n = 1; n <= 210; n++) expect(srcExcerpt(f, n)).toBe(romanQuoteExcerpt(f, n));
  });

  it('4: a hand-typed quote equal to a whole short reply proves (it is its own excerpt)', async () => {
    const w = world();
    w.store(CHAT, 'roman', ZORVEX_SHORT);
    const sent = `> ${ZORVEX_SHORT}\n\n${NEUTRAL_BODY}`;
    expect(sent).toBe(withRomanQuote(ZORVEX_SHORT, NEUTRAL_BODY));
    const { done } = await w.send(sent);
    expect(await w.preCheck.mock.results[0].value).toBe(false);
    expect(read().every((t) => t === NEUTRAL_BODY)).toBe(true);
    expect(done?.text).toBe(MODEL_SAYS);
  });

  it.each([7996, 7997])('5: a body of %i characters leaves a limit below 1: no quote proves, the whole turn is read', async (n) => {
    const w = world();
    w.store(CHAT, 'roman', ZORVEX_LONG);
    const body = 'k'.repeat(n);
    expect(phoneLimit(body)).toBeLessThan(1);
    // The phone sends no quote here; "…" is what an unguarded excerpt at that limit would be.
    expect(romanQuoteExcerpt(ZORVEX_LONG, 1)).toBe('…');
    const sent = `> …\n\n${body}`;
    await w.send(sent);
    expect(read()[0]).toBe(sent);
  });

  it('8: two stored Roman replies, the quote of the older one: proven at the crisis check (LS-1236R1 C2)', async () => {
    const w = world();
    w.store(CHAT, 'roman', ZORVEX_SHORT);
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    const sent = withRomanQuote(ZORVEX_SHORT, NEUTRAL_BODY);
    const { done } = await w.send(sent);
    expect(await w.preCheck.mock.results[0].value).toBe(false);
    expect(read().every((t) => t === NEUTRAL_BODY)).toBe(true);
    expect(w.modelCalls).toHaveLength(1);
    expect(done?.text).toBe(MODEL_SAYS);
  });
});
