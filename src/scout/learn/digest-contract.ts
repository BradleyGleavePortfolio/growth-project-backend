import { isCanonicalPlatform } from '../scout-platform';
import { CANONICAL_FAMILIES, type CanonicalFamily } from '../reconstruct/mapping-spec';

/**
 * L1 (docs/decisions/2026-09-27-learn-and-remember.md D-L0-2) — the `StructureDigestV1` the
 * extension builds on the coach's computer and the strict parser (V-L0) the learn route applies
 * before anything else. The digest carries STRUCTURE ONLY: key names, kinds, value classes,
 * counts, URL templates with ids collapsed to `:p1..`, query key names and `Accept`-class constant
 * headers. Every byte of it is hostile input (D-L0-7.2): nothing here is executed, fetched or
 * written, only matched. No source name or host literal appears in this module (§3 invariant 1).
 */

export const DIGEST_VERSION = 1 as const;
export const DIGEST_MAX_TEMPLATES = 64;
export const DIGEST_MAX_LINK_TEMPLATES = 64;
export const DIGEST_MAX_COLLECTION_PATHS = 4;
export const DIGEST_MAX_SHAPE_DEPTH = 4;
export const DIGEST_MAX_KEYS_PER_OBJECT = 64;
export const DIGEST_MAX_KEY_BYTES = 64;
export const DIGEST_MAX_QUERY_KEYS = 32;
export const DIGEST_MAX_STATUSES = 8;
export const DIGEST_MAX_HEADERS = 16;
export const DIGEST_MAX_HEADER_VALUE_BYTES = 64;
export const DIGEST_MAX_TEMPLATE_BYTES = 512;
/** Upper bound of the canonical JSON of one digest (D-L0-2 "Bounds": 32 KiB). */
export const DIGEST_MAX_BYTES = 32 * 1024;

export const DIGEST_METHODS = ['GET', 'HEAD'] as const;
export type DigestMethod = (typeof DIGEST_METHODS)[number];
export const TEMPLATE_ROLES = ['collection', 'single', 'refused'] as const;
export type TemplateRole = (typeof TEMPLATE_ROLES)[number];
export const STRING_CLASSES = [
  'int_id',
  'uuid',
  'short_id',
  'iso_date',
  'email_like',
  'phone_like',
  'url',
  'text',
] as const;
export type StringClass = (typeof STRING_CLASSES)[number];
/** The string classes that may name a row identity (`idField`, D-L0-4). */
export const ID_CLASSES: readonly StringClass[] = ['int_id', 'uuid', 'short_id'];
export const NUMBER_CLASSES = ['int', 'float'] as const;
export const STRING_LENGTH_BUCKETS = ['≤8', '≤32', '≤256', '>256'] as const;
export const ARRAY_LENGTH_BUCKETS = ['0', '1', '2-9', '10-99', '100+'] as const;

export type ShapeNode =
  | {
      readonly kind: 'object';
      readonly keys: Readonly<Record<string, ShapeNode>>;
      readonly optional?: readonly string[];
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
  /** An object keyed by DATA (ids, dates): only the value shape is structural (X2 / L0R2-OPUS-B6). */
  | { readonly kind: 'map'; readonly values: ShapeNode }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'null' }
  | { readonly kind: 'mixed' };

