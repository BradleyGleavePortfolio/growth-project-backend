import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STATUS_VALUE_VOCABULARY,
  STATUS_VARIANT_VOCABULARY,
  STRUCTURAL_PATH_VOCABULARY,
  VOCABULARY_VERSION,
  contractVocabulary,
  isVocabularySegment,
  tokenize,
} from '../../../src/scout/learn/contract-vocabulary';
import { STRUCTURAL_KEY_VOCABULARY } from '../../../src/scout/learn/admission';
import { FIXTURES } from './helpers';

function isSortedUnique(list: readonly string[]): boolean {
  return list.every((w, i) => i === 0 || list[i - 1] < w);
}

describe('contract vocabulary (closed, versioned, vendor-neutral)', () => {
  it('is version 3 (r7: mutating verbs, catalogue-bound family labels), sorted, unique, lower-case ASCII words', () => {
    expect(VOCABULARY_VERSION).toBe(3);
    for (const list of [
      STRUCTURAL_PATH_VOCABULARY,
      STATUS_VARIANT_VOCABULARY,
      STATUS_VALUE_VOCABULARY,
      STRUCTURAL_KEY_VOCABULARY,
    ]) {
      expect(isSortedUnique(list)).toBe(true);
      for (const w of list) expect(w).toMatch(/^[a-z][a-z0-9]*([-_][a-z0-9]+)*$/);
    }
  });

  it('contains no digit run, no word longer than 32 and no vendor-looking token', () => {
    // Same split-term construction as scripts/vendor-name-guard.mjs (names never appear whole).
    const banned = [
      ['true', 'coach'],
      ['trainer', 'ize'],
      ['ever', 'fit'],
      ['my', 'pt', 'hub'],
      ['pt', 'distinction'],
      ['coach', 'rx'],
      ['train', 'heroic'],
      ['fit', 'sw'],
      ['team', 'buildr'],
      ['kab', 'ata'],
    ].map((parts) => parts.join(''));
    for (const w of [...STRUCTURAL_PATH_VOCABULARY, ...STRUCTURAL_KEY_VOCABULARY]) {
      expect(w).not.toMatch(/[0-9]{4}/);
      expect(w.length).toBeLessThanOrEqual(32);
      for (const b of banned) expect(w.includes(b)).toBe(false);
    }
  });

  it('tokenizes snake, kebab and camel case and admits multi-word vocabulary segments', () => {
    expect(tokenize('clientNotes')).toEqual(['client', 'notes']);
    expect(tokenize('client_notes')).toEqual(['client', 'notes']);
    expect(tokenize('client-notes')).toEqual(['client', 'notes']);
    expect(isVocabularySegment('client-notes')).toBe(true);
    expect(isVocabularySegment('acme-notes')).toBe(false);
    expect(isVocabularySegment('v12')).toBe(true);
    expect(isVocabularySegment('v1234')).toBe(false);
  });

  it('matches the fixture mirror the extension asserts against', () => {
    const mirror = JSON.parse(
      readFileSync(join(FIXTURES, 'contract-vocabulary.json'), 'utf8'),
    ) as unknown;
    expect(mirror).toEqual(JSON.parse(JSON.stringify(contractVocabulary())));
  });
});
