import { createHash } from 'crypto';
import type { SourceMappingSpec } from '../reconstruct/mapping-spec';

// S10-A — digests (D-S10-2 "Identity digest", "mapping_spec_digest") and the strict canonical
// JSON serialiser shared with `parse.ts`. Pure and total: an unsupported value yields `null`,
// never a throw, so callers fail closed.

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A lone UTF-16 surrogate has no UTF-8 encoding; such a string is never canonical. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormedString(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/** Code-point order is UTF-8 byte order. */
function compareCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Strict canonical JSON text: object keys sorted by code point, no insignificant whitespace,
 * safe integers only, minimal string escaping (`JSON.stringify` escapes only `"`, `\` and
 * U+0000-U+001F). `null` when the value holds anything else (a non-integer, `undefined`, a lone
 * surrogate, a non-plain object).
 */
export function canonicalJson(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
    return String(value);
  }
  if (typeof value === 'string') return isWellFormedString(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const text = canonicalJson(item);
      if (text === null) return null;
      items.push(text);
    }
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort(compareCodePoints);
  const members: string[] = [];
  for (const key of keys) {
    if (!isWellFormedString(key)) return null;
    const text = canonicalJson(value[key]);
    if (text === null) return null;
    members.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${members.join(',')}}`;
}

export interface IdentitySetDigest {
  /** sha256 hex over the length-prefixed, bytewise-sorted distinct ids. */
  readonly digest: string;
  /** The number of distinct ids. */
  readonly count: number;
}

/**
 * D-S10-2 identity digest: sha256 over the bytewise-sorted distinct `source_id`s, each encoded
 * `<utf8-byte-length>:<id>` and concatenated. The empty set digests `""`. `null` when an id has
 * no UTF-8 encoding (a lone surrogate), so two distinct ids can never collide in bytes.
 */
export function identitySetDigest(sourceIds: Iterable<string>): IdentitySetDigest | null {
  const distinct = new Map<string, Buffer>();
  for (const id of sourceIds) {
    if (typeof id !== 'string' || !isWellFormedString(id)) return null;
    if (!distinct.has(id)) distinct.set(id, Buffer.from(id, 'utf8'));
  }
  const sorted = [...distinct.values()].sort(Buffer.compare);
  const hash = createHash('sha256');
  for (const bytes of sorted) {
    hash.update(`${bytes.length}:`, 'utf8');
    hash.update(bytes);
  }
  return { digest: hash.digest('hex'), count: sorted.length };
}

/** The identity-set digest of the empty set (`sha256("")`). */
export const EMPTY_IDENTITY_SET_DIGEST = sha256Hex('');

/**
 * Staged-side digests per family, computed from rows ALREADY grouped by S9-B's own classifier
 * (D-S10-3 E6: S10-C passes `resolveFamily`'s partition; nothing here re-derives a family).
 * `null` for a family whose ids cannot be digested.
 */
export function stagedFamilyDigests(
  groups: Iterable<readonly [string, Iterable<string>]>,
): ReadonlyMap<string, IdentitySetDigest | null> {
  const out = new Map<string, IdentitySetDigest | null>();
  for (const [family, ids] of groups) {
    // A family grouped twice is a partition disagreement: poison it rather than merge.
    out.set(family, out.has(family) ? null : identitySetDigest(ids));
  }
  return out;
}

/** `mapping_spec_digest`: sha256 of the loaded spec's canonical JSON, or `null` if unserialisable. */
export function mappingSpecDigest(spec: SourceMappingSpec): string | null {
  const text = canonicalJson(spec);
  return text === null ? null : sha256Hex(text);
}
