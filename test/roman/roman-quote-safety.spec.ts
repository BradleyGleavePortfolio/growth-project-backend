// test/roman/roman-quote-safety.spec.ts
//
// ROMAN-QUOTE-SAFETY-BE (T4): a Reply in the member's Roman room sends "> " + an excerpt of one of Roman's replies,
// a blank line and the member's own words (growth-project-mobile#950). The server's deterministic crisis check
// reads the member's own words only when that excerpt is proven to open a stored Roman reply in the member's own
// client-surface chat; anything unproven is classified whole, exactly as before. The real router here: every input
// that would short-circuit is one of Roman's own fixed replies (ROMAN_SAFETY_TEMPLATES), never a member sample.
// Case numbers are the job's. No network, no DB.

import { FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV } from '../../src/roman/roman.feature';
import { ROMAN_COACH_TOLD_LINE, ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import * as router from '../../src/roman/guardrails/safety-router';
import {
  CHAT,
  COACH_CALLER,
  COACH_ROOM,
  MEMBER_CALLER,
  MODEL_SAYS,
  NEUTRAL_BODY,
  NEUTRAL_REPLY,
  OLDER_CHAT,
  OTHER_MEMBER_CHAT,
  romanQuoteExcerpt,
  withRomanQuote,
  world,
} from './roman-quote-safety.harness';

// Records what the check receives; the real classifier answers.
jest.mock('../../src/roman/guardrails/safety-router', () => {
  const actual = jest.requireActual('../../src/roman/guardrails/safety-router');
  return { ...actual, classifySafety: jest.fn((...a: [string, string?]) => actual.classifySafety(...a)) };
});
const classify = router.classifySafety as unknown as jest.Mock<router.SafetyRouteResult, [string, string?]>;

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const CRISIS = FEATURE_ROMAN_CRISIS_ALERT_ENV;
let saved: Array<string | undefined> = [];
beforeEach(() => {
  saved = [process.env[FLAG], process.env[CRISIS]];
  process.env[FLAG] = 'true';
  // The crisis alert switch on, as test/roman/roman-urgent-symptoms.spec.ts sets it inside a test: a repeat alert shows.
  process.env[CRISIS] = 'true';
  classify.mockClear();
});
afterEach(() => {
  [FLAG, CRISIS].forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
});

const SELF_HARM = ROMAN_SAFETY_TEMPLATES.self_harm;
const FIXED = Object.values(ROMAN_SAFETY_TEMPLATES);
const isFixed = (text: string | undefined) => FIXED.some((t) => (text ?? '').startsWith(t));
/** The member's first and only bodies passed to the check (first argument). */
const messagesChecked = () => classify.mock.calls.map((c) => c[0]);

describe('the inputs mean what the cases say (real router, classes only)', () => {
  it('Roman\'s self_harm reply alone, and behind a neutral quote, short-circuits; a neutral body is normal', () => {
    expect(router.classifySafety(SELF_HARM)).toMatchObject({ class: 'self_harm', short_circuit: true });
    expect(router.classifySafety(withRomanQuote(SELF_HARM, NEUTRAL_BODY))).toMatchObject({ class: 'self_harm', short_circuit: true });
    expect(router.classifySafety(withRomanQuote(NEUTRAL_REPLY, SELF_HARM)).short_circuit).toBe(true);
    expect(router.classifySafety(NEUTRAL_BODY).class).toBe('normal');
    expect(router.classifySafety(withRomanQuote(ROMAN_SAFETY_TEMPLATES.urgent_symptoms, NEUTRAL_BODY)).class).toBe('medical_scope');
  });
});

describe('ROMAN-QUOTE-SAFETY-BE: a proven quote of Roman is not read as the member\'s words', () => {
  it('1: Reply on Roman\'s stored self_harm reply with a neutral body: no short-circuit at either check, the model answers, no fixed reply, no alert', async () => {
    const w = world();
    w.store(CHAT, 'roman', SELF_HARM);
    const sent = withRomanQuote(SELF_HARM, NEUTRAL_BODY);
    const { done } = await w.send(sent);
    expect(await w.preCheck.mock.results[0].value).toBe(false);
    expect(w.modelCalls).toHaveLength(1);
    expect(done?.text).toBe(MODEL_SAYS);
    expect(isFixed(done?.text)).toBe(false);
    expect(w.alerts.createAlert).not.toHaveBeenCalled();
    expect(messagesChecked().every((m) => m === NEUTRAL_BODY)).toBe(true);
  });

  it('2: the same when the stored reply carries ROMAN_COACH_TOLD_LINE', async () => {
    const w = world();
    const told = `${SELF_HARM} ${ROMAN_COACH_TOLD_LINE}`;
    w.store(CHAT, 'roman', told);
    const { done } = await w.send(withRomanQuote(told, NEUTRAL_BODY));
    expect(await w.preCheck.mock.results[0].value).toBe(false);
    expect(w.modelCalls).toHaveLength(1);
    expect(done?.text).toBe(MODEL_SAYS);
    expect(w.alerts.createAlert).not.toHaveBeenCalled();
  });

  it('4: the urgent_symptoms fixed reply quoted with a neutral body: class normal, not medical_scope, and no router hint', async () => {
    const w = world();
    const urgent = ROMAN_SAFETY_TEMPLATES.urgent_symptoms;
    w.store(CHAT, 'roman', urgent);
    await w.send(withRomanQuote(urgent, NEUTRAL_BODY));
    expect(classify.mock.results.map((r) => (r.value as router.SafetyRouteResult).class)).toEqual(['normal', 'normal', 'normal']);
    expect(w.modelCalls).toHaveLength(1);
    expect(w.modelCalls[0].system).not.toContain('ROUTER HINT');
    expect(w.alerts.createAlert).not.toHaveBeenCalled();
  });

  it('5: a medicine named only in an old quote is not in `earlier`; one in the member\'s own earlier words still is', async () => {
    const w = world();
    const romanNamed = 'Ask your prescriber about semaglutide timing before a long run.';
    w.store(CHAT, 'roman', romanNamed);
    w.store(CHAT, 'user', withRomanQuote(romanNamed, NEUTRAL_BODY));
    w.store(CHAT, 'user', 'Week two on tirzepatide.');
    await w.send(NEUTRAL_BODY);
    const earliers = classify.mock.calls.map((c) => c[1]).filter((e): e is string => e !== undefined);
    expect(earliers).toHaveLength(2); // the pre-check and the answering check
    for (const earlier of earliers) {
      expect(earlier).toContain('tirzepatide');
      expect(earlier).not.toContain('semaglutide');
      expect(earlier).toContain(NEUTRAL_BODY);
    }
  });

  it('9: Roman\'s self_harm text as the body behind a proven neutral quote still short-circuits', async () => {
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    const { done } = await w.send(withRomanQuote(NEUTRAL_REPLY, SELF_HARM));
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(w.modelCalls).toHaveLength(0);
    expect(done?.text).toBe(`${SELF_HARM} ${ROMAN_COACH_TOLD_LINE}`);
    expect(w.alerts.createAlert).toHaveBeenCalledTimes(1);
  });

  it('15: every excerpt form the phone makes is proven (each from the self_harm reply, so a miss short-circuits)', async () => {
    const shortReply = SELF_HARM.split('. ')[1] + '.';
    expect(shortReply.length).toBeLessThan(200);
    expect(router.classifySafety(shortReply).short_circuit).toBe(true);
    const longBody = `${'Fine. '.repeat(1316)}Ok.`.trim();
    const forms: Array<{ name: string; stored: string; copilot?: unknown; body?: string }> = [
      { name: '** and __', stored: SELF_HARM.replace('I am sorry', '**I am sorry**').replace('988 Suicide', '__988__ Suicide') },
      { name: 'newlines', stored: SELF_HARM.replace(/\. /g, '.\n\n') },
      { name: 'a cut ending in U+2026', stored: SELF_HARM },
      { name: 'a limit shrunk near 8,000', stored: SELF_HARM, body: longBody },
      { name: 'a reply shorter than the limit', stored: shortReply },
      {
        name: 'a Copilot row with [n] markers',
        stored: SELF_HARM.replace('rather than holding it alone.', 'rather than holding it alone [1].').replace('988 Suicide', '988 [2] Suicide'),
        copilot: { question_id: null, sources: [], suggestion_id: null },
      },
    ];
    for (const f of forms) {
      const w = world();
      w.store(CHAT, 'roman', f.stored, f.copilot ?? null);
      const body = f.body ?? NEUTRAL_BODY;
      // The room shows a Copilot row without its [n] (GET messages without the Copilot header): that is what it quotes.
      const shown = (await w.list()).messages.find((m) => m.role === 'roman')!.content;
      const sent = withRomanQuote(shown, body);
      expect({ form: f.name, quoted: sent.startsWith('> ') }).toEqual({ form: f.name, quoted: true });
      if (f.name === 'a cut ending in U+2026') expect(sent.split('\n')[0].endsWith('…')).toBe(true);
      if (f.name === 'a limit shrunk near 8,000') expect(sent.split('\n')[0].length).toBeLessThan(120);
      await w.send(sent);
      expect({ form: f.name, short: await w.preCheck.mock.results[0].value }).toEqual({ form: f.name, short: false });
      expect({ form: f.name, model: w.modelCalls.length, alerts: w.alerts.createAlert.mock.calls.length }).toEqual({ form: f.name, model: 1, alerts: 0 });
      classify.mockClear();
    }
  });

  it('15: only the first line goes: a body that itself starts with "> " keeps it', async () => {
    const w = world();
    w.store(CHAT, 'roman', SELF_HARM);
    const body = `> ${NEUTRAL_BODY}`;
    await w.send(withRomanQuote(SELF_HARM, body));
    expect(messagesChecked()).toEqual([body, body, body]);
    expect(await w.preCheck.mock.results[0].value).toBe(false);
  });
});

describe('ROMAN-QUOTE-SAFETY-BE: anything unproven is classified whole, as today (guards, green before and after)', () => {
  it('11: the same excerpt stored as Roman\'s in another member\'s chat (sent to that chat\'s id), or in another chat of this member: whole turn, short-circuit', async () => {
    const sent = withRomanQuote(SELF_HARM, NEUTRAL_BODY);
    const other = world();
    other.store(OTHER_MEMBER_CHAT, 'roman', SELF_HARM);
    // The pre-check runs before the chat is checked as the caller's (roman.controller.ts getOwnedSession).
    await expect(other.svc.isSafetyShortCircuit(MEMBER_CALLER, OTHER_MEMBER_CHAT, sent)).resolves.toBe(true);
    for (const call of other.romanReads()) expect(call[0].where).toMatchObject({ user_id: MEMBER_CALLER.id });

    const older = world();
    older.store(OLDER_CHAT, 'roman', SELF_HARM);
    const { done } = await older.send(sent);
    expect(await older.preCheck.mock.results[0].value).toBe(true);
    expect(done?.text).toBe(`${SELF_HARM} ${ROMAN_COACH_TOLD_LINE}`);
    expect(older.modelCalls).toHaveLength(0);
  });

  it('12: a coach-surface chat with a matching Roman reply: unproven, whole turn (the coach prompt has no crisis section)', async () => {
    const w = world();
    w.store(COACH_ROOM, 'roman', SELF_HARM);
    await expect(w.svc.isSafetyShortCircuit(COACH_CALLER, COACH_ROOM, withRomanQuote(SELF_HARM, NEUTRAL_BODY))).resolves.toBe(true);
  });

  it('13: not the shape (one newline, leading space, no space after ">", blank body, quote on the second line): the check receives the raw text', async () => {
    const q = romanQuoteExcerpt(NEUTRAL_REPLY);
    const texts = [
      `> ${q}\n${NEUTRAL_BODY}`,
      ` > ${q}\n\n${NEUTRAL_BODY}`,
      `>${q}\n\n${NEUTRAL_BODY}`,
      `> ${q}\n\n   `,
      `${NEUTRAL_BODY}\n> ${q}\n\n${NEUTRAL_BODY}`,
    ];
    for (const text of texts) {
      const w = world();
      w.store(CHAT, 'roman', NEUTRAL_REPLY);
      classify.mockClear();
      await w.svc.isSafetyShortCircuit(MEMBER_CALLER, CHAT, text);
      expect(classify.mock.calls[0][0]).toBe(text);
      expect(w.romanReads()).toHaveLength(0);
    }
  });

  it('14: no shape anywhere: no Roman-row read at either check, and the check receives the raw text', async () => {
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    w.store(CHAT, 'user', NEUTRAL_BODY);
    await w.send(NEUTRAL_BODY);
    expect(w.romanReads()).toHaveLength(0);
    expect(messagesChecked()).toEqual([NEUTRAL_BODY, NEUTRAL_BODY, NEUTRAL_BODY]);
  });

  function failingRead() {
    const w = world();
    w.store(CHAT, 'roman', SELF_HARM);
    const real = w.romanMessage.findMany.getMockImplementation()!;
    w.romanMessage.findMany.mockImplementation(async (args) => {
      if ((args?.where as { role?: string } | undefined)?.role === 'roman') throw new TypeError(`read failed: ${SELF_HARM}`);
      return real(args);
    });
    return w;
  }

  it('16: the Roman-row read throws: whole turn, no throw, and no log line carries text', async () => {
    const w = failingRead();
    const { done } = await w.send(withRomanQuote(SELF_HARM, NEUTRAL_BODY));
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(done?.text).toBe(`${SELF_HARM} ${ROMAN_COACH_TOLD_LINE}`);
    for (const l of w.warn.mock.calls.map((c) => String(c[0]))) {
      expect(l).not.toContain('988');
      expect(l).not.toContain(NEUTRAL_BODY);
    }
  });

  it('16: the failed quote read is logged by its code only (the read is new, so this line is new)', async () => {
    const w = failingRead();
    await w.send(withRomanQuote(SELF_HARM, NEUTRAL_BODY));
    const lines = w.warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('roman.safety_quote_failed'))).toEqual(
      expect.arrayContaining(['roman.safety_quote_failed: TypeError']),
    );
  });

  it('17: the stored row, GET messages and the model\'s input keep the quote exactly as sent', async () => {
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    const sent = withRomanQuote(NEUTRAL_REPLY, NEUTRAL_BODY);
    await w.send(sent);
    expect(w.rows.filter((r) => r.role === 'user').map((r) => r.content)).toEqual([sent]);
    expect((await w.list()).messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([sent]);
    const last = w.modelCalls[0].messages[w.modelCalls[0].messages.length - 1];
    expect(last).toEqual({ role: 'user', content: sent });
  });

  it('18: the pre-check, the eating-disorder test and the answering check read the same words, and the stored quoted turn is skipped from `earlier`', async () => {
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    w.store(CHAT, 'user', 'An earlier line about leg day.');
    const sent = withRomanQuote(NEUTRAL_REPLY, NEUTRAL_BODY);
    await w.send(sent);
    const calls = classify.mock.calls;
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c[0])).size).toBe(1);
    const earliers = calls.map((c) => c[1]).filter((e): e is string => e !== undefined);
    expect(earliers).toEqual(['An earlier line about leg day.', 'An earlier line about leg day.']);
  });

  it('19: a keyed resend of a quoted turn is the replay: no second alert, no extra model call', async () => {
    const w = world();
    w.store(CHAT, 'roman', SELF_HARM);
    const sent = withRomanQuote(SELF_HARM, NEUTRAL_BODY);
    const key = w.key();
    const first = await w.send(sent, { key });
    const model = w.modelCalls.length;
    const alerts = w.alerts.createAlert.mock.calls.length;
    const again = await w.send(sent, { key });
    expect(again.frames).toEqual(first.frames);
    expect(w.modelCalls.length).toBe(model);
    expect(w.alerts.createAlert.mock.calls.length).toBe(alerts);
    expect(w.rows.filter((r) => r.role === 'user')).toHaveLength(1);
  });
});
