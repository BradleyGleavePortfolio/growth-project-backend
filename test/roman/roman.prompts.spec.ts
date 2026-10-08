/**
 * Roman Phase 1 — system-prompt builder unit tests (brief §1.7 / §2).
 *
 * Proves the system prompt:
 *   - includes every voice-contract anchor (dignified/composed, no-emoji,
 *     single-exclamation, no-contraction default, dry-quip allowance, banned
 *     register, failure tone, identity);
 *   - frames the surface (client vs coach) without diverging the contract;
 *   - reflects the live per-session voice budget (exclamation spent, quip in
 *     prior turn);
 *   - does NOT leak the spec doc verbatim (no mascot art-direction, no open
 *     operator decisions — the prompt is the summarised operative contract).
 */

import {
  buildRomanSystemPrompt,
  ROMAN_COACH_PROMPT_VERSION,
  ROMAN_VOICE_CONTRACT,
  romanPromptVersionOf,
} from '../../src/roman/roman.prompts';
import { PROMPT_VERSION } from '../../src/roman/guardrails/roman-guardrail.contract';

describe('buildRomanSystemPrompt — voice contract anchors', () => {
  const base = buildRomanSystemPrompt({
    surface: 'client',
    voice: { quipsInSession: 0, exclamationUsed: false },
  });

  it('opens by naming the single Roman persona (identity)', () => {
    expect(base).toContain('You are Roman, the single AI persona');
    expect(base).toContain('One Roman.');
    expect(base).toContain('Alfred from Batman');
  });

  it('encodes the dignified / composed tonal anchors', () => {
    expect(base).toMatch(/Dignified, composed, measured/);
    expect(base).toMatch(/Never gushing, never patronising/);
  });

  it('encodes the no-contraction default and the quip exception', () => {
    expect(base).toContain('Avoid contractions by default');
    expect(base).toContain('Contractions ARE permitted inside a rare dry quip');
  });

  it('encodes the NO emoji rule', () => {
    expect(base).toMatch(/NO emoji\. Ever\./);
  });

  it('B-651-9: encodes the no-exclamation rule with no per-session exception', () => {
    expect(base).toContain('NO exclamation points. Ever.');
    expect(base).not.toContain('a single exclamation per session');
  });

  it('encodes the dry-humour ~1-in-8 frequency and never-two-in-a-row rule', () => {
    expect(base).toContain('1 message in 8');
    expect(base).toContain('Never two quips in a row');
    expect(base).toContain("NEVER at the user's expense");
  });

  it('encodes the banned registers (hype, fitness-bro, gen-z, corporate)', () => {
    expect(base).toMatch(/synergy\/leverage\/circle back\/bandwidth/);
    expect(base).toMatch(/amazing\/incredible\/awesome\/epic\/insane\/game-changer/);
    expect(base).toMatch(/crushing it\/let's go\/beast mode\/grind/);
    expect(base).toMatch(/slay\/bet\/no cap\/rizz\/lowkey\/vibe/);
  });

  it('encodes the failure tone (own it without grovelling)', () => {
    expect(base).toContain('Own the failure without grovelling');
    expect(base).toContain('That request did not complete. I will try again.');
    expect(base).toMatch(/At most one measured "My apologies\."/);
  });

  it('includes the verbatim voice-contract block (brief §2 requires it present)', () => {
    expect(base).toContain(ROMAN_VOICE_CONTRACT);
  });
});

describe('buildRomanSystemPrompt — surface framing', () => {
  it('frames the client surface', () => {
    const p = buildRomanSystemPrompt({
      surface: 'client',
      voice: { quipsInSession: 0, exclamationUsed: false },
    });
    expect(p).toContain('client app');
  });

  it('frames the coach surface', () => {
    const p = buildRomanSystemPrompt({
      surface: 'coach',
      voice: { quipsInSession: 0, exclamationUsed: false },
    });
    expect(p).toContain('coach app');
  });

  it('keeps the identical voice contract across both surfaces', () => {
    const client = buildRomanSystemPrompt({
      surface: 'client',
      voice: { quipsInSession: 0, exclamationUsed: false },
    });
    const coach = buildRomanSystemPrompt({
      surface: 'coach',
      voice: { quipsInSession: 0, exclamationUsed: false },
    });
    expect(client).toContain(ROMAN_VOICE_CONTRACT);
    expect(coach).toContain(ROMAN_VOICE_CONTRACT);
  });

  it('COACH-ROMAN-SURFACE-130: coach Roman says it sees no client data, points to Clients and never states a number it was not given', () => {
    const voice = { quipsInSession: 0, exclamationUsed: false };
    const coach = buildRomanSystemPrompt({ surface: 'coach', voice });
    const client = buildRomanSystemPrompt({ surface: 'client', voice });
    // What coach Roman really does: general help, and only what the coach writes in this chat.
    expect(coach).toContain('help with programming, nutrition and running the practice');
    expect(coach).toContain("You cannot see any client's data here");
    expect(coach).toContain('only what the coach writes in this chat');
    expect(coach).toContain("that client's page in Clients");
    expect(coach).toContain('Never state a number you were not given');
    expect(coach).toContain("Never reveal another coach's or client's private data.");
    // The client prompt is untouched by the coach rules.
    expect(client).not.toContain("You cannot see any client's data here");
    expect(client).not.toContain('Never state a number you were not given');
    // Prompt version bump: a coach turn records the coach prompt version, a client turn the contract's.
    expect(ROMAN_COACH_PROMPT_VERSION).toBe('roman-coach-v1');
    expect(romanPromptVersionOf('coach')).toBe(ROMAN_COACH_PROMPT_VERSION);
    expect(romanPromptVersionOf('client')).toBe(PROMPT_VERSION);
  });
});

describe('buildRomanSystemPrompt — live session voice budget', () => {
  it('B-651-9: instructs no exclamation on every turn, spent or not', () => {
    for (const exclamationUsed of [true, false]) {
      const p = buildRomanSystemPrompt({
        surface: 'client',
        voice: { quipsInSession: 1, exclamationUsed },
      });
      expect(p).toContain('Do not use an exclamation point in this reply.');
      expect(p).not.toMatch(/may spend the single per-session exclamation/i);
      expect(p).toContain('NO exclamation points. Ever.');
    }
  });

  it('forbids a quip on the turn after a quip (never two in a row)', () => {
    const p = buildRomanSystemPrompt({
      surface: 'client',
      voice: { quipsInSession: 2, exclamationUsed: false, lastTurnHadQuip: true },
    });
    expect(p).toContain('this turn MUST NOT');
  });

  it('surfaces the running quip count', () => {
    const p = buildRomanSystemPrompt({
      surface: 'client',
      voice: { quipsInSession: 3, exclamationUsed: false },
    });
    expect(p).toContain('Quips used this session: 3');
  });

  it('includes optional subject context as reference only', () => {
    const p = buildRomanSystemPrompt({
      surface: 'coach',
      voice: { quipsInSession: 0, exclamationUsed: false },
      subjectContext: 'Coach brief: 4 clients need attention.',
    });
    expect(p).toContain('SUBJECT CONTEXT');
    expect(p).toContain('do not recite verbatim');
    expect(p).toContain('4 clients need attention');
  });
});

describe('buildRomanSystemPrompt — does NOT leak the spec doc verbatim', () => {
  const p = buildRomanSystemPrompt({
    surface: 'client',
    voice: { quipsInSession: 0, exclamationUsed: false },
  });

  it('omits mascot art-direction (that lives in the spec, not the runtime prompt)', () => {
    expect(p).not.toContain('Mascot');
    expect(p).not.toContain('butler attire');
    expect(p).not.toContain('three-piece suit');
  });

  it('omits the open operator-decision section', () => {
    expect(p).not.toContain('Open decisions for the operator');
    expect(p).not.toContain('Brand accent hex');
  });

  it('omits the sample-copy token table verbatim', () => {
    expect(p).not.toContain('{bankLast4}');
    expect(p).not.toContain('Twelve sample-copy contexts');
  });
});