export interface DigestTemplate {
  /** `t0`..`t63`; the model refers to templates by ref only. */
  readonly ref: string;
  readonly method: DigestMethod;
  /** Root-relative, ids collapsed to `:p1..`; never a host or scheme. */
  readonly template: string;
  /**
   * Zero-based indices of the template's LITERAL segments the extension proved structural (route
   * vocabulary observed with variation elsewhere in the path or across templates, C2b-1 A1
   * closure). V-L0 refuses a literal segment that is not listed and any listed index that is a
   * `:p` parameter; a value-like literal is refused even when listed. Route vocabulary cannot
   * hide a per-coach slug (`/coaches/<name>/clients/:p1`) behind one varied position.
   */
  readonly structural?: readonly number[];
  readonly queryKeys: readonly string[];
  /**
   * Distinct observed values per transmitted query NAME (X2 `queryVariants`): a key with 2+
   * variants is a filter (`status`), so the crawl may have seen a filtered subset. Closure marker.
   */
  readonly queryVariants?: Readonly<Record<string, number>>;
  /** Query names the extension withheld (not structural); closure marker. */
  readonly withheldQueryKeys?: number;
  readonly statuses: readonly number[];
  readonly observations: number;
  readonly role: TemplateRole;
  /** The extension's refusal reason for a `refused` template (a closed token, never a value). */
  readonly refusal?: string | null;
  readonly collectionPaths: readonly (readonly string[])[];
  readonly shape: ShapeNode;
}

/** One withheld-count entry (X2 `withheld`): why the extension dropped something, and how many. */
export interface DigestWithheld {
  readonly reason: string;
  readonly count: number;
}

export interface StructureDigestV1 {
  readonly digestVersion: typeof DIGEST_VERSION;
  readonly sourcePlatform: string;
  readonly round: 1 | 2;
  readonly templates: readonly DigestTemplate[];
  readonly linkTemplates: readonly string[];
  readonly constantHeaders: Readonly<Record<string, string>>;
  readonly missingFamilies: readonly CanonicalFamily[];
  /** Version of the extension's structural vocabulary the literal segments were proven against. */
  readonly vocabularyVersion?: number;
  /** Leading host labels withheld from `sourcePlatform` (X2: `alice.` in `alice.site.example`). */
  readonly originLabelsWithheld?: number;
  /** Link templates the extension visited; unexplored = linkTemplates − exploredLinkTemplates. */
  readonly exploredLinkTemplates?: readonly string[];
  /** Closure markers (L0 r3 defaults): the digest dropped templates at the 64 / 32 KiB bound. */
  readonly truncated?: boolean;
  /** Withheld counts by reason (X2): what the digest does not show, so L3 can hold `complete` open. */
  readonly withheld?: readonly DigestWithheld[];
  /** Salted per-run hashes proving slotted words structural (X2 seam); opaque here, bounded. */
  readonly slotProofs?: Readonly<Record<string, readonly string[]>>;
}

const DIGEST_KEYS = [
  'digestVersion',
  'sourcePlatform',
  'round',
  'templates',
  'linkTemplates',
  'constantHeaders',
  'missingFamilies',
  'vocabularyVersion',
  'originLabelsWithheld',
  'exploredLinkTemplates',
  'truncated',
  'withheld',
  'slotProofs',
] as const;
const DIGEST_OPTIONAL_KEYS: readonly string[] = [
  'vocabularyVersion',
  'originLabelsWithheld',
  'exploredLinkTemplates',
  'truncated',
  'withheld',
  'slotProofs',
];
const DIGEST_REQUIRED_KEYS = DIGEST_KEYS.filter((k) => !DIGEST_OPTIONAL_KEYS.includes(k));
const TEMPLATE_KEYS = [
  'ref',
  'method',
  'template',
  'structural',
  'queryKeys',
  'queryVariants',
  'withheldQueryKeys',
  'statuses',
  'observations',
  'role',
  'refusal',
  'collectionPaths',
  'shape',
] as const;
const TEMPLATE_OPTIONAL_KEYS: readonly string[] = [
  'structural',
  'queryVariants',
  'withheldQueryKeys',
  'refusal',
];
const TEMPLATE_REQUIRED_KEYS = TEMPLATE_KEYS.filter((k) => !TEMPLATE_OPTIONAL_KEYS.includes(k));
/** Closed-token pattern for refusal / withheld reasons (X2 emits snake_case tokens). */
const REASON_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SLOT_PROOF_PATTERN = /^[0-9a-f]{16,128}$/;
const DIGEST_MAX_WITHHELD = 32;
const DIGEST_MAX_SLOT_PROOFS = 16;
const REF_PATTERN = /^t(0|[1-9][0-9]?)$/;
/** Root-relative path segments: unreserved characters or a `:pN` parameter; no scheme, host or `//`. */
/**
 * Segments are unreserved literals, `:pN` row-id parameters or `:sN` session slots (L0 r3: a
 * literal the extension could not prove structural travels as a typed slot, never as a value).
 */
