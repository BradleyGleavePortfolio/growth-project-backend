import {
  headerNameRefusal,
  keyAdmissionRefusal,
  originTemplateRefusal,
  pathLiteralRefusal,
  queryKeyRefusal,
} from './admission';
import { PAGINATION_SIGNALS, type PaginationSignal } from './contract-vocabulary';
import { isFamilyLabel, type FamilyLabel } from './family-catalogue';

/**
 * L1 (docs/decisions/2026-09-27-learn-and-remember.md r4 + EXEC_RESET + r2 review round; grammar
 * version 2) — the `StructureDigestV1` the extension builds on the coach's computer and the
 * strict parser (V-L0) the learn route applies before anything else. The digest carries
 * STRUCTURE ONLY: admitted key names, kinds, value classes, counts, URL templates with ids
 * collapsed to `:p1..` and every non-vocabulary word to a typed session slot `:s1..`, origins as
 * host TEMPLATES under the same slot rule (`:s1.:d`), query key NAMES from the closed vocabulary
 * with a distinct-value bucket, constant request header NAMES from the closed header vocabulary,
 * and device-computed pagination SIGNALS from a closed list. The slug is NOT in the digest (r5;
 * R591-A-01): the memory key is server-side context and never enters the prompt. Every byte of
 * the digest is hostile input (D-L0-7.2): nothing here is executed, fetched or written, only
 * matched. The admission rules for site-chosen strings live in `admission.ts`. No source name or
 * host literal appears in this module (§3 invariant 1). A version-1 digest is refused.
 */

export const DIGEST_VERSION = 2 as const;
export const DIGEST_MAX_ORIGINS = 8;
export const DIGEST_MAX_TEMPLATES = 64;
export const DIGEST_MAX_LINK_TEMPLATES = 64;
export const DIGEST_MAX_COLLECTION_PATHS = 4;
export const DIGEST_MAX_SHAPE_DEPTH = 4;
export const DIGEST_MAX_KEYS_PER_OBJECT = 64;
export const DIGEST_MAX_KEY_BYTES = 64;
export const DIGEST_MAX_QUERY_KEYS = 32;
export const DIGEST_MAX_STATUSES = 8;
export const DIGEST_MAX_HEADER_NAMES = 16;
export const DIGEST_MAX_TEMPLATE_BYTES = 512;
export const DIGEST_MAX_SLOTS = 16;
/** Bound on the non-GET JSON response count (a disclosure count, never a value). */
export const DIGEST_MAX_NON_GET_DATA_ORIGINS = 65535;
/** Upper bound of the canonical JSON of one digest (D-L0-2 "Bounds": 32 KiB). */
export const DIGEST_MAX_BYTES = 32 * 1024;

export const DIGEST_METHODS = ['GET', 'HEAD'] as const;
export type DigestMethod = (typeof DIGEST_METHODS)[number];
export const TEMPLATE_ROLES = ['collection', 'single', 'refused'] as const;
export type TemplateRole = (typeof TEMPLATE_ROLES)[number];
export const REFUSED_KINDS = ['not_collection', 'collection_unproven'] as const;
export type RefusedKind = (typeof REFUSED_KINDS)[number];
export const SLOT_CLASSES = ['int_like', 'uuid_like', 'slug_like', 'opaque'] as const;
export type SlotClass = (typeof SLOT_CLASSES)[number];
export const DISTINCT_BUCKETS = [1, 2, '3+'] as const;
export type DistinctBucket = (typeof DISTINCT_BUCKETS)[number];
export const STRING_CLASSES = [
  'int_id',
  'uuid',
  'short_id',
  'iso_date',
  'email_like',
  'phone_like',
  'url',
  'media_url',
  'text',
] as const;
export type StringClass = (typeof STRING_CLASSES)[number];
/** The string classes that may name a row identity (`idField`, D-L0-4). */
export const ID_CLASSES: readonly StringClass[] = ['int_id', 'uuid', 'short_id'];
/** The string classes the model must never be allowed to target (D-L0-7.1 part 1). */
export const CONTACT_CLASSES: readonly StringClass[] = ['email_like', 'phone_like'];
export const NUMBER_CLASSES = ['int', 'float'] as const;
/** `unadmitted`: the device collapsed an object whose keys failed admission (r5 rule; V-L6). */
export const MAP_KEY_CLASSES = [
  'int_id',
  'uuid',
  'short_id',
  'iso_date',
  'text',
  'unadmitted',
] as const;
export const DISCOVERED_BY = ['landing', 'explore'] as const;
export type DiscoveredBy = (typeof DISCOVERED_BY)[number];
export const MAP_SIZE_BUCKETS = ['1', '2-9', '10+'] as const;
export const STRING_LENGTH_BUCKETS = ['≤8', '≤32', '≤256', '>256'] as const;
export const ARRAY_LENGTH_BUCKETS = ['0', '1', '2-9', '10-99', '100+'] as const;

export type ShapeNode =
  | {
      readonly kind: 'object';
      readonly keys: Readonly<Record<string, ShapeNode>>;
      readonly optional?: readonly string[];
      /**
       * r4 directive 2: keys the device proved structural by appearance in ≥ 2 sibling objects of
       * the same array element shape. A key outside the contract vocabulary is admitted only when
       * listed here; otherwise the device must have collapsed this object to a `map`.
       */
      readonly corroborated?: readonly string[];
    }
  /** An object keyed by DATA (ids, dates, names): key class and size bucket only (r3, B6). */
  | {
      readonly kind: 'map';
      readonly values: ShapeNode;
      readonly keyClass: (typeof MAP_KEY_CLASSES)[number];
      readonly sizeBucket: (typeof MAP_SIZE_BUCKETS)[number];
    }
  | {
      readonly kind: 'array';
      readonly items: ShapeNode;
      readonly lengthBucket: (typeof ARRAY_LENGTH_BUCKETS)[number];
    }
  | {
      readonly kind: 'string';
      readonly class: StringClass;
      readonly lengthBucket: (typeof STRING_LENGTH_BUCKETS)[number];
    }
  | { readonly kind: 'number'; readonly class: (typeof NUMBER_CLASSES)[number] }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'null' }
  | { readonly kind: 'mixed' };

