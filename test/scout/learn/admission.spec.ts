import {
  CREDENTIAL_SUBSTRINGS,
  DEVICE_OBLIGATIONS,
  DEVICE_ONLY_KEY_REFUSALS,
  HEADER_NAME_WORDS,
  KEY_MAX_BYTES,
  PROTOTYPE_KEYS,
  STRUCTURAL_KEY_VOCABULARY,
  admissionRules,
  credentialNameRefusal,
  headerNameRefusal,
  isVocabularyKey,
  keyAdmissionRefusal,
  keyGrammarRefusal,
  originTemplateRefusal,
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

  describe('r2: A-01 identifier leakage paths and A-05 prototype names (fail-first on 3a684671)', () => {
    it('refuses semantic identifiers as query keys and header names; admits vocabulary forms', () => {
      expect(queryKeyRefusal('AliceSmith')).not.toBeNull();
      expect(queryKeyRefusal('coach_alice')).not.toBeNull();
      expect(queryKeyRefusal('campaign')).not.toBeNull();
      for (const ok of ['page', 'per_page', 'after', 'cursor', 'status', 'filter[status]'])
        expect({ key: ok, refusal: queryKeyRefusal(ok) }).toEqual({ key: ok, refusal: null });
      expect(headerNameRefusal('X-Tenant-AliceSmith')).not.toBeNull();
      expect(headerNameRefusal('x-coach')).not.toBeNull();
      expect(headerNameRefusal('x-api-version')).toBeNull();
      expect(headerNameRefusal('x-client-platform')).toBeNull();
    });
    it('origins are host templates under the slot rule: a hostname or tenant label never parses', () => {
      for (const ok of [':d', 'api.:d', ':s1.:d', 'api.:s1.:d'])
        expect({ t: ok, r: originTemplateRefusal(ok) }).toEqual({ t: ok, r: null });
      for (const bad of [
        'alice.example.com',
        'alicesmith.:d',
        'example.com',
        'https://api.:d',
        ':d/',
        'api.:d.',
        'acme-fitness.:d',
      ])
        expect(originTemplateRefusal(bad)).not.toBeNull();
    });
    it('refuses __proto__, constructor and prototype as keys', () => {
      for (const k of PROTOTYPE_KEYS) {
        expect(keyGrammarRefusal(k)).toMatch(/prototype/);
        expect(keyAdmissionRefusal(k, new Set([k]))).not.toBeNull();
      }
    });
  });

  it('exposes the rules as data with the grammar, the credential list and the device-only refusals; the fixture mirror matches', () => {
    const rules = admissionRules();
    expect(rules.deviceOnlyKeyRefusals).toEqual(DEVICE_ONLY_KEY_REFUSALS);
    expect(rules.deviceOnlyKeyRefusals.some((r) => r.includes('captured string value'))).toBe(true);
    // B4: next_url confinement and slot rebinding are contract data in the fixture mirror.
    expect(rules.deviceObligations).toEqual(DEVICE_OBLIGATIONS);
    expect(rules.deviceObligations.some((r) => r.includes('next_url'))).toBe(true);
    expect(rules.headerNameWords).toEqual(HEADER_NAME_WORDS);
    expect(rules.prototypeKeys).toEqual(PROTOTYPE_KEYS);
    expect(loadJson('admission-rules.json')).toEqual(JSON.parse(JSON.stringify(rules)));
    expect(rules.keyMaxBytes).toBe(KEY_MAX_BYTES);
    expect(rules.credentialSubstrings).toEqual(CREDENTIAL_SUBSTRINGS);
    expect(rules.structuralKeyWords).toEqual(STRUCTURAL_KEY_VOCABULARY);
    expect(new RegExp(rules.keyIdentifierPattern).test('display_name')).toBe(true);
  });
});
