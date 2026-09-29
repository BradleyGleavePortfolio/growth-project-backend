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
/** Prototype-sensitive names are refused everywhere (R591-A-05): a plain-object record cannot
 * represent them faithfully, so an admitted digest could not round-trip. */
export const PROTOTYPE_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);
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
  if (PROTOTYPE_KEYS.includes(key)) return 'prototype-sensitive key name';
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

/**
 * QUERY KEY names (R591-A-01): the identifier grammar with `[]`/`.` nesting, no digit run, not
 * credential-like, AND every token of every part is a contract-vocabulary word or a pagination
 * parameter word. A query key is a source-chosen string with no sibling corroboration, so the
 * vocabulary is its only admission; `AliceSmith`, tenant or campaign names never leave the device.
 */
export const QUERY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/;
export const PAGINATION_PARAM_WORDS: readonly string[] = Object.freeze([
  'after',
  'before',
  'cursor',
  'from',
  'limit',
  'next',
  'offset',
  'page',
  'pagesize',
  'per',
  'perpage',
  'size',
  'skip',
  'start',
]);
const PAGINATION_PARAM_SET: ReadonlySet<string> = new Set(PAGINATION_PARAM_WORDS);

export function queryKeyRefusal(key: string): string | null {
  if (!QUERY_KEY_PATTERN.test(key)) return 'query key outside the identifier grammar';
  if (DIGIT_RUN_PATTERN.test(key)) return 'digit run of 4 or more in a query key';
  const credential = credentialNameRefusal(key);
  if (credential !== null) return credential;
  const parts = key.split(/[[\]]+/).filter((part) => part.length > 0);
  const tokens = parts.flatMap(tokenize);
  if (
    tokens.length === 0 ||
    !tokens.every((t) => isKeyVocabularyToken(t) || PAGINATION_PARAM_SET.has(t))
  )
    return 'query key outside the closed vocabulary (a source-chosen name never leaves the device)';
  return null;
}

/**
 * HEADER NAMES (R591-A-01): RFC 7230 token characters, not browser-controlled, not credential-like,
 * AND every `-`-separated token is a closed header word (`x-tenant-alicesmith` is refused, so is
 * any name that could carry a tenant or person). Values never appear (a `:` cannot parse).
 */
export const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const BROWSER_HEADER_PATTERN = /^(sec-|x-csrf|x-xsrf|proxy-)/i;
export const HEADER_NAME_WORDS: readonly string[] = Object.freeze(
  [
    'accept',
    'api',
    'app',
    'application',
    'build',
    'cache',
    'charset',
    'client',
    'content',
    'control',
    'device',
    'encoding',
    'id',
    'if',
    'language',
    'locale',
    'match',
    'modified',
    'none',
    'platform',
    'pragma',
    'prefer',
    'requested',
    'since',
    'time',
    'timezone',
    'type',
    'version',
    'with',
    'x',
    'zone',
  ].sort(compareText),
);
const HEADER_WORD_SET: ReadonlySet<string> = new Set(HEADER_NAME_WORDS);

export function headerNameRefusal(name: string): string | null {
  if (!HEADER_NAME_PATTERN.test(name)) return 'header entry must be a bare header name';
  if (BROWSER_HEADER_PATTERN.test(name)) return 'browser-controlled or CSRF header name';
  const credential = credentialNameRefusal(name);
  if (credential !== null) return credential;
  if (DIGIT_RUN_PATTERN.test(name)) return 'digit run of 4 or more in a header name';
  const tokens = name
    .toLowerCase()
    .split('-')
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || !tokens.every((t) => HEADER_WORD_SET.has(t)))
    return 'header name outside the closed header vocabulary';
  return null;
}

/**
 * ORIGIN TEMPLATES (r5 D-L0-2 slot rule for hosts; R591-A-01): `label.label.:d` where the
 * registrable domain is always `:d` and every other label is a session slot `:sN` or a literal
 * whose tokens are structural vocabulary words (`api`, `app`, `www`). A hostname, tenant label or
 * coach name never appears: `alice.example.com` is `:s1.:d`.
 */
export const ORIGIN_TEMPLATE_PATTERN = /^(?:(?::s[0-9]{1,2}|[a-z0-9-]{1,63})\.){0,4}:d$/;

export function originTemplateRefusal(template: string): string | null {
  if (!ORIGIN_TEMPLATE_PATTERN.test(template))
    return 'origin template must be `[label.]*:d` with slot or vocabulary labels';
  for (const label of template.split('.').slice(0, -1)) {
    if (/^:s[0-9]{1,2}$/.test(label)) continue;
    const refusal = pathLiteralRefusal(label);
    if (refusal !== null) return `origin label: ${refusal}`;
  }
  return null;
}

/**
 * Obligations only the device can meet (it alone sees values, origins and the tab); published as
 * contract data so the extension fixture asserts them and the prompt states them
 * (EXEC_RESET_2026-09-29 §1, §3; r5 D-L0-2 rule (2), D-L0-6.2). The server cannot re-check them.
 */
export const DEVICE_OBLIGATIONS: readonly string[] = Object.freeze([
  'a key whose normalised tokens equal any captured string value in the run payloads is refused before the digest leaves the device',
  'an object whose keys are not grammar-clean and corroborated (>= 2 siblings) collapses to a map node with keyClass unadmitted',
  'a next_url pagination link is followed only when its origin is an authorized or contacted origin of this run (origins[].contacted), else the step stops with a named gap',
  'every :s slot, origin slot, query value and constant header value is rebound from this run own capture; zero bindings fail closed with zero requests',
]);
/** Kept name for the r4 fixture readers; the key rules are the first two obligations. */
export const DEVICE_ONLY_KEY_REFUSALS: readonly string[] = Object.freeze(
  DEVICE_OBLIGATIONS.slice(0, 2),
);

export interface AdmissionRulesV1 {
  readonly keyIdentifierPattern: string;
  readonly keyMaxBytes: number;
  readonly credentialSubstrings: readonly string[];
  readonly prototypeKeys: readonly string[];
  readonly structuralKeyWords: readonly string[];
  readonly paginationParamWords: readonly string[];
  readonly headerNameWords: readonly string[];
  readonly originTemplatePattern: string;
  readonly deviceObligations: readonly string[];
  readonly deviceOnlyKeyRefusals: readonly string[];
}

export function admissionRules(): AdmissionRulesV1 {
  return Object.freeze({
    keyIdentifierPattern: KEY_IDENTIFIER_PATTERN.source,
    keyMaxBytes: KEY_MAX_BYTES,
    credentialSubstrings: CREDENTIAL_SUBSTRINGS,
    prototypeKeys: PROTOTYPE_KEYS,
    structuralKeyWords: STRUCTURAL_KEY_VOCABULARY,
    paginationParamWords: PAGINATION_PARAM_WORDS,
    headerNameWords: HEADER_NAME_WORDS,
    originTemplatePattern: ORIGIN_TEMPLATE_PATTERN.source,
    deviceObligations: DEVICE_OBLIGATIONS,
    deviceOnlyKeyRefusals: DEVICE_ONLY_KEY_REFUSALS,
  });
}