/**
 * One typed session slot (r3): class and distinct-count bucket only, never a value. The r3
 * `hash` field is deleted with the proven-slot-hash promotion (r4 directive 1): a hash of a
 * tenant word is a derived source byte and dictionary-testable (R581-A-02).
 */
export interface DigestSlot {
  readonly slot: string;
  readonly class: SlotClass;
  readonly distinct: DistinctBucket;
}

export interface DigestQueryKey {
  readonly key: string;
  readonly distinct: DistinctBucket;
}

/**
 * One origin the page contacted, as a host TEMPLATE under the slot rule (`:s1.:d`, `api.:d`).
 * `o0` is the authorized tab origin. `contacted` = a JSON response came from it this run;
 * `credentialed` = the page sent it the site's own credential header. The extension confines
 * `next_url` links to origins listed here (device obligation, admission rules).
 */
export interface DigestOrigin {
  readonly ref: string;
  readonly template: string;
  readonly contacted: boolean;
  readonly credentialed: boolean;
}

export interface DigestTemplate {
  /** `t0`..`t63` = position in canonical order; the model refers to templates by ref only. */
  readonly ref: string;
  /** `o0`..`o7`: the origin this template was fetched from (r2 direction 3). */
  readonly originRef: string;
  readonly method: DigestMethod;
  /** Root-relative; C2a ids → `:p1..`; unproven literals → `:s1..`; never a host or scheme. */
  readonly template: string;
  readonly slots: readonly DigestSlot[];
  readonly queryKeys: readonly DigestQueryKey[];
  /** Sorted, distinct, ⊆ PAGINATION_SIGNALS: presence classes computed on the device. */
  readonly paginationSignals: readonly PaginationSignal[];
  readonly statuses: readonly number[];
  readonly observations: number;
  readonly role: TemplateRole;
  /** Role `refused` only; `collection_unproven` leaves the closure open (D-L0-6.1 i-e). */
  readonly refusedKind?: RefusedKind;
  readonly collectionPaths: readonly (readonly string[])[];
  readonly shape: ShapeNode;
  /** Round-1 landing structure vs explore-only (reuse key, D-L0-3). */
  readonly discoveredBy: DiscoveredBy;
}

export interface DigestLinkTemplate {
  /** `l0`..`l63`. */
  readonly ref: string;
  readonly template: string;
  /** True when the link matches a captured template above; false = explore obligation. */
  readonly captured: boolean;
}

export interface DigestTruncation {
  readonly templates: boolean;
  readonly linkTemplates: boolean;
  readonly shapes: number;
}

export interface StructureDigestV1 {
  readonly digestVersion: typeof DIGEST_VERSION;
  readonly round: 1 | 2;
  readonly truncated: DigestTruncation;
  /** ≤ 8; `o0` first; host templates under the slot rule; distinct. */
  readonly origins: readonly DigestOrigin[];
  readonly templates: readonly DigestTemplate[];
  readonly linkTemplates: readonly DigestLinkTemplate[];
  /** Header NAMES only (r3); values are rebound on the device. */
  readonly constantHeaderNames: readonly string[];
  /**
   * r7 (D-L0-2; D-L0-9 L1 owed item 2): count of same-page JSON responses to non-GET requests.
   * Non-GET traffic is never captured, templated or replayed (D14 bound); the count is disclosed
   * as gap `non_get_data_unobserved` by the projection (L2d). A count, never an origin or value.
   */
  readonly nonGetDataOrigins: number;
  /** Round 2 only: FAM-0 family labels still unmapped. */
  readonly missingFamilies: readonly FamilyLabel[];
}

const DIGEST_KEYS = [
  'digestVersion',
  'round',
  'truncated',
  'origins',
  'templates',
  'linkTemplates',
  'constantHeaderNames',
  'nonGetDataOrigins',
  'missingFamilies',
] as const;
const TRUNCATED_KEYS = ['templates', 'linkTemplates', 'shapes'] as const;
const ORIGIN_KEYS = ['ref', 'template', 'contacted', 'credentialed'] as const;
const TEMPLATE_KEYS = [
  'ref',
  'originRef',
  'method',
  'template',
  'slots',
  'queryKeys',
  'paginationSignals',
  'statuses',
  'observations',
  'role',
  'refusedKind',
  'collectionPaths',
  'shape',
  'discoveredBy',
] as const;
const TEMPLATE_REQUIRED_KEYS = TEMPLATE_KEYS.filter((k) => k !== 'refusedKind');
const SLOT_KEYS = ['slot', 'class', 'distinct'] as const;
const QUERY_KEY_KEYS = ['key', 'distinct'] as const;
const LINK_KEYS = ['ref', 'template', 'captured'] as const;

export const TEMPLATE_REF_PATTERN = /^t(0|[1-9][0-9]?)$/;
export const LINK_REF_PATTERN = /^l(0|[1-9][0-9]?)$/;
export const ORIGIN_REF_PATTERN = /^o[0-7]$/;
/** Segments: unreserved literals, `:pN` row-id parameters or `:sN` session slots. */
const TEMPLATE_PATTERN = /^(\/(?:[A-Za-z0-9._~%-]+|:p[1-9][0-9]?|:s[1-9][0-9]?))*\/?$/;
const PARAM_PATTERN = /:p[1-9][0-9]?/g;
const SLOT_PATTERN = /:s[1-9][0-9]?/g;
const MARKER_SEGMENT = /^:[ps][1-9][0-9]?$/;
export const DIGIT_RUN_PATTERN = /[0-9]{4}/;
/** Control, bidi, zero-width and other format characters: never in a key or literal. */
const FORBIDDEN_TEXT_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
/**
 * Credential-pattern names refused anywhere in a digest beside the r4 substring rule
 * (`admission.ts`): a digest that names a credential is refused outright (D-L0-7.2; §3 inv. 3).
 */
export const CREDENTIAL_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf[-_a-z0-9]*|x-xsrf[-_a-z0-9]*|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|bearer|password|passwd|secret|client[-_]?secret|private[-_]?key)$/i;

/** One V-L* refusal: a stable validator code, a JSON-pointer-like location and a fixed detail. */
export interface LearnValidationError {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
}

export type LearnParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly LearnValidationError[] };

