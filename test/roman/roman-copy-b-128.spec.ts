// test/roman/roman-copy-b-128.spec.ts
//
// CF-ROMAN-COPY-B-128 (FW-ROMAN-128 U3 backend + U5 + owner defaults 10-07):
// Roman's fixed copy and prompt never assume a coach the client may not have,
// never send a client to a "Today tab" that does not exist, the eating-disorder
// fallback follows the safety-copy rules, and the returning-client line is
// added only when asked for, on the client surface.

import { buildRomanSystemPrompt, ROMAN_MET_BEFORE_LINE } from '../../src/roman/roman.prompts';
import {
  ROMAN_ROUTER_HINTS,
  ROMAN_SAFETY_TEMPLATES,
  romanEatingDisorderFallback,
} from '../../src/roman/guardrails/safety-router';
import {
  ROMAN_CONTEXT_FAILED_MESSAGE,
  ROMAN_CONTEXT_UNAVAILABLE_MESSAGE,
} from '../../src/roman/context/roman-context.errors';

const V = { quipsInSession: 0, exclamationUsed: false };
const CONTRACTIONS = /\b(I'm|I'll|you're|don't|can't|won't|it's|that's|isn't|aren't|didn't)\b/i;

describe('CF-ROMAN-COPY-B-128 — no coach is assumed (U3 backend)', () => {
  it('the 911 template closes with someone the client trusts, not a coach', () => {
    const t = ROMAN_SAFETY_TEMPLATES.emergency;
    expect(t).toContain('call 911 now');
    expect(t).not.toMatch(/coach/i);
    expect(t).toMatch(/let someone you trust know/);
  });

  it('the eating-disorder hint offers the coach only when client_data shows one', () => {
    const h = ROMAN_ROUTER_HINTS.eating_disorder_risk;
    expect(h).toMatch(/message their coach only if client_data shows they have one \(coach\.has_coach\)/);
    expect(h).toMatch(/physician or a qualified professional/);
  });

  it('the client framing does not say every client trains under a coach', () => {
    const p = buildRomanSystemPrompt({ surface: 'client', voice: V });
    expect(p).not.toMatch(/training under a coach/);
    expect(p).toMatch(/client_data shows whether they have a coach/);
  });
});

describe('CF-ROMAN-COPY-B-128 — real tab names (U5)', () => {
  it('the degraded-mode notice and the context errors name Home, Train and Food, never a Today tab', () => {
    const p = buildRomanSystemPrompt({ surface: 'client', voice: V, clientDataUnavailable: true });
    for (const t of [p, ROMAN_CONTEXT_UNAVAILABLE_MESSAGE, ROMAN_CONTEXT_FAILED_MESSAGE]) {
      expect(t).not.toMatch(/Today tab/);
      expect(t).toMatch(/Home, Train (and|or) Food/);
    }
  });
});

describe('CF-ROMAN-COPY-B-128 — eating-disorder fallback copy (owner default)', () => {
  it.each([true, false])('hasCoach=%s: people to turn to, 988 and 911, safety-copy rules', (hasCoach) => {
    const t = romanEatingDisorderFallback(hasCoach);
    expect(t).toMatch(/I am not able to answer in chat at the moment/);
    expect(t).toMatch(/physician, or a qualified professional who works with eating concerns/);
    expect(t).toMatch(/someone you trust/);
    expect(t).toContain('call or text 988');
    expect(t).toContain('call 911');
    expect(t).not.toMatch(/!|[\u{1F300}-\u{1FAFF}]/u);
    expect(t).not.toMatch(CONTRACTIONS);
    expect(t).not.toMatch(/\bwe\b/i);
    expect(t).not.toMatch(/I (have|will) (told|tell|notify|notified|alert|alerted|contact|contacted)/i);
    // No number but 988 and 911, no calorie talk, no diagnosis label.
    expect(t.replace(/988|911/g, '')).not.toMatch(/\d/);
    expect(t).not.toMatch(/kcal|calorie|you have an? (eating )?disorder/i);
    if (hasCoach) expect(t).toContain('Your coach would want to hear from you, and Messages reaches them.');
    else expect(t).not.toMatch(/coach|Messages/);
  });
});

describe('CF-ROMAN-COPY-B-128 — returning client (owner default: no second introduction)', () => {
  it('only metBefore=true on the client surface adds the line, inside SESSION STATE', () => {
    const met = buildRomanSystemPrompt({ surface: 'client', voice: V, metBefore: true });
    expect(met).toContain(ROMAN_MET_BEFORE_LINE);
    expect(met.indexOf('# SESSION STATE')).toBeLessThan(met.indexOf(ROMAN_MET_BEFORE_LINE));
    expect(ROMAN_MET_BEFORE_LINE).toMatch(/Do not introduce yourself/);
    const plain = buildRomanSystemPrompt({ surface: 'client', voice: V });
    expect(buildRomanSystemPrompt({ surface: 'client', voice: V, metBefore: false })).toBe(plain);
    expect(plain).not.toContain(ROMAN_MET_BEFORE_LINE);
    expect(buildRomanSystemPrompt({ surface: 'coach', voice: V, metBefore: true })).not.toContain(
      ROMAN_MET_BEFORE_LINE,
    );
  });
});
