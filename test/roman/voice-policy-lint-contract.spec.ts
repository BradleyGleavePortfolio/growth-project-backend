import * as fs from 'fs';
import * as path from 'path';
import {
  LEGACY,
  ROMAN_V2,
  SURFACE_KEYS,
} from '../../src/roman/voice/voice-policy.constants';
import {
  DAY0_PUSH,
  DAY1_PUSH,
  DAY3_PUSH,
  DAY7_PUSH,
  LOCKOUT_SCREEN,
} from '../../src/checkout/dunning-v2/dunning-v2.copy';

/**
 * Roman Phase 2 — copy lint + legacy byte-equal contract.
 *
 * Two independent guarantees:
 *   1. LINT  — every ROMAN_V2 string obeys ROMAN_VOICE_POLICY §3: no
 *      exclamation point, no emoji, no "Oops"/"Whoops"/"Uh oh", no "sonnet".
 *   2. CONTRACT — the LEGACY map is byte-for-byte what each surface returned
 *      before this PR. For the dunning/lockout surfaces this is asserted
 *      directly against the canonical `dunning-v2.copy.ts` source strings; for
 *      all ten surfaces it is also pinned against a committed JSON snapshot so
 *      the flag-OFF path can never silently drift.
 */

const SNAPSHOT_PATH = path.join(
  __dirname,
  '..',
  '_fixtures',
  'roman-voice-legacy.snapshot.json',
);

// Emoji detection via Unicode property escapes — pictographic symbols only.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const FORBIDDEN_WORDS = ['oops', 'whoops', 'uh oh', 'sonnet'];

describe('Roman Phase 2 copy — lint (ROMAN_VOICE_POLICY §3)', () => {
  describe('no exclamation point in any Roman variant', () => {
    it.each(SURFACE_KEYS)('%s has no "!"', (key) => {
      expect(ROMAN_V2[key]).not.toContain('!');
    });
  });

  describe('no emoji in any Roman variant', () => {
    it.each(SURFACE_KEYS)('%s has no emoji', (key) => {
      expect(EMOJI_RE.test(ROMAN_V2[key])).toBe(false);
    });
  });

  describe('no forbidden words (Oops / Whoops / Uh oh / sonnet)', () => {
    it.each(SURFACE_KEYS)('%s has none of the forbidden words', (key) => {
      const lower = ROMAN_V2[key].toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        expect(lower).not.toContain(word);
      }
    });
  });

  it('no Roman variant signs off as "The TGP Team"', () => {
    for (const key of SURFACE_KEYS) {
      expect(ROMAN_V2[key]).not.toContain('The TGP Team');
    }
  });

  it('the LEGACY map also contains no exclamation point or "sonnet"', () => {
    for (const key of SURFACE_KEYS) {
      expect(LEGACY[key]).not.toContain('!');
      expect(LEGACY[key].toLowerCase()).not.toContain('sonnet');
    }
  });
});

describe('Roman Phase 2 copy — legacy byte-equal contract', () => {
  it('LEGACY matches the committed snapshot byte-for-byte', () => {
    const snapshot = JSON.parse(
      fs.readFileSync(SNAPSHOT_PATH, 'utf8'),
    ) as Record<string, string>;
    // Both directions: every key present, every value byte-equal.
    expect(Object.keys(snapshot).sort()).toEqual([...SURFACE_KEYS].sort());
    for (const key of SURFACE_KEYS) {
      expect(LEGACY[key]).toBe(snapshot[key]);
    }
  });

  it('dunning/lockout LEGACY strings are byte-equal to the canonical dunning-v2.copy source', () => {
    expect(LEGACY.dunning_day0).toBe(DAY0_PUSH.straight);
    expect(LEGACY.dunning_day1).toBe(DAY1_PUSH.straight);
    expect(LEGACY.dunning_day3).toBe(DAY3_PUSH.straight);
    expect(LEGACY.dunning_day7).toBe(DAY7_PUSH.straight);
    expect(LEGACY.lockout_day10).toBe(LOCKOUT_SCREEN.straight);
  });
});