export function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? (value as Record<string, unknown>) : null;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Collects validator refusals; every parse is total and reports what it can, never throws. */
export class Errors {
  readonly list: LearnValidationError[] = [];
  constructor(private readonly code: string) {}
  add(path: string, detail: string, code = this.code): void {
    if (this.list.length < 64) this.list.push({ code, path, detail });
  }
  get any(): boolean {
    return this.list.length > 0;
  }
}

export function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  where: string,
  errors: Errors,
): boolean {
  let ok = true;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.add(`${where}.${key}`, 'unknown key');
      ok = false;
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.add(`${where}.${key}`, 'missing key');
      ok = false;
    }
  }
  return ok;
}

function isStringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((v) => typeof v === 'string');
}

function isDistinctBucket(value: unknown): value is DistinctBucket {
  return (DISTINCT_BUCKETS as readonly unknown[]).includes(value);
}

/** Text that may stand as a site-chosen name: ≤ 64 bytes, no control/format characters. */
export function isBoundedText(text: string, maxBytes = DIGEST_MAX_KEY_BYTES): boolean {
  return (
    text.length > 0 &&
    utf8Bytes(text) <= maxBytes &&
    !FORBIDDEN_TEXT_PATTERN.test(text) &&
    text.trim() === text
  );
}

function checkKeyName(
  key: string,
  corroborated: ReadonlySet<string>,
  where: string,
  errors: Errors,
): boolean {
  const refusal = CREDENTIAL_KEY_PATTERN.test(key)
    ? 'credential-pattern key'
    : keyAdmissionRefusal(key, corroborated);
  if (refusal !== null) errors.add(where, refusal);
  return refusal === null;
}

/** Parse one shape node; depth counts container nesting from 0 at the template root (≤ 4). */
function parseShape(raw: unknown, where: string, depth: number, errors: Errors): ShapeNode | null {
  const obj = asObject(raw);
  if (obj === null) {
    errors.add(where, 'shape node must be an object');
    return null;
  }
  const kind = obj.kind;
  switch (kind) {
    case 'boolean':
    case 'null':
    case 'mixed':
      if (!checkKeys(obj, ['kind'], ['kind'], where, errors)) return null;
      return { kind };
    case 'number':
      if (!checkKeys(obj, ['kind', 'class'], ['kind', 'class'], where, errors)) return null;
      if (!(NUMBER_CLASSES as readonly unknown[]).includes(obj.class)) {
        errors.add(`${where}.class`, 'unknown number class');
        return null;
      }
      return { kind, class: obj.class as (typeof NUMBER_CLASSES)[number] };
    case 'string': {
      const keys = ['kind', 'class', 'lengthBucket'];
      if (!checkKeys(obj, keys, keys, where, errors)) return null;
      if (!(STRING_CLASSES as readonly unknown[]).includes(obj.class)) {
        errors.add(`${where}.class`, 'unknown string class');
        return null;
      }
      if (!(STRING_LENGTH_BUCKETS as readonly unknown[]).includes(obj.lengthBucket)) {
        errors.add(`${where}.lengthBucket`, 'unknown length bucket');
        return null;
      }
      return {
        kind,
        class: obj.class as StringClass,
        lengthBucket: obj.lengthBucket as (typeof STRING_LENGTH_BUCKETS)[number],
      };
    }
    case 'array': {
      const keys = ['kind', 'items', 'lengthBucket'];
      if (!checkKeys(obj, keys, keys, where, errors)) return null;
      if (depth > DIGEST_MAX_SHAPE_DEPTH) {
        errors.add(where, 'shape deeper than 4');
        return null;
      }
      if (!(ARRAY_LENGTH_BUCKETS as readonly unknown[]).includes(obj.lengthBucket)) {
        errors.add(`${where}.lengthBucket`, 'unknown length bucket');
        return null;
      }
      const items = parseShape(obj.items, `${where}.items`, depth + 1, errors);
      if (items === null) return null;
      return {
        kind,
        items,
        lengthBucket: obj.lengthBucket as (typeof ARRAY_LENGTH_BUCKETS)[number],
      };
    }
    case 'map': {
      const keys = ['kind', 'values', 'keyClass', 'sizeBucket'];
      if (!checkKeys(obj, keys, keys, where, errors)) return null;
      if (depth > DIGEST_MAX_SHAPE_DEPTH) {
        errors.add(where, 'shape deeper than 4');
        return null;
      }
      if (!(MAP_KEY_CLASSES as readonly unknown[]).includes(obj.keyClass)) {
        errors.add(`${where}.keyClass`, 'unknown map key class');
        return null;
      }
      if (!(MAP_SIZE_BUCKETS as readonly unknown[]).includes(obj.sizeBucket)) {
        errors.add(`${where}.sizeBucket`, 'unknown map size bucket');
        return null;
      }
      const values = parseShape(obj.values, `${where}.values`, depth + 1, errors);
      return values === null
        ? null
        : {
            kind,
            values,
            keyClass: obj.keyClass as (typeof MAP_KEY_CLASSES)[number],
            sizeBucket: obj.sizeBucket as (typeof MAP_SIZE_BUCKETS)[number],
          };
    }
    case 'object': {
      if (
        !checkKeys(
          obj,
          ['kind', 'keys', 'optional', 'corroborated'],
          ['kind', 'keys'],
          where,
          errors,
        )
      )
        return null;
      if (depth > DIGEST_MAX_SHAPE_DEPTH) {
        errors.add(where, 'shape deeper than 4');
        return null;
      }
      const rawKeys = asObject(obj.keys);
      if (rawKeys === null) {
        errors.add(`${where}.keys`, 'keys must be an object');
        return null;
      }
      const names = Object.keys(rawKeys);
      if (names.length > DIGEST_MAX_KEYS_PER_OBJECT) {
        errors.add(`${where}.keys`, 'more than 64 keys');
        return null;
      }
      let corroborated: string[] | undefined;
      if (obj.corroborated !== undefined) {
        if (
          !isStringList(obj.corroborated, DIGEST_MAX_KEYS_PER_OBJECT) ||
          obj.corroborated.some((k) => !names.includes(k)) ||
          new Set(obj.corroborated).size !== obj.corroborated.length
        ) {
          errors.add(
            `${where}.corroborated`,
            'corroborated must list distinct keys of this object',
          );
          return null;
        }
        corroborated = [...obj.corroborated];
      }
      const attested: ReadonlySet<string> = new Set(corroborated ?? []);
      const keys: Record<string, ShapeNode> = {};
      for (const name of names) {
        // A refused name (incl. `__proto__`, R591-A-05) is never assigned into the record.
        if (!checkKeyName(name, attested, `${where}.keys.${name}`, errors)) return null;
        const child = parseShape(rawKeys[name], `${where}.keys.${name}`, depth + 1, errors);
        if (child === null) return null;
        keys[name] = child;
      }
      let optional: string[] | undefined;
      if (obj.optional !== undefined) {
        if (
          !isStringList(obj.optional, DIGEST_MAX_KEYS_PER_OBJECT) ||
          obj.optional.some((k) => !Object.prototype.hasOwnProperty.call(keys, k)) ||
          new Set(obj.optional).size !== obj.optional.length
        ) {
          errors.add(`${where}.optional`, 'optional must list distinct keys of this object');
          return null;
        }
        optional = [...obj.optional];
      }
      return {
        kind,
        keys,
        ...(optional === undefined ? {} : { optional }),
        ...(corroborated === undefined ? {} : { corroborated }),
      };
    }
    default:
      errors.add(`${where}.kind`, 'unknown shape kind');
      return null;
  }
}