const TEMPLATE_PATTERN = /^(\/(?:[A-Za-z0-9._~%-]+|:p[1-9][0-9]?|:s[1-9][0-9]?))*\/?$/;
const PARAM_PATTERN = /:p[1-9][0-9]?/g;
const SLOT_PATTERN = /:s[1-9][0-9]?/g;
const MARKER_SEGMENT = /^:[ps][1-9][0-9]?$/;
/** A constant-header value must be a header slot marker (`:hN`, X2) or match this structural grammar. */
const HEADER_SLOT_PATTERN = /^:[hs][1-9][0-9]?$/;
const STRUCTURAL_HEADER_VALUE_PATTERNS: readonly RegExp[] = [
  /^\*\/\*$/,
  /^(application|text|multipart)\/[a-z0-9.+-]{1,40}(\s*;\s*(charset|q|v|version)=[A-Za-z0-9.-]{1,16}){0,2}(\s*,\s*(application|text)\/[a-z0-9.+-]{1,40}(\s*;\s*q=[0-9.]{1,4})?){0,3}$/,
  /^[a-z]{2,3}(-[A-Za-z]{2,4})?(\s*,\s*[a-z]{2,3}(-[A-Za-z]{2,4})?(\s*;\s*q=[0-9.]{1,4})?){0,4}$/,
  /^(XMLHttpRequest|fetch|same-origin|cors|no-cors|empty|no-cache|no-store|1|true|false|gzip|deflate|br|identity)$/,
  /^(gzip|deflate|br|identity|zstd)(\s*,\s*(gzip|deflate|br|identity|zstd)){0,4}$/,
  /^(no-cache|no-store|must-revalidate|private|public|max-age=[0-9]{1,3})(\s*,\s*(no-cache|no-store|must-revalidate|private|public|max-age=[0-9]{1,3})){0,4}$/,
];
const QUERY_KEY_PATTERN = /^[A-Za-z0-9._[\]-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Printable ASCII, ≤ 64 bytes, no digit run of 4 or more (D-L0-2 constant-header rule). */
const HEADER_VALUE_PATTERN = /^[\x20-\x7e]{1,64}$/;
const DIGIT_RUN_PATTERN = /[0-9]{4}/;
/**
 * Credential-pattern names refused anywhere in a digest (header names and shape keys). A digest
 * that names a credential is refused outright (D-L0-7.2 "Redaction"; §3 invariant 3).
 */
export const CREDENTIAL_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf[-_a-z0-9]*|x-xsrf[-_a-z0-9]*|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|bearer|password|passwd|secret|client[-_]?secret|private[-_]?key)$/i;
const SEC_HEADER_PATTERN = /^sec-/i;

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

/** Collects V-L0 refusals; the parse is total and reports every error it can, never throws. */
class Errors {
  readonly list: LearnValidationError[] = [];
  add(path: string, detail: string, code = 'V-L0'): void {
    if (this.list.length < 64) this.list.push({ code, path, detail });
  }
}

