import { isVocabularyToken, tokenize } from './contract-vocabulary';

/**
 * L1 — the ADMISSION RULES for every site-chosen string in a digest (r4 directives applied over
 * L0 r3 D-L0-2; closes R581-A-01, R581-A-02, R581-B-A3, R581-B-B10). One pure module, tested on
 * its own, so r4 can relax a rule in one place by evidence. The strictest rule holds now:
 *
 * 1. PATH SEGMENTS are slot-only: a literal segment is admitted iff EVERY token is a word of the
 *    closed `STRUCTURAL_PATH_VOCABULARY` (or an API version marker). There is NO hash-equality or
 *    cross-coach promotion of source path bytes; a segment outside the vocabulary never reaches
 *    the model or a package, only its class and distinct count do.
 * 2. OBJECT KEYS are admitted iff they match the structural identifier grammar (ASCII letter or
 *    underscore start, `[A-Za-z0-9_]` only, ≤ 48 bytes, no digit run ≥ 4) AND have positive
 *    structural corroboration: every token is a contract-vocabulary word, OR the device attests
 *    the key appeared in ≥ 2 sibling objects of the same array element shape (`corroborated`).
 *    Otherwise the device collapses the containing object to a `map`/slot node and the key never
 *    leaves it; a digest that still carries such a key is refused.
 * 3. CREDENTIAL-LIKE names are always refused, everywhere a name appears (keys, query keys,
 *    header names): the case-insensitive substrings below.
 */

export const KEY_MAX_BYTES = 48;
export const KEY_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const DIGIT_RUN_PATTERN = /[0-9]{4}/;

/**
 * Case-insensitive substrings that refuse a name outright (r4 directive 2 list, plus the
 * common abbreviations `passwd`/`pwd` and `csrf`/`credential`; stricter than the directive).
 */
export const CREDENTIAL_SUBSTRINGS: readonly string[] = Object.freeze([
  'auth',
  'bearer',
  'cookie',
  'credential',
  'csrf',
  'key',
  'passwd',
  'password',
  'pwd',
  'secret',
  'session',
  'signature',
  'token',
]);

/** Generic JSON field words admitted without corroboration, beside the path vocabulary. */
const KEY_WORDS: readonly string[] = [
  'id',
  'ids',
  'uuid',
  'guid',
  'slug',
  'name',
  'first',
  'last',
  'full',
  'display',
  'title',
  'description',
  'label',
  'labels',
  'value',
  'values',
  'text',
  'content',
  'url',
  'href',
  'link',
  'links',
  'image',
  'images',
  'avatar',
  'thumbnail',
  'email',
  'phone',
  'address',
  'city',
  'country',
  'timezone',
  'locale',
  'language',
  'created',
  'updated',
  'modified',
  'started',
  'finished',
  'ended',
  'due',
  'at',
  'on',
  'by',
  'of',
  'is',
  'has',
  'date',
  'dates',
  'time',
  'times',
  'timestamp',
  'start',
  'end',
  'duration',
  'seconds',
  'minutes',
  'hours',
  'rest',
  'rep',
  'rpe',
  'tempo',
  'load',
  'distance',
  'unit',
  'units',
  'kg',
  'lb',
  'lbs',
  'birth',
  'birthday',
  'gender',
  'age',
  'height',
  'bodyweight',
  'meta',
  'metadata',
  'attributes',
  'relationships',
  'included',
  'results',
  'records',
  'rows',
  'entries',
  'nodes',
  'edges',
  'node',
  'edge',
  'pagination',
  'paging',
  'cursor',
  'next',
  'previous',
  'prev',
  'after',
  'before',
  'since',
  'until',
  'from',
  'to',
  'limit',
  'offset',
  'per',
  'size',
  'number',
  'num',
  'more',
  'error',
  'errors',
  'code',
  'success',
  'ok',
  'enabled',
  'disabled',
  'visible',
  'hidden',
  'locked',
  'owner',
  'creator',
  'assignee',
  'parent',
  'child',
  'children',
  'source',
  'target',
  'kind',
  'role',
  'roles',
  'level',
  'priority',
  'order',
  'position',
  'rank',
  'sort',
  'score',
  'rating',
  'reply',
  'replies',
  'color',
  'width',
  'collapsed',
  'amount',
  'currency',
  'price',
  'card',
  'paid',
  'security',
  'two',
  'factor',
  'webhook',
  'notes',
];

const KEY_WORD_SET: ReadonlySet<string> = new Set(KEY_WORDS);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, distinct: mirrored by the extension fixture beside the path vocabulary. */
export const STRUCTURAL_KEY_VOCABULARY: readonly string[] = Object.freeze(
  [...new Set(KEY_WORDS)].sort(compareText),
);

export function isKeyVocabularyToken(token: string): boolean {
  return KEY_WORD_SET.has(token) || isVocabularyToken(token);
}