/** Walk `path` through OBJECT keys from `root`; a `map` is never walkable (V-L6). */
export function shapeAtPath(root: ShapeNode, path: readonly string[]): ShapeNode | null {
  let node: ShapeNode = root;
  for (const key of path) {
    if (node.kind !== 'object' || !Object.prototype.hasOwnProperty.call(node.keys, key))
      return null;
    node = node.keys[key];
  }
  return node;
}

/** The item shape a collection path denotes: the array's `items` node, or `null`. */
export function itemShapeAt(root: ShapeNode, collectionPath: readonly string[]): ShapeNode | null {
  const node = shapeAtPath(root, collectionPath);
  return node !== null && node.kind === 'array' ? node.items : null;
}

/** Root-relative, `:p`/`:s`-parameterised only; markers numbered 1.. left to right. */
export function isWellFormedTemplate(template: string): boolean {
  if (
    template.length === 0 ||
    utf8Bytes(template) > DIGEST_MAX_TEMPLATE_BYTES ||
    !TEMPLATE_PATTERN.test(template) ||
    FORBIDDEN_TEXT_PATTERN.test(template)
  )
    return false;
  const params = template.match(PARAM_PATTERN) ?? [];
  const slots = template.match(SLOT_PATTERN) ?? [];
  return (
    slots.length <= DIGEST_MAX_SLOTS &&
    params.every((p, i) => p === `:p${i + 1}`) &&
    slots.every((p, i) => p === `:s${i + 1}`)
  );
}

/** Path segments of a well-formed template (leading slash dropped, trailing slash ignored). */
export function templateSegments(template: string): string[] {
  return template.split('/').filter((seg) => seg.length > 0);
}

export function templateParamCount(template: string): number {
  return (template.match(PARAM_PATTERN) ?? []).length;
}

export function templateSlotNames(template: string): string[] {
  return template.match(SLOT_PATTERN) ?? [];
}

/**
 * V-L0 literal rule (r4 directive 1): a literal segment is admitted only under the closed
 * structural vocabulary; every other word is a session slot on the device. No hash promotion.
 */
export function literalSegmentRefusal(segment: string): string | null {
  return pathLiteralRefusal(segment);
}

function checkTemplateLiterals(template: string, where: string, errors: Errors): void {
  templateSegments(template).forEach((seg, i) => {
    if (MARKER_SEGMENT.test(seg)) return;
    const refusal = literalSegmentRefusal(seg);
    if (refusal !== null) errors.add(`${where}[${i}]`, refusal);
  });
}

function parseSlots(
  raw: unknown,
  template: string,
  where: string,
  errors: Errors,
): DigestSlot[] | null {
  if (!Array.isArray(raw) || raw.length > DIGEST_MAX_SLOTS) {
    errors.add(where, 'slots must be a list of at most 16');
    return null;
  }
  const expected = templateSlotNames(template);
  if (raw.length !== expected.length) {
    errors.add(where, 'slots must describe exactly the :s markers of the template');
    return null;
  }
  const out: DigestSlot[] = [];
  let ok = true;
  raw.forEach((s, i) => {
    const obj = asObject(s);
    const at = `${where}[${i}]`;
    if (obj === null || !checkKeys(obj, SLOT_KEYS, SLOT_KEYS, at, errors)) {
      ok = false;
      return;
    }
    if (obj.slot !== expected[i]) {
      errors.add(`${at}.slot`, `slot must be ${expected[i]}`);
      ok = false;
    }
    if (!(SLOT_CLASSES as readonly unknown[]).includes(obj.class)) {
      errors.add(`${at}.class`, 'unknown slot class');
      ok = false;
    }
    if (!isDistinctBucket(obj.distinct)) {
      errors.add(`${at}.distinct`, 'distinct must be 1, 2 or "3+"');
      ok = false;
    }
    if (ok)
      out.push(
        Object.freeze({
          slot: obj.slot as string,
          class: obj.class as SlotClass,
          distinct: obj.distinct as DistinctBucket,
        }),
      );
  });
  return ok ? out : null;
}