function checkKeys(
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

function checkKeyName(key: string, where: string, errors: Errors): void {
  if (key.length === 0) errors.add(where, 'empty key');
  else if (utf8Bytes(key) > DIGEST_MAX_KEY_BYTES) errors.add(where, 'key over 64 bytes');
  else if (CREDENTIAL_KEY_PATTERN.test(key)) errors.add(where, 'credential-pattern key');
}

/** Parse one shape node; depth counts container nesting from 0 at the template root (≤ 4 below it). */
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
      if (!checkKeys(obj, ['kind', 'values'], ['kind', 'values'], where, errors)) return null;
      if (depth > DIGEST_MAX_SHAPE_DEPTH) {
        errors.add(where, 'shape deeper than 4');
        return null;
      }
      const values = parseShape(obj.values, `${where}.values`, depth + 1, errors);
      return values === null ? null : { kind, values };
    }
    case 'object': {
      if (!checkKeys(obj, ['kind', 'keys', 'optional'], ['kind', 'keys'], where, errors))
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
      const keys: Record<string, ShapeNode> = {};
      for (const name of names) {
        checkKeyName(name, `${where}.keys.${name}`, errors);
        const child = parseShape(rawKeys[name], `${where}.keys.${name}`, depth + 1, errors);
        if (child === null) return null;
        keys[name] = child;
      }
      let optional: string[] | undefined;
      if (obj.optional !== undefined) {
        if (
          !isStringList(obj.optional, DIGEST_MAX_KEYS_PER_OBJECT) ||
          obj.optional.some((k) => !(k in keys))
        ) {
          errors.add(`${where}.optional`, 'optional must list keys of this object');
          return null;
        }
        optional = [...obj.optional];
      }
      return optional === undefined ? { kind, keys } : { kind, keys, optional };
    }
    default:
      errors.add(`${where}.kind`, 'unknown shape kind');
      return null;
  }
}

/** Walk `path` through object keys from `root`; `null` when a level is not an object with that key. */
export function shapeAtPath(root: ShapeNode, path: readonly string[]): ShapeNode | null {
  let node: ShapeNode = root;
  for (const key of path) {
    if (node.kind !== 'object' || !Object.prototype.hasOwnProperty.call(node.keys, key))
      return null;
    node = node.keys[key];
  }
  return node;
}

/** The item shape a collection path denotes: the array's `items` node, or `null` if it is not an array. */
export function itemShapeAt(root: ShapeNode, collectionPath: readonly string[]): ShapeNode | null {
  const node = shapeAtPath(root, collectionPath);
  return node !== null && node.kind === 'array' ? node.items : null;
}

/** Root-relative and `:p`-parameterised only; the parameters must be `:p1`, `:p2`, … in order. */
export function isWellFormedTemplate(template: string): boolean {
  if (utf8Bytes(template) > DIGEST_MAX_TEMPLATE_BYTES || !TEMPLATE_PATTERN.test(template))
    return false;
  const params = template.match(PARAM_PATTERN) ?? [];
  const slots = template.match(SLOT_PATTERN) ?? [];
  return params.every((p, i) => p === `:p${i + 1}`) && slots.every((p, i) => p === `:s${i + 1}`);
}

/** Path segments of a well-formed template (leading slash dropped, trailing slash ignored). */
export function templateSegments(template: string): string[] {
  return template.split('/').filter((seg) => seg.length > 0);
}

/**
 * A literal segment that looks like DATA, not route vocabulary: digits, hex or base64-ish runs,
 * uuids, e-mail or phone shapes, an `@`, a 4+ digit run, letter+digit mixes of 8+ chars, or
 * anything over 40 chars. Never accepted in a template, whatever the extension marks
 * (C2b-1 A1: a per-coach slug next to a legitimately varied `:p` must not reach the model or
 * the memory).
 */