/** Rule 3: the fixed detail when a name carries a credential-like substring, else `null`. */
export function credentialNameRefusal(name: string): string | null {
  const lower = name.toLowerCase();
  const hit = CREDENTIAL_SUBSTRINGS.find((s) => lower.includes(s));
  return hit === undefined ? null : `credential-like name (contains "${hit}")`;
}

/** Rule 2 grammar: the fixed detail when a key fails the structural identifier grammar. */
export function keyGrammarRefusal(key: string): string | null {
  if (key.length === 0) return 'empty key';
  if (Buffer.byteLength(key, 'utf8') > KEY_MAX_BYTES) return `key over ${KEY_MAX_BYTES} bytes`;
  if (/\s/u.test(key)) return 'whitespace in a key';
  if (!KEY_IDENTIFIER_PATTERN.test(key)) return 'key outside the structural identifier grammar';
  if (DIGIT_RUN_PATTERN.test(key)) return 'digit run of 4 or more in a key';
  return credentialNameRefusal(key);
}

/** Every token of the key is a contract-vocabulary word (positive corroboration by vocabulary). */
export function isVocabularyKey(key: string): boolean {
  const tokens = tokenize(key);
  return tokens.length > 0 && tokens.every(isKeyVocabularyToken);
}

/**
 * Rule 2: grammar AND corroboration (vocabulary, or the device's sibling attestation). Returns
 * the fixed refusal detail or `null` when the key is admitted.
 */
export function keyAdmissionRefusal(key: string, corroborated: ReadonlySet<string>): string | null {
  const grammar = keyGrammarRefusal(key);
  if (grammar !== null) return grammar;
  if (isVocabularyKey(key) || corroborated.has(key)) return null;
  return 'key without structural corroboration (not vocabulary, not attested by siblings)';
}

/**
 * Rule 1: a literal path segment is admitted iff every token is a structural vocabulary word.
 * Value-like shapes are named for the error list; they are refused by the vocabulary rule anyway.
 */
export function pathLiteralRefusal(segment: string): string | null {
  if (segment.length === 0) return 'empty path segment';
  if (segment.length > 64) return 'literal segment over 64 characters';
  if (DIGIT_RUN_PATTERN.test(segment)) return 'digit run of 4 or more in a literal segment';
  if (/[@+%]/.test(segment)) return 'value-like characters in a literal segment';
  if (/^[0-9a-f]{32,}$/i.test(segment)) return 'hash-shaped literal segment';
  if (/^[0-9]+$/.test(segment)) return 'numeric literal segment';
  const tokens = tokenize(segment);
  if (tokens.length === 0 || !tokens.every(isVocabularyToken))
    return 'literal segment outside the closed structural vocabulary (must be a session slot)';
  return null;
}

/** Query key names: the identifier grammar plus `[]`/`.` nesting, and rule 3. */
export const QUERY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/;

export function queryKeyRefusal(key: string): string | null {
  if (!QUERY_KEY_PATTERN.test(key)) return 'query key outside the identifier grammar';
  if (DIGIT_RUN_PATTERN.test(key)) return 'digit run of 4 or more in a query key';
  return credentialNameRefusal(key);
}

/** Header NAMES: RFC 7230 token characters only (a value can never parse as a name), rule 3. */
export const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const BROWSER_HEADER_PATTERN = /^(sec-|x-csrf|x-xsrf|proxy-)/i;

export function headerNameRefusal(name: string): string | null {
  if (!HEADER_NAME_PATTERN.test(name)) return 'header entry must be a bare header name';
  if (BROWSER_HEADER_PATTERN.test(name)) return 'browser-controlled or CSRF header name';
  return credentialNameRefusal(name);
}

/** The admission rules as contract data (fixture mirror for the extension; prompt part 2). */
/**
 * Refusals only the device can apply (it alone sees values); listed here as contract data so the
 * extension fixture asserts them (EXEC_RESET_2026-09-29 §3 b). The server cannot re-check them
 * — a digest never carries values — so a package is never more trusted than the device's word.
 */
export const DEVICE_ONLY_KEY_REFUSALS: readonly string[] = Object.freeze([
  'key equals (case-insensitive) any captured value in the run payloads',
  'object with non-corroborated non-vocabulary keys collapses to a map node',
]);

export interface AdmissionRulesV1 {
  readonly keyIdentifierPattern: string;
  readonly keyMaxBytes: number;
  readonly credentialSubstrings: readonly string[];
  readonly structuralKeyWords: readonly string[];
  readonly deviceOnlyKeyRefusals: readonly string[];
}

export function admissionRules(): AdmissionRulesV1 {
  return Object.freeze({
    keyIdentifierPattern: KEY_IDENTIFIER_PATTERN.source,
    keyMaxBytes: KEY_MAX_BYTES,
    credentialSubstrings: CREDENTIAL_SUBSTRINGS,
    structuralKeyWords: STRUCTURAL_KEY_VOCABULARY,
    deviceOnlyKeyRefusals: DEVICE_ONLY_KEY_REFUSALS,
  });
}