function parseQueryKeys(raw: unknown, where: string, errors: Errors): DigestQueryKey[] | null {
  if (!Array.isArray(raw) || raw.length > DIGEST_MAX_QUERY_KEYS) {
    errors.add(where, 'queryKeys must be a list of at most 32');
    return null;
  }
  const out: DigestQueryKey[] = [];
  const seen = new Set<string>();
  let ok = true;
  raw.forEach((q, i) => {
    const obj = asObject(q);
    const at = `${where}[${i}]`;
    if (obj === null || !checkKeys(obj, QUERY_KEY_KEYS, QUERY_KEY_KEYS, at, errors)) {
      ok = false;
      return;
    }
    const keyRefusal =
      typeof obj.key !== 'string'
        ? 'query key must be a string'
        : CREDENTIAL_KEY_PATTERN.test(obj.key)
          ? 'credential-pattern query key'
          : queryKeyRefusal(obj.key);
    if (keyRefusal !== null) {
      errors.add(`${at}.key`, keyRefusal);
      ok = false;
    } else if (seen.has(obj.key as string)) {
      errors.add(`${at}.key`, 'duplicate query key');
      ok = false;
    } else seen.add(obj.key as string);
    if (!isDistinctBucket(obj.distinct)) {
      errors.add(`${at}.distinct`, 'distinct must be 1, 2 or "3+"');
      ok = false;
    }
    if (ok) out.push(Object.freeze({ key: obj.key as string, distinct: obj.distinct as 1 }));
  });
  return ok ? out : null;
}

function parseTemplate(raw: unknown, index: number, errors: Errors): DigestTemplate | null {
  const where = `templates[${index}]`;
  const obj = asObject(raw);
  if (obj === null) {
    errors.add(where, 'template must be an object');
    return null;
  }
  if (!checkKeys(obj, TEMPLATE_KEYS, TEMPLATE_REQUIRED_KEYS, where, errors)) return null;
  let ok = true;
  if (typeof obj.ref !== 'string' || !TEMPLATE_REF_PATTERN.test(obj.ref)) {
    errors.add(`${where}.ref`, 'ref must be t0..t63');
    ok = false;
  }
  if (typeof obj.originRef !== 'string' || !ORIGIN_REF_PATTERN.test(obj.originRef)) {
    errors.add(`${where}.originRef`, 'originRef must be o0..o7');
    ok = false;
  }
  if (!(DISCOVERED_BY as readonly unknown[]).includes(obj.discoveredBy)) {
    errors.add(`${where}.discoveredBy`, 'discoveredBy must be landing|explore');
    ok = false;
  }
  const signals = obj.paginationSignals;
  if (
    !isStringList(signals, PAGINATION_SIGNALS.length) ||
    signals.some((sig) => !(PAGINATION_SIGNALS as readonly string[]).includes(sig)) ||
    signals.some((sig, i) => i > 0 && !(signals[i - 1] < sig))
  ) {
    errors.add(
      `${where}.paginationSignals`,
      'paginationSignals must be sorted distinct names from the closed pagination-signal list',
    );
    ok = false;
  } else if (signals.includes('total_equals_count') && !signals.includes('total_count_key')) {
    errors.add(`${where}.paginationSignals`, 'total_equals_count needs total_count_key');
    ok = false;
  } else if (
    signals.includes('single_response') &&
    Array.isArray(obj.queryKeys) &&
    obj.queryKeys.some((q) => asObject(q)?.distinct !== 1)
  ) {
    errors.add(`${where}.paginationSignals`, 'single_response contradicts query-key variants');
    ok = false;
  }
  const method = (DIGEST_METHODS as readonly unknown[]).includes(obj.method)
    ? (obj.method as DigestMethod)
    : null;
  if (method === null) {
    errors.add(`${where}.method`, 'method must be GET or HEAD');
    ok = false;
  }
  let slots: DigestSlot[] | null = null;
  if (typeof obj.template !== 'string' || !isWellFormedTemplate(obj.template)) {
    errors.add(
      `${where}.template`,
      'template must be root-relative and parameterised only by :p and :s',
    );
    ok = false;
  } else {
    checkTemplateLiterals(obj.template, `${where}.template`, errors);
    slots = parseSlots(obj.slots, obj.template, `${where}.slots`, errors);
    if (slots === null) ok = false;
  }
  const queryKeys = parseQueryKeys(obj.queryKeys, `${where}.queryKeys`, errors);
  if (queryKeys === null) ok = false;
  if (
    !Array.isArray(obj.statuses) ||
    obj.statuses.length > DIGEST_MAX_STATUSES ||
    obj.statuses.some((s) => !Number.isInteger(s) || (s as number) < 100 || (s as number) > 599) ||
    new Set(obj.statuses).size !== obj.statuses.length
  ) {
    errors.add(`${where}.statuses`, 'statuses must be distinct HTTP status integers');
    ok = false;
  }
  if (
    !Number.isInteger(obj.observations) ||
    (obj.observations as number) < 0 ||
    (obj.observations as number) > 1_000_000
  ) {
    errors.add(`${where}.observations`, 'observations must be a bounded non-negative integer');
    ok = false;
  }
  if (!(TEMPLATE_ROLES as readonly unknown[]).includes(obj.role)) {
    errors.add(`${where}.role`, 'role must be collection|single|refused');
    ok = false;
  } else if (obj.role === 'refused') {
    if (!(REFUSED_KINDS as readonly unknown[]).includes(obj.refusedKind)) {
      errors.add(`${where}.refusedKind`, 'a refused template needs refusedKind');
      ok = false;
    }
  } else if (obj.refusedKind !== undefined) {
    errors.add(`${where}.refusedKind`, 'refusedKind is for role refused only');
    ok = false;
  }
  const shape = parseShape(obj.shape, `${where}.shape`, 0, errors);
  if (shape === null) ok = false;
  const paths = obj.collectionPaths;
  if (
    !Array.isArray(paths) ||
    paths.length > DIGEST_MAX_COLLECTION_PATHS ||
    paths.some(
      (p) => !isStringList(p, DIGEST_MAX_SHAPE_DEPTH) || p.some((k) => !isBoundedText(k)),
    ) ||
    new Set(paths.map((p) => JSON.stringify(p))).size !== paths.length
  ) {
    errors.add(`${where}.collectionPaths`, 'collectionPaths must be at most 4 distinct key paths');
    ok = false;
  } else if (shape !== null) {
    paths.forEach((p: string[], i) => {
      if (itemShapeAt(shape, p) === null) {
        errors.add(`${where}.collectionPaths[${i}]`, 'path does not reach an array in the shape');
        ok = false;
      }
    });
    if (obj.role === 'collection' && paths.length === 0) {
      errors.add(`${where}.collectionPaths`, 'a collection template needs a collection path');
      ok = false;
    }
    if (obj.role !== 'collection' && paths.length > 0) {
      errors.add(`${where}.collectionPaths`, 'only a collection template lists collection paths');
      ok = false;
    }
  }
  if (!ok || shape === null || slots === null || queryKeys === null || method === null) return null;
  return Object.freeze({
    ref: obj.ref as string,
    originRef: obj.originRef as string,
    method,
    template: obj.template as string,
    slots: Object.freeze(slots),
    queryKeys: Object.freeze(queryKeys),
    paginationSignals: Object.freeze([...(signals as PaginationSignal[])]),
    statuses: Object.freeze([...(obj.statuses as number[])]),
    observations: obj.observations as number,
    role: obj.role as TemplateRole,
    ...(obj.refusedKind === undefined ? {} : { refusedKind: obj.refusedKind as RefusedKind }),
    collectionPaths: Object.freeze((paths as string[][]).map((p) => Object.freeze([...p]))),
    shape,
    discoveredBy: obj.discoveredBy as DiscoveredBy,
  });
}