export function isValueLikeSegment(segment: string): boolean {
  const seg = decodeURIComponentSafe(segment);
  if (seg.length > 40) return true;
  if (/^[0-9]+$/.test(seg)) return true;
  if (/[0-9]{4}/.test(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/[@+]/.test(seg) || /%40/i.test(segment)) return true;
  if (/^[A-Za-z0-9_-]{8,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg)) return true;
  return false;
}

function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Per-segment provenance (C2b-1 A1): every literal segment index is listed in `structural`, no
 * `:p` index is, and no literal segment is value-like. Returns a fixed detail or null.
 */
export function templateSegmentRefusal(template: string, structural: unknown): string | null {
  const segments = templateSegments(template);
  let marked: Set<number> | null = null;
  if (structural !== undefined) {
    if (
      !Array.isArray(structural) ||
      structural.some((i) => !Number.isInteger(i) || (i as number) < 0)
    ) {
      return 'structural must be a list of non-negative segment indices';
    }
    marked = new Set(structural as number[]);
    if (marked.size !== structural.length) return 'structural indices must be distinct';
    for (const i of marked)
      if (i >= segments.length) return 'structural index outside the template';
  }
  for (const [i, seg] of segments.entries()) {
    const isParam = MARKER_SEGMENT.test(seg);
    if (marked !== null && isParam && marked.has(i))
      return 'a :p parameter or :s slot cannot be marked structural';
    if (marked !== null && !isParam && !marked.has(i))
      return 'literal segment without structural provenance';
    if (!isParam && isValueLikeSegment(seg)) return 'value-like literal segment in template';
  }
  return null;
}

export function templateParamCount(template: string): number {
  return (template.match(PARAM_PATTERN) ?? []).length;
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
  if (typeof obj.ref !== 'string' || !REF_PATTERN.test(obj.ref)) {
    errors.add(`${where}.ref`, 'ref must be t0..t63');
    ok = false;
  }
  if (!(DIGEST_METHODS as readonly unknown[]).includes(obj.method)) {
    errors.add(`${where}.method`, 'method must be GET or HEAD');
    ok = false;
  }
  if (typeof obj.template !== 'string' || !isWellFormedTemplate(obj.template)) {
    errors.add(`${where}.template`, 'template must be root-relative and :p-parameterised only');
    ok = false;
  } else {
    const refusal = templateSegmentRefusal(obj.template, obj.structural);
    if (refusal !== null) {
      errors.add(`${where}.structural`, refusal);
      ok = false;
    }
  }
  if (
    !isStringList(obj.queryKeys, DIGEST_MAX_QUERY_KEYS) ||
    obj.queryKeys.some((k) => !QUERY_KEY_PATTERN.test(k) || CREDENTIAL_KEY_PATTERN.test(k)) ||
    new Set(obj.queryKeys).size !== obj.queryKeys.length
  ) {
    errors.add(`${where}.queryKeys`, 'queryKeys must be distinct, credential-free names');
    ok = false;
  }
  const variants = obj.queryVariants === undefined ? null : asObject(obj.queryVariants);
  if (
    obj.queryVariants !== undefined &&
    (variants === null ||
      !Array.isArray(obj.queryKeys) ||
      Object.keys(variants).some((k) => !(obj.queryKeys as unknown[]).includes(k)) ||
      Object.values(variants).some((n) => !Number.isInteger(n) || (n as number) < 0))
  ) {
    errors.add(`${where}.queryVariants`, 'queryVariants must count query keys of this template');
    ok = false;
  }
  if (
    obj.withheldQueryKeys !== undefined &&
    (!Number.isInteger(obj.withheldQueryKeys) || (obj.withheldQueryKeys as number) < 0)
  ) {
    errors.add(`${where}.withheldQueryKeys`, 'withheldQueryKeys must be a non-negative integer');
    ok = false;
  }
  if (
    obj.refusal !== undefined &&
    obj.refusal !== null &&
    (typeof obj.refusal !== 'string' || !REASON_TOKEN_PATTERN.test(obj.refusal))
  ) {
    errors.add(`${where}.refusal`, 'refusal must be null or a closed reason token');
    ok = false;
  }
  if (
    !Array.isArray(obj.statuses) ||
    obj.statuses.length > DIGEST_MAX_STATUSES ||
    obj.statuses.some((s) => !Number.isInteger(s) || (s as number) < 100 || (s as number) > 599)
  ) {
    errors.add(`${where}.statuses`, 'statuses must be HTTP status integers');
    ok = false;
  }
  if (!Number.isInteger(obj.observations) || (obj.observations as number) < 0) {
    errors.add(`${where}.observations`, 'observations must be a non-negative integer');
    ok = false;
  }
  if (!(TEMPLATE_ROLES as readonly unknown[]).includes(obj.role)) {
    errors.add(`${where}.role`, 'role must be collection|single|refused');
    ok = false;
  }
  const shape = parseShape(obj.shape, `${where}.shape`, 0, errors);
  if (shape === null) ok = false;
  const paths = obj.collectionPaths;
  if (
    !Array.isArray(paths) ||
    paths.length > DIGEST_MAX_COLLECTION_PATHS ||
    paths.some((p) => !isStringList(p, DIGEST_MAX_SHAPE_DEPTH) || p.some((k) => k.length === 0))
  ) {
    errors.add(`${where}.collectionPaths`, 'collectionPaths must be at most 4 key paths');
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
  }
  if (!ok || shape === null) return null;
  return Object.freeze({
    ref: obj.ref as string,
    method: obj.method as DigestMethod,
    template: obj.template as string,
    ...(obj.structural === undefined
      ? {}
      : { structural: Object.freeze([...(obj.structural as number[])].sort((a, b) => a - b)) }),
    queryKeys: Object.freeze([...(obj.queryKeys as string[])]),
    ...(variants === null
      ? {}
      : { queryVariants: Object.freeze({ ...(variants as Record<string, number>) }) }),
    ...(obj.withheldQueryKeys === undefined
      ? {}
      : { withheldQueryKeys: obj.withheldQueryKeys as number }),
    statuses: Object.freeze([...(obj.statuses as number[])]),
    observations: obj.observations as number,
    role: obj.role as TemplateRole,
    ...(obj.refusal === undefined ? {} : { refusal: obj.refusal as string | null }),
    collectionPaths: Object.freeze((paths as string[][]).map((p) => Object.freeze([...p]))),
    shape,
  });
}

/** A slot marker or a value of the fixed structural grammar (media types, languages, encodings). */
export function isStructuralHeaderValue(value: string): boolean {
  return (
    HEADER_SLOT_PATTERN.test(value) || STRUCTURAL_HEADER_VALUE_PATTERNS.some((p) => p.test(value))
  );
}

function parseHeaders(raw: unknown, errors: Errors): Record<string, string> | null {
  const obj = asObject(raw);
  if (obj === null) {
    errors.add('constantHeaders', 'constantHeaders must be an object');
    return null;
  }
  const names = Object.keys(obj);
  if (names.length > DIGEST_MAX_HEADERS) {
    errors.add('constantHeaders', 'more than 16 headers');
    return null;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const name of names) {
    const value = obj[name];
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      CREDENTIAL_KEY_PATTERN.test(name) ||
      SEC_HEADER_PATTERN.test(name)
    ) {
      errors.add(`constantHeaders.${name}`, 'credential or non-constant header name');
      ok = false;
    } else if (
      typeof value !== 'string' ||
      !HEADER_VALUE_PATTERN.test(value) ||
      DIGIT_RUN_PATTERN.test(value)
    ) {
      errors.add(`constantHeaders.${name}`, 'header value fails the constant-header rule');
      ok = false;
    } else if (!isStructuralHeaderValue(value)) {
      // L0 r3: a value the extension could not prove structural travels as a session slot
      // (`:s1`), never as bytes; a tenant marker or build token never reaches the model.
      errors.add(
        `constantHeaders.${name}`,
        'header value without structural provenance; send a session slot',
      );
      ok = false;
    } else out[name] = value;
  }
  return ok ? out : null;
}

