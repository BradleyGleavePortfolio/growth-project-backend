import {
  CREDENTIAL_SUBSTRINGS,
  DEVICE_ONLY_KEY_REFUSALS,
  KEY_MAX_BYTES,
  STRUCTURAL_KEY_VOCABULARY,
  admissionRules,
  credentialNameRefusal,
  headerNameRefusal,
  isVocabularyKey,
  keyAdmissionRefusal,
  keyGrammarRefusal,
  pathLiteralRefusal,
  queryKeyRefusal,
} from '../../../src/scout/learn/admission';
import { STRUCTURAL_PATH_VOCABULARY } from '../../../src/scout/learn/contract-vocabulary';
import { loadJson } from './helpers';

const none = new Set<string>();

describe('learn admission (r4 directives: keys, path literals, query keys, header names)', () => {
  describe('key grammar', () => {
    it.each(['id', 'display_name', 'createdAt', '_meta', 'a', 'x1'])('accepts %s', (k) => {
      expect(keyGrammarRefusal(k)).toBeNull();
    });
    it('names whitespace explicitly (reset directive 3a), for every Unicode space', () => {
      for (const k of [
        'display name',
        'display\tname',
        'display\u00a0name',
        'display\u2003name',
        ' id',
        'id\n',
      ])
        expect(keyGrammarRefusal(k)).toBe('whitespace in a key');
    });
    it.each([
      ['', 'empty'],
      ['display name', 'whitespace'],
      ['coach@example', 'at sign'],
      ['member_20240101', 'digit run'],
      ['1members', 'digit start'],
      ['a-b', 'dash'],
      ['a.b', 'dot'],
      ['$ref', 'dollar'],
      ['displаy_name', 'confusable'],
      ['display\u200bname', 'zero width'],
      ['a'.repeat(KEY_MAX_BYTES + 1), 'over max bytes'],
    ])('refuses %j (%s)', (k) => {
      expect(keyGrammarRefusal(k)).not.toBeNull();
    });
  });

  describe('credential substrings are always refused (case-insensitive)', () => {
    it.each(CREDENTIAL_SUBSTRINGS)('substring %s', (word) => {
      expect(credentialNameRefusal(word)).not.toBeNull();
      expect(credentialNameRefusal(`x_${word.toUpperCase()}_y`)).not.toBeNull();
      expect(keyAdmissionRefusal(`my${word}`, new Set([`my${word}`]))).not.toBeNull();
    });
    it('covers the directive list', () => {
      for (const w of [
        'token',
        'secret',
        'password',
        'auth',
        'session',
        'cookie',
        'key',
        'signature',
        'bearer',
      ])
        expect(CREDENTIAL_SUBSTRINGS).toContain(w);
    });
  });

  describe('key admission = grammar AND (vocabulary OR corroborated)', () => {
    it('admits vocabulary keys without corroboration', () => {
      for (const k of ['id', 'name', 'items', 'created_at', 'display_name'])
        expect(keyAdmissionRefusal(k, none)).toBeNull();
    });
    it('refuses a non-vocabulary key without corroboration', () => {
      expect(isVocabularyKey('favourite_colour')).toBe(false);
      expect(keyAdmissionRefusal('favourite_colour', none)).not.toBeNull();
    });
    it('admits a non-vocabulary key with corroboration', () => {
      expect(keyAdmissionRefusal('favourite_colour', new Set(['favourite_colour']))).toBeNull();
    });
    it('corroboration never rescues grammar or credential refusals', () => {
      expect(keyAdmissionRefusal('coach@example', new Set(['coach@example']))).not.toBeNull();
      expect(keyAdmissionRefusal('api_key', new Set(['api_key']))).not.toBeNull();
    });
  });

  describe('path literals: vocabulary words only, never source bytes', () => {
    it('admits every vocabulary word and version tokens', () => {
      for (const w of STRUCTURAL_PATH_VOCABULARY) expect(pathLiteralRefusal(w)).toBeNull();
      expect(pathLiteralRefusal('v2')).toBeNull();
      expect(pathLiteralRefusal('client-notes')).toBeNull();
    });
    it.each([
      'acme-fitness',
      '4821',
      'u20240101',
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'coach@example.com',
      '%2e%2e',
      'клиенты',
      '',
      'a'.repeat(65),
    ])('refuses %j', (seg) => {
      expect(pathLiteralRefusal(seg)).not.toBeNull();
    });
  });

  describe('query keys and header names', () => {
    it('admits structural query keys', () => {
      for (const k of ['page', 'after', 'per_page', 'filter[status]', 'sort.by'])
        expect(queryKeyRefusal(k)).toBeNull();
    });
    it.each(['access_token', 'auth', 'user@', 'v20240101', 'page number', 'page=2', ''])(
      'refuses query key %j',
      (k) => {
        expect(queryKeyRefusal(k)).not.toBeNull();
      },
    );
    it('admits benign header names and refuses credential, CSRF and browser-controlled names', () => {
      for (const h of ['accept', 'content-type', 'x-requested-with', 'accept-language'])
        expect(headerNameRefusal(h)).toBeNull();
      for (const h of [
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
        'x-csrf-token',
        'sec-fetch-site',
        'proxy-authorization',
        'accept: application/json',
        'Bearer abc',
        'x-session-id',
        'x-signature',
      ])
        expect(headerNameRefusal(h)).not.toBeNull();
    });
  });

  it('exposes the rules as data with the grammar, the credential list and the device-only refusals; the fixture mirror matches', () => {
    const rules = admissionRules();
    expect(rules.deviceOnlyKeyRefusals).toEqual(DEVICE_ONLY_KEY_REFUSALS);
    expect(rules.deviceOnlyKeyRefusals.some((r) => r.includes('captured value'))).toBe(true);
    expect(loadJson('admission-rules.json')).toEqual(JSON.parse(JSON.stringify(rules)));
    expect(rules.keyMaxBytes).toBe(KEY_MAX_BYTES);
    expect(rules.credentialSubstrings).toEqual(CREDENTIAL_SUBSTRINGS);
    expect(rules.structuralKeyWords).toEqual(STRUCTURAL_KEY_VOCABULARY);
    expect(new RegExp(rules.keyIdentifierPattern).test('display_name')).toBe(true);
  });
});