function parseOrigins(raw: unknown, errors: Errors): DigestOrigin[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DIGEST_MAX_ORIGINS) {
    errors.add('origins', 'origins must list 1 to 8 origins (o0 = the authorized tab origin)');
    return null;
  }
  const out: DigestOrigin[] = [];
  const templates = new Set<string>();
  let ok = true;
  raw.forEach((o, i) => {
    const where = `origins[${i}]`;
    const obj = asObject(o);
    if (obj === null || !checkKeys(obj, ORIGIN_KEYS, ORIGIN_KEYS, where, errors)) {
      ok = false;
      return;
    }
    if (obj.ref !== `o${i}`) {
      errors.add(`${where}.ref`, `ref must be o${i} (position)`);
      ok = false;
    }
    if (typeof obj.template !== 'string' || !isBoundedText(obj.template, 128)) {
      errors.add(`${where}.template`, 'origin template must be bounded text');
      ok = false;
    } else {
      const refusal = originTemplateRefusal(obj.template);
      if (refusal !== null) {
        errors.add(`${where}.template`, refusal);
        ok = false;
      } else if (templates.has(obj.template)) {
        errors.add(`${where}.template`, 'duplicate origin template');
        ok = false;
      }
      templates.add(obj.template);
    }
    if (typeof obj.contacted !== 'boolean' || typeof obj.credentialed !== 'boolean') {
      errors.add(where, 'contacted and credentialed must be booleans');
      ok = false;
    }
    if (ok)
      out.push(
        Object.freeze({
          ref: obj.ref as string,
          template: obj.template as string,
          contacted: obj.contacted as boolean,
          credentialed: obj.credentialed as boolean,
        }),
      );
  });
  return ok ? out : null;
}

function parseTruncated(raw: unknown, errors: Errors): DigestTruncation | null {
  const obj = asObject(raw);
  if (obj === null || !checkKeys(obj, TRUNCATED_KEYS, TRUNCATED_KEYS, 'truncated', errors)) {
    if (obj === null) errors.add('truncated', 'truncated must be an object');
    return null;
  }
  if (
    typeof obj.templates !== 'boolean' ||
    typeof obj.linkTemplates !== 'boolean' ||
    !Number.isInteger(obj.shapes) ||
    (obj.shapes as number) < 0
  ) {
    errors.add('truncated', 'truncated must be {templates, linkTemplates: boolean; shapes: int}');
    return null;
  }
  return Object.freeze({
    templates: obj.templates,
    linkTemplates: obj.linkTemplates,
    shapes: obj.shapes as number,
  });
}

function parseLinkTemplates(raw: unknown, errors: Errors): DigestLinkTemplate[] | null {
  if (!Array.isArray(raw) || raw.length > DIGEST_MAX_LINK_TEMPLATES) {
    errors.add('linkTemplates', 'linkTemplates must be a list of at most 64');
    return null;
  }
  const out: DigestLinkTemplate[] = [];
  const templates = new Set<string>();
  let ok = true;
  raw.forEach((l, i) => {
    const where = `linkTemplates[${i}]`;
    const obj = asObject(l);
    if (obj === null || !checkKeys(obj, LINK_KEYS, LINK_KEYS, where, errors)) {
      ok = false;
      return;
    }
    if (obj.ref !== `l${i}`) {
      errors.add(`${where}.ref`, `ref must be l${i} (position in canonical order)`);
      ok = false;
    }
    if (typeof obj.template !== 'string' || !isWellFormedTemplate(obj.template)) {
      errors.add(`${where}.template`, 'link template must be root-relative and :p/:s only');
      ok = false;
    } else {
      checkTemplateLiterals(obj.template, `${where}.template`, errors);
      if (templates.has(obj.template)) {
        errors.add(`${where}.template`, 'duplicate link template');
        ok = false;
      }
      templates.add(obj.template);
    }
    if (typeof obj.captured !== 'boolean') {
      errors.add(`${where}.captured`, 'captured must be a boolean');
      ok = false;
    }
    if (ok)
      out.push(
        Object.freeze({
          ref: obj.ref as string,
          template: obj.template as string,
          captured: obj.captured as boolean,
        }),
      );
  });
  if (ok) {
    const sorted = [...out].sort((a, b) => compareText(a.template, b.template));
    if (sorted.some((l, i) => l !== out[i])) {
      errors.add('linkTemplates', 'link templates must be in canonical (code-unit) order');
      ok = false;
    }
  }
  return ok ? out : null;
}