/**
 * V-L0: strict keys, bounds, canonical slug, root-relative `:p`-only templates, distinct refs,
 * credential-free names, collection paths that reach arrays. Total: every refusal is reported
 * with a stable path, nothing throws.
 */
export function parseStructureDigest(raw: unknown): LearnParseResult<StructureDigestV1> {
  const errors = new Errors();
  const obj = asObject(raw);
  if (obj === null) {
    errors.add('', 'digest must be an object');
    return { ok: false, errors: errors.list };
  }
  if (!checkKeys(obj, DIGEST_KEYS, DIGEST_REQUIRED_KEYS, 'digest', errors)) {
    return { ok: false, errors: errors.list };
  }
  if (obj.digestVersion !== DIGEST_VERSION) errors.add('digestVersion', 'digestVersion must be 1');
  if (!isCanonicalPlatform(obj.sourcePlatform)) {
    errors.add('sourcePlatform', 'sourcePlatform must be a canonical platform token');
  }
  if (obj.round !== 1 && obj.round !== 2) errors.add('round', 'round must be 1 or 2');
  if (obj.truncated !== undefined && typeof obj.truncated !== 'boolean') {
    errors.add('truncated', 'truncated must be a boolean');
  }

  const templates: DigestTemplate[] = [];
  if (!Array.isArray(obj.templates) || obj.templates.length > DIGEST_MAX_TEMPLATES) {
    errors.add('templates', 'templates must be a list of at most 64');
  } else {
    const refs = new Set<string>();
    obj.templates.forEach((t, i) => {
      const parsed = parseTemplate(t, i, errors);
      if (parsed === null) return;
      if (refs.has(parsed.ref)) errors.add(`templates[${i}].ref`, 'duplicate ref');
      refs.add(parsed.ref);
      templates.push(parsed);
    });
  }

  if (
    !isStringList(obj.linkTemplates, DIGEST_MAX_LINK_TEMPLATES) ||
    obj.linkTemplates.some(
      (t) =>
        !isWellFormedTemplate(t) ||
        templateSegments(t).some((seg) => !MARKER_SEGMENT.test(seg) && isValueLikeSegment(seg)),
    ) ||
    new Set(obj.linkTemplates).size !== obj.linkTemplates.length
  ) {
    errors.add('linkTemplates', 'linkTemplates must be distinct root-relative :p-only paths');
  }
  if (
    obj.exploredLinkTemplates !== undefined &&
    (!isStringList(obj.exploredLinkTemplates, DIGEST_MAX_LINK_TEMPLATES) ||
      !Array.isArray(obj.linkTemplates) ||
      obj.exploredLinkTemplates.some((t) => !(obj.linkTemplates as unknown[]).includes(t)) ||
      new Set(obj.exploredLinkTemplates).size !== obj.exploredLinkTemplates.length)
  ) {
    errors.add('exploredLinkTemplates', 'exploredLinkTemplates must be distinct linkTemplates');
  }
  if (
    obj.vocabularyVersion !== undefined &&
    (!Number.isInteger(obj.vocabularyVersion) || (obj.vocabularyVersion as number) < 1)
  ) {
    errors.add('vocabularyVersion', 'vocabularyVersion must be a positive integer');
  }
  if (
    obj.originLabelsWithheld !== undefined &&
    (!Number.isInteger(obj.originLabelsWithheld) || (obj.originLabelsWithheld as number) < 0)
  ) {
    errors.add('originLabelsWithheld', 'originLabelsWithheld must be a non-negative integer');
  }
  const withheld = parseWithheld(obj.withheld, errors);
  const slotProofs = parseSlotProofs(obj.slotProofs, errors);
  const headers = parseHeaders(obj.constantHeaders, errors);
  if (
    !isStringList(obj.missingFamilies, CANONICAL_FAMILIES.length) ||
    obj.missingFamilies.some((f) => !(CANONICAL_FAMILIES as readonly string[]).includes(f)) ||
    new Set(obj.missingFamilies).size !== obj.missingFamilies.length
  ) {
    errors.add('missingFamilies', 'missingFamilies must be distinct canonical families');
  } else if (obj.round === 1 && obj.missingFamilies.length > 0) {
    errors.add('missingFamilies', 'missingFamilies is round 2 only');
  }

  if (errors.list.length > 0 || headers === null) return { ok: false, errors: errors.list };
  const digest: StructureDigestV1 = Object.freeze({
    digestVersion: DIGEST_VERSION,
    sourcePlatform: obj.sourcePlatform as string,
    round: obj.round as 1 | 2,
    templates: Object.freeze(templates),
    linkTemplates: Object.freeze([...(obj.linkTemplates as string[])]),
    constantHeaders: Object.freeze(headers),
    missingFamilies: Object.freeze([...(obj.missingFamilies as CanonicalFamily[])]),
    ...(obj.vocabularyVersion === undefined
      ? {}
      : { vocabularyVersion: obj.vocabularyVersion as number }),
    ...(obj.originLabelsWithheld === undefined
      ? {}
      : { originLabelsWithheld: obj.originLabelsWithheld as number }),
    ...(obj.exploredLinkTemplates === undefined
      ? {}
      : { exploredLinkTemplates: Object.freeze([...(obj.exploredLinkTemplates as string[])]) }),
    ...(obj.truncated === undefined ? {} : { truncated: obj.truncated as boolean }),
    ...(withheld === null ? {} : { withheld }),
    ...(slotProofs === null ? {} : { slotProofs }),
  });
  return { ok: true, value: digest };
}

