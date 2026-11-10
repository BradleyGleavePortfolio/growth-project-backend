// test/roman/roman-quote-safety.mocked.spec.ts
//
// ROMAN-QUOTE-SAFETY-BE (T4), the crisis lists replaced: the emergency and self-harm lists the Roman router imports
// (src/ai/ai-crisis-router.ts:271-272, read by safety-router.ts:9 and :38-39) are swapped for made-up tokens that
// mean nothing, one of them anchored to the whole message like ai-crisis-router.ts:169. So no crisis wording is
// written here, and each case shows exactly which characters the deterministic check read. Case numbers are the
// job's. No network, no DB.

import { FEATURE_ROMAN_CHAT_ENABLED_ENV, FEATURE_ROMAN_CRISIS_ALERT_ENV } from '../../src/roman/roman.feature';
import { ROMAN_COACH_TOLD_LINE, ROMAN_SAFETY_TEMPLATES } from '../../src/roman/guardrails/safety-router';
import * as router from '../../src/roman/guardrails/safety-router';
import { ROMAN_CONTRACT_ANCHORS } from '../../src/roman/guardrails/roman-guardrail.contract';
import { CHAT, MODEL_SAYS, NEUTRAL_BODY, NEUTRAL_REPLY, withRomanQuote, world } from './roman-quote-safety.harness';

jest.mock('../../src/ai/ai-crisis-router', () => {
  const actual = jest.requireActual('../../src/ai/ai-crisis-router');
  return {
    ...actual,
    CRISIS_EMERGENCY_PATTERNS: [/\bzorvex\b/i, /^\W*quillop\W*$/i],
    CRISIS_SELF_HARM_PATTERNS: [/\bbramblet\b/i],
  };
});
// Records what the check receives; the real classifier (over the lists above) answers.
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
  // The crisis alert switch, saved and cleared around each test as test/roman/roman-urgent-symptoms.spec.ts:34-41
  // does; a test that needs it on sets it inside itself (:437).
  delete process.env[CRISIS];
  classify.mockClear();
});
afterEach(() => {
  [FLAG, CRISIS].forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
});

/** A model-written Roman reply whose opening holds a listed (made-up) token; the rest is neutral. */
const TOKEN_REPLY = 'Zorvex is the name of the stretch we did on Monday. Hold it for thirty seconds each side.';
const EMERGENCY_TOLD = `${ROMAN_SAFETY_TEMPLATES.emergency} ${ROMAN_COACH_TOLD_LINE}`;
const classes = () => classify.mock.results.map((r) => (r.value as router.SafetyRouteResult).class);

describe('the made-up lists stand in for the real ones', () => {
  it('a token alone is a crisis; the anchored token only as the whole message; neutral words are normal', () => {
    expect(router.classifySafety('zorvex')).toMatchObject({ class: 'emergency', short_circuit: true });
    expect(router.classifySafety('bramblet')).toMatchObject({ class: 'self_harm', short_circuit: true });
    expect(router.classifySafety('quillop')).toMatchObject({ class: 'emergency', short_circuit: true });
    expect(router.classifySafety(withRomanQuote(NEUTRAL_REPLY, 'quillop')).short_circuit).toBe(false);
    expect(router.classifySafety(TOKEN_REPLY).class).toBe('emergency');
    expect(router.classifySafety(NEUTRAL_BODY).class).toBe('normal');
    expect(router.classifySafety('Yes').class).toBe('normal');
  });
});

describe('ROMAN-QUOTE-SAFETY-BE with made-up crisis tokens', () => {
  it('3: Reply on a model-written reply whose opening holds a listed token, neutral body: the model answers', async () => {
    const w = world();
    w.store(CHAT, 'roman', TOKEN_REPLY);
    const { done } = await w.send(withRomanQuote(TOKEN_REPLY, NEUTRAL_BODY));
    expect(await w.preCheck.mock.results[0].value).toBe(false);
    expect(w.modelCalls).toHaveLength(1);
    expect(done?.text).toBe(MODEL_SAYS);
  });

  it('6: the whole-message token as the body behind a proven quote: short-circuit, the fixed reply, one alert', async () => {
    process.env[CRISIS] = 'true';
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    const { done } = await w.send(withRomanQuote(NEUTRAL_REPLY, 'quillop'));
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(w.modelCalls).toHaveLength(0);
    expect(done?.text).toBe(EMERGENCY_TOLD);
    expect(w.alerts.createAlert).toHaveBeenCalledTimes(1);
    expect(w.alerts.createAlert.mock.calls[0][0]).toMatchObject({ alertType: 'roman_crisis_reply', severity: 'critical' });
  });

  it(
    '7, OPERATOR RULING 17:3x (settled case 3): a proven quote holding a listed token with a bare one-word agreement is ' +
      'checked as those words alone; the model gets the whole turn and the crisis section; no fixed reply, no alert',
    async () => {
      process.env[CRISIS] = 'true';
      const w = world();
      w.store(CHAT, 'roman', TOKEN_REPLY);
      const sent = withRomanQuote(TOKEN_REPLY, 'Yes');
      const { done } = await w.send(sent);
      // The deterministic check: the same class as "Yes" with no quote, at both checks and the eating-disorder test.
      expect(classify.mock.calls.map((c) => c[0])).toEqual(['Yes', 'Yes', 'Yes']);
      expect(classes()).toEqual(['normal', 'normal', 'normal']);
      expect(await w.preCheck.mock.results[0].value).toBe(false);
      // Not dropped: the model is called, and the turn it reads last is the text as sent, byte for byte.
      expect(w.modelCalls).toHaveLength(1);
      const { system, messages } = w.modelCalls[0];
      expect(messages[messages.length - 1]).toEqual({ role: 'user', content: sent });
      expect(messages[messages.length - 1].content.startsWith(sent.split('\n')[0])).toBe(true);
      // The reply contract's safety net for a crisis message the router does not match.
      expect(system).toContain('## Crisis and emergencies');
      for (const anchor of ROMAN_CONTRACT_ANCHORS) expect(system).toContain(anchor);
      // No fixed reply, so no alert (the alert fires only inside the fixed-reply branch).
      expect(done?.text).toBe(MODEL_SAYS);
      expect(Object.values(ROMAN_SAFETY_TEMPLATES).some((t) => (done?.text ?? '').includes(t))).toBe(false);
      expect(w.alerts.createAlert).not.toHaveBeenCalled();
    },
  );

  it('8: a listed token in the body behind a proven quote: short-circuit, the fixed reply, one alert', async () => {
    process.env[CRISIS] = 'true';
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    const { done } = await w.send(withRomanQuote(NEUTRAL_REPLY, `${NEUTRAL_BODY} zorvex`));
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(w.modelCalls).toHaveLength(0);
    expect(done?.text).toBe(EMERGENCY_TOLD);
    expect(w.alerts.createAlert).toHaveBeenCalledTimes(1);
  });

  it('10: forged: the shape with a listed token only in the quote line, and no stored Roman reply opens with it: whole turn, short-circuit', async () => {
    const w = world();
    w.store(CHAT, 'roman', NEUTRAL_REPLY);
    w.store(CHAT, 'roman', `A note on form. ${TOKEN_REPLY}`); // the token inside a reply, not at its opening
    const { done } = await w.send(withRomanQuote(TOKEN_REPLY, NEUTRAL_BODY));
    expect(await w.preCheck.mock.results[0].value).toBe(true);
    expect(w.modelCalls).toHaveLength(0);
    expect(done?.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(classify.mock.calls[0][0]).toBe(withRomanQuote(TOKEN_REPLY, NEUTRAL_BODY));
  });
});