function parseHeaderNames(raw: unknown, errors: Errors): string[] | null {
  if (!isStringList(raw, DIGEST_MAX_HEADER_NAMES)) {
    errors.add('constantHeaderNames', 'constantHeaderNames must be a list of at most 16 names');
    return null;
  }
  let ok = true;
  const seen = new Set<string>();
  raw.forEach((name, i) => {
    const refusal = CREDENTIAL_KEY_PATTERN.test(name)
      ? 'credential header name'
      : headerNameRefusal(name);
    if (refusal !== null) {
      errors.add(`constantHeaderNames[${i}]`, refusal);
      ok = false;
    } else if (seen.has(name.toLowerCase())) {
      errors.add(`constantHeaderNames[${i}]`, 'duplicate header name');
      ok = false;
    } else seen.add(name.toLowerCase());
  });
  return ok ? [...raw] : null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The admitted KEY PATHS of a shape (r5 D-L0-3): names only, no kinds or buckets; REQUIRED keys
 * only (a key listed in `optional` is a sparsity artefact, not structure; R591-B-B3); an array
 * step is `[]`; a `map` node is never entered (its keys are data). Sorted by code unit.
 */
export function shapeKeyPaths(root: ShapeNode): readonly string[] {
  const out: string[] = [];
  const walk = (node: ShapeNode, prefix: string): void => {
    if (node.kind === 'array') {
      walk(node.items, `${prefix}[]`);
      return;
    }
    if (node.kind !== 'object') return;
    const optional = new Set(node.optional ?? []);
    for (const key of Object.keys(node.keys).sort(compareText)) {
      if (optional.has(key)) continue;
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.push(path);
      walk(node.keys[key], path);
    }
  };
  walk(root, '');
  return out.sort(compareText);
}

/**
 * The reuse key of one template (D-L0-3, R591-B-B3): `JSON.stringify([originTemplate, method,
 * template])`. It contains no key, kind or bucket, so a sparser account (optional keys absent,
 * empty collections, `null` kinds) has the same reuse key. Shape is conformance, not identity.
 */
export function reuseKeyString(originTemplate: string, method: string, template: string): string {
  return JSON.stringify([originTemplate, method, template]);
}

/**
 * The structure key (r5 D-L0-3): the reuse key plus the sorted REQUIRED key paths. A digest
 * template MATCHES a package step when the reuse keys are equal and the digest's key paths are a
 * subset of the step's (`structureKeyMatches`): a sparser account observes fewer keys, never more
 * structure.
 */
export interface StructureKey {
  readonly origin: string;
  readonly method: DigestMethod;
  readonly template: string;
  readonly keyPaths: readonly string[];
}

export function structureKeyString(key: StructureKey): string {
  return JSON.stringify([key.origin, key.method, key.template, key.keyPaths]);
}

export function originTemplateOf(digest: StructureDigestV1, template: DigestTemplate): string {
  const origin = digest.origins.find((o) => o.ref === template.originRef);
  if (origin === undefined) throw new Error(`unknown originRef ${template.originRef}`);
  return origin.template;
}

export function structureKeyOf(digest: StructureDigestV1, template: DigestTemplate): StructureKey {
  return Object.freeze({
    origin: originTemplateOf(digest, template),
    method: template.method,
    template: template.template,
    keyPaths: shapeKeyPaths(template.shape),
  });
}

/**
 * Key-path INCLUSION (D-L0-3 round-2 monotone rule (ii), and the sparse-account direction of a
 * match): same identity and `digestKey.keyPaths` ⊆ `step.keyPaths`.
 */
export function structureKeyMatches(step: StructureKey, digestKey: StructureKey): boolean {
  if (!identityMatches(step, digestKey)) return false;
  const stepPaths = new Set(step.keyPaths);
  return digestKey.keyPaths.every((p) => stepPaths.has(p));
}

/**
 * Template IDENTITY (r7 D-L0-3): `(originTemplate, method, slotted template)` — the structure key
 * without its key paths. Every match in this slice is BY IDENTITY: a sparser account (fewer keys)
 * and key-path growth (extra admitted keys) are both compatible; extra digest keys bind nothing
 * (the mapping never names them) and are counted as `keypath_growth`, an audit drift signal,
 * never a trigger.
 */
export function identityString(key: StructureKey): string {
  return reuseKeyString(key.origin, key.method, key.template);
}

export function identityMatches(a: StructureKey, b: StructureKey): boolean {
  return a.origin === b.origin && a.method === b.method && a.template === b.template;
}

/** Admitted key paths of `digestKey` the package `step` never recorded (D-L0-3 `keypath_growth`). */
export function keyPathGrowth(step: StructureKey, digestKey: StructureKey): number {
  const stepPaths = new Set(step.keyPaths);
  return digestKey.keyPaths.filter((p) => !stepPaths.has(p)).length;
}

/**
 * The identities this digest OBSERVED, with their key paths (names only; no kinds, buckets or
 * values): what the round-1 pin stores as `observed_identities` (D-L0-5) and what the round-2
 * monotone rule reads (D-L0-3 (ii)). Every template participates, whatever its role.
 */
export function observedIdentities(digest: StructureDigestV1): readonly StructureKey[] {
  return Object.freeze(digest.templates.map((t) => structureKeyOf(digest, t)));
}

export interface UnionCheck {
  /** Round-1 identities the union re-observed with a strict superset of key paths. */
  readonly keyPathGrowth: number;
}

/**
 * D-L0-3 round-2 **monotone observation rule (ii)** (r7 `R581-c7A-01`, `R581-c7B-02`): for every
 * identity of the ROUND-1 DIGEST the union must contain the same identity with `keyPaths` ⊇ the
 * round-1 key paths; otherwise the digest is not a union of this run's observations and is
 * refused `digest_not_union`. Package steps are NEVER part of this test — a package step the run
 * did not observe is `template_absent` (`applyLearnedPackage().absentSteps`), never a refusal, so
 * a sparse account, an unvisited link or an unused feature can never fail round 2.
 */
export function checkUnionDigest(
  round1Observed: readonly StructureKey[],
  union: StructureDigestV1,
): LearnParseResult<UnionCheck> {
  const errors = new Errors('digest_not_union');
  if (union.round !== 2) {
    errors.add('round', 'the union digest must be round 2');
    return { ok: false, errors: errors.list };
  }
  const unionKeys = observedIdentities(union);
  let growth = 0;
  round1Observed.forEach((r1, i) => {
    const hits = unionKeys.filter((u) => identityMatches(u, r1));
    if (hits.length === 0) {
      errors.add(`round1[${i}]`, 'a round-1 identity is missing from the union digest');
      return;
    }
    const superset = hits.find((u) => structureKeyMatches(u, r1));
    if (superset === undefined) {
      errors.add(`round1[${i}]`, 'the union re-observes a round-1 identity with fewer key paths');
      return;
    }
    growth += keyPathGrowth(r1, superset);
  });
  if (errors.any) return { ok: false, errors: errors.list };
  return { ok: true, value: Object.freeze({ keyPathGrowth: growth }) };
}

/**
 * V-L0: strict keys at every level, bounds, version 2, origins under the host slot rule, root-relative `:p`/`:s` templates
 * whose literals are closed-vocabulary words only, typed slots matching the template, query key NAMES with
 * distinct buckets, header NAMES only, refs in canonical order, collection paths that reach
 * arrays, `refusedKind` for refused templates only, `missingFamilies` in round 2 only, and the
 * 32 KiB canonical-JSON bound. Total: every refusal is reported with a stable path.
 */
export function parseStructureDigest(raw: unknown): LearnParseResult<StructureDigestV1> {
  const errors = new Errors('V-L0');
  const obj = asObject(raw);
  if (obj === null) {
    errors.add('', 'digest must be an object');
    return { ok: false, errors: errors.list };
  }
  if (!checkKeys(obj, DIGEST_KEYS, DIGEST_KEYS, 'digest', errors)) {
    return { ok: false, errors: errors.list };
  }
  if (obj.digestVersion !== DIGEST_VERSION)
    errors.add('digestVersion', `digestVersion must be ${DIGEST_VERSION}`);
  if (obj.round !== 1 && obj.round !== 2) errors.add('round', 'round must be 1 or 2');
  const truncated = parseTruncated(obj.truncated, errors);
  const origins = parseOrigins(obj.origins, errors);
  const originByRef = new Map((origins ?? []).map((o) => [o.ref, o.template]));

  const templates: DigestTemplate[] = [];
  if (!Array.isArray(obj.templates) || obj.templates.length > DIGEST_MAX_TEMPLATES) {
    errors.add('templates', 'templates must be a list of at most 64');
  } else {
    const refs = new Set<string>();
    obj.templates.forEach((t, i) => {
      const parsed = parseTemplate(t, i, errors);
      if (parsed === null) return;
      if (parsed.ref !== `t${i}`)
        errors.add(`templates[${i}].ref`, `ref must be t${i} (position in canonical order)`);
      if (refs.has(parsed.ref)) errors.add(`templates[${i}].ref`, 'duplicate ref');
      refs.add(parsed.ref);
      if (origins !== null && !originByRef.has(parsed.originRef))
        errors.add(`templates[${i}].originRef`, 'originRef names no origin');
      if (obj.round === 1 && parsed.discoveredBy === 'explore')
        errors.add(`templates[${i}].discoveredBy`, 'explore-discovered templates are round 2 only');
      templates.push(parsed);
    });
    // Canonical order (D-L0-3): sorted by the structure key; one template per key.
    const keys = templates.map((t) =>
      structureKeyString({
        origin: originByRef.get(t.originRef) ?? '',
        method: t.method,
        template: t.template,
        keyPaths: shapeKeyPaths(t.shape),
      }),
    );
    keys.forEach((key, i) => {
      if (i > 0 && !(keys[i - 1] < key))
        errors.add(
          `templates[${i}]`,
          keys[i - 1] === key
            ? 'duplicate structure key'
            : 'templates must be in canonical order (origin, method, template, keyPaths)',
        );
    });
  }

  const linkTemplates = parseLinkTemplates(obj.linkTemplates, errors);
  const headerNames = parseHeaderNames(obj.constantHeaderNames, errors);
  const nonGet = obj.nonGetDataOrigins;
  if (
    typeof nonGet !== 'number' ||
    !Number.isInteger(nonGet) ||
    nonGet < 0 ||
    nonGet > DIGEST_MAX_NON_GET_DATA_ORIGINS
  )
    errors.add(
      'nonGetDataOrigins',
      `nonGetDataOrigins must be an integer count 0..${DIGEST_MAX_NON_GET_DATA_ORIGINS}`,
    );
  if (
    !isStringList(obj.missingFamilies, 32) ||
    obj.missingFamilies.some((f) => !isFamilyLabel(f)) ||
    new Set(obj.missingFamilies).size !== obj.missingFamilies.length
  ) {
    errors.add('missingFamilies', 'missingFamilies must be distinct family labels');
  } else if (obj.round === 1 && obj.missingFamilies.length > 0) {
    errors.add('missingFamilies', 'missingFamilies is round 2 only');
  }

  if (
    errors.any ||
    truncated === null ||
    linkTemplates === null ||
    headerNames === null ||
    origins === null
  )
    return { ok: false, errors: errors.list };
  const digest: StructureDigestV1 = Object.freeze({
    digestVersion: DIGEST_VERSION,
    round: obj.round as 1 | 2,
    truncated,
    origins: Object.freeze(origins),
    templates: Object.freeze(templates),
    linkTemplates: Object.freeze(linkTemplates),
    constantHeaderNames: Object.freeze(headerNames),
    nonGetDataOrigins: nonGet as number,
    missingFamilies: Object.freeze([...(obj.missingFamilies as FamilyLabel[])]),
  });
  const bytes = utf8Bytes(JSON.stringify(digest));
  if (bytes > DIGEST_MAX_BYTES) {
    errors.add('digest', `digest over ${DIGEST_MAX_BYTES} bytes`);
    return { ok: false, errors: errors.list };
  }
  return { ok: true, value: digest };
}

/** Any truncation leaves the closure open (D-L0-6.1 i-b); exposed for L1b's `closure.ts`. */
export function isTruncated(digest: StructureDigestV1): boolean {
  const t = digest.truncated;
  return t.templates || t.linkTemplates || t.shapes > 0;
}

/** Link templates not matching a captured template: the device's explore obligation (i-c). */
export function uncapturedLinkTemplates(digest: StructureDigestV1): readonly DigestLinkTemplate[] {
  return digest.linkTemplates.filter((l) => !l.captured);
}

/** Query keys observed with 2+ distinct values on a template (a filter may hide rows; i-d). */
export function filterVariantKeys(template: DigestTemplate): readonly string[] {
  return template.queryKeys.filter((q) => q.distinct !== 1).map((q) => q.key);
}

/** The templates the model may build steps on (role `collection`), keyed by ref. */
export function collectionTemplates(
  digest: StructureDigestV1,
): ReadonlyMap<string, DigestTemplate> {
  return new Map(digest.templates.filter((t) => t.role === 'collection').map((t) => [t.ref, t]));
}