/** `withheld`: at most 32 `{reason, count}` entries with closed reason tokens (absent ⇒ null). */
function parseWithheld(raw: unknown, errors: Errors): readonly DigestWithheld[] | null {
  if (raw === undefined) return null;
  if (
    !Array.isArray(raw) ||
    raw.length > DIGEST_MAX_WITHHELD ||
    raw.some((w) => {
      const o = asObject(w);
      return (
        o === null ||
        Object.keys(o).some((k) => k !== 'reason' && k !== 'count') ||
        typeof o.reason !== 'string' ||
        !REASON_TOKEN_PATTERN.test(o.reason) ||
        !Number.isInteger(o.count) ||
        (o.count as number) < 0
      );
    })
  ) {
    errors.add('withheld', 'withheld must list {reason, count} with closed reason tokens');
    return null;
  }
  return Object.freeze(
    (raw as { reason: string; count: number }[]).map((w) =>
      Object.freeze({ reason: w.reason, count: w.count }),
    ),
  );
}

/** `slotProofs`: ref → ≤ 16 lower-case hex strings of 16..128 chars (opaque salted hashes). */
function parseSlotProofs(
  raw: unknown,
  errors: Errors,
): Readonly<Record<string, readonly string[]>> | null {
  if (raw === undefined) return null;
  const obj = asObject(raw);
  if (
    obj === null ||
    Object.keys(obj).length > DIGEST_MAX_TEMPLATES ||
    Object.entries(obj).some(
      ([ref, proofs]) =>
        !REF_PATTERN.test(ref) ||
        !isStringList(proofs, DIGEST_MAX_SLOT_PROOFS) ||
        proofs.some((p) => !SLOT_PROOF_PATTERN.test(p)),
    )
  ) {
    errors.add('slotProofs', 'slotProofs must map refs to bounded hex proofs');
    return null;
  }
  const out: Record<string, readonly string[]> = {};
  for (const [ref, proofs] of Object.entries(obj))
    out[ref] = Object.freeze([...(proofs as string[])]);
  return Object.freeze(out);
}

/** Link templates the extension saw but did not visit (closure marker for L3). */
export function unexploredLinkTemplates(digest: StructureDigestV1): readonly string[] {
  const explored = new Set(digest.exploredLinkTemplates ?? []);
  return digest.linkTemplates.filter((t) => !explored.has(t));
}

/** Query keys observed with 2+ distinct values on a template (a filter may hide rows). */
export function filterVariantKeys(template: DigestTemplate): readonly string[] {
  return Object.entries(template.queryVariants ?? {})
    .filter(([, n]) => n >= 2)
    .map(([k]) => k);
}

/** The templates the model may build steps on (role `collection`), keyed by ref. */
export function collectionTemplates(
  digest: StructureDigestV1,
): ReadonlyMap<string, DigestTemplate> {
  return new Map(digest.templates.filter((t) => t.role === 'collection').map((t) => [t.ref, t]));
}
