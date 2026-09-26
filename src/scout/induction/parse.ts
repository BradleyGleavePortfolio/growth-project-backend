import { createPublicKey, type KeyObject } from 'crypto';
import { TextDecoder } from 'util';
import { CANONICAL_FAMILIES, type CanonicalFamily } from '../reconstruct/mapping-spec';
import { isCanonicalPlatform } from '../scout-platform';
import {
  CHALLENGE_BYTES,
  EVIDENCE_KEYS,
  HEX64_PATTERN,
  ISSUED_AT_MAX_BYTES,
  ISSUED_AT_PATTERN,
  KEY_ID_PATTERN,
  MANIFEST_KEYS,
  NATIVE_RULES_DECLARATIONS,
  OBSERVATION_BODY_MAX_BYTES,
  OBSERVED_UNIQUE_MAX,
  PROVING_BASIS_KINDS,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  STATEMENT_KEYS,
  STATEMENT_MAX_BYTES,
  VERIFIER_ALGORITHM,
  VERIFIER_KEYS,
  type ArtifactRejection,
  type InductionManifestV1,
  type InductionVerifierV1,
  type ObservationEvidenceV1,
  type ParseResult,
  type ProvingBasisKind,
  type SourceEnumerationStatementV1,
} from './contract';
import { canonicalJson } from './digest';

// S10-A — strict parsers. Untrusted artifacts (statement, evidence) return a
// `ParseResult` and never throw (D-S10-2 "Signed-artifact encoding"). The repository manifest
// is trusted-but-checked data and throws loudly at load (D-S10-1 V1, V4, V5), like
// `parseSourceMappingSpec`.

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj: object = value;
  return Object.fromEntries(Object.entries(obj));
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function keyRejection(
  obj: Record<string, unknown>,
  keys: readonly string[],
): ArtifactRejection | null {
  for (const key of Object.keys(obj)) if (!keys.includes(key)) return 'unknown_key';
  for (const key of keys) if (!hasOwn(obj, key)) return 'missing_key';
  return null;
}

export function isCanonicalFamily(value: unknown): value is CanonicalFamily {
  return typeof value === 'string' && (CANONICAL_FAMILIES as readonly string[]).includes(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64_PATTERN.test(value);
}

function isProvingBasisKind(value: unknown): value is ProvingBasisKind {
  return typeof value === 'string' && (PROVING_BASIS_KINDS as readonly string[]).includes(value);
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * RFC 4648 §4 base64: standard alphabet, padding, no whitespace, and decode→re-encode must equal
 * the input (so non-zero pad bits are refused). `null` on any deviation.
 */
export function decodeBase64Strict(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !BASE64_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** The longest base64 text that can decode to `bytes` bytes. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

// ── issued_at ───────────────────────────────────────────────────────────────────────────

/** An RFC 3339 UTC instant as a conservative millisecond interval `[floorMs, ceilMs]`. */
export interface InstantBounds {
  readonly floorMs: number;
  readonly ceilMs: number;
}

export function parseIssuedAt(value: unknown): InstantBounds | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > ISSUED_AT_MAX_BYTES) {
    return null;
  }
  const match = ISSUED_AT_PATTERN.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  const fraction = match[7] ?? '';
  const floorMs = date.getTime() + Number(fraction.padEnd(3, '0').slice(0, 3));
  const ceilMs = /[1-9]/.test(fraction.slice(3)) ? floorMs + 1 : floorMs;
  return { floorMs, ceilMs };
}

// ── SourceEnumerationStatementV1 ────────────────────────────────────────────────────────

export interface ParsedStatement {
  readonly statement: SourceEnumerationStatementV1;
  readonly challenge: Buffer;
  readonly issuedAt: InstantBounds;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function reject<T>(reason: ArtifactRejection): ParseResult<T> {
  return { ok: false, reason };
}

/**
 * Parse the DECODED statement bytes as strict canonical JSON (UTF-8 without BOM, exactly the
 * statement keys, sorted, no insignificant whitespace, integers only, minimal escaping): the
 * value must re-serialise to identical bytes. Then check every field's grammar and bounds.
 */
export function parseStatementBytes(bytes: Uint8Array): ParseResult<ParsedStatement> {
  if (bytes.length > STATEMENT_MAX_BYTES) return reject('too_large');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return reject('non_canonical_json');
  }
  let text: string;
  let raw: unknown;
  try {
    text = UTF8.decode(bytes);
    raw = JSON.parse(text);
  } catch {
    return reject('non_canonical_json');
  }
  const obj = asObject(raw);
  if (obj === null) return reject('not_object');
  const keys = keyRejection(obj, STATEMENT_KEYS);
  if (keys !== null) return reject(keys);
  // Also refuses duplicate keys: the parsed object re-serialises without the duplicate.
  if (canonicalJson(raw) !== text) return reject('non_canonical_json');

  if (obj.statement_version !== 1) return reject('bad_version');
  if (!isCanonicalPlatform(obj.source_platform)) return reject('bad_platform');
  if (!isHex64(obj.account_scope_id_digest)) return reject('bad_digest');
  if (!isCanonicalFamily(obj.family)) return reject('bad_family');
  if (typeof obj.challenge_b64 !== 'string') return reject('bad_base64');
  const challenge = decodeBase64Strict(obj.challenge_b64);
  if (challenge === null) return reject('bad_base64');
  if (challenge.length !== CHALLENGE_BYTES) return reject('bad_length');
  if (!isHex64(obj.snapshot_ref_digest)) return reject('bad_digest');
  if (obj.date_window !== null) return reject('bad_date_window');
  if (obj.terminal !== 'end_of_list') return reject('bad_terminal');
  const count = obj.observed_unique;
  if (typeof count !== 'number' || !Number.isInteger(count)) return reject('bad_count');
  if (count < 0 || count > OBSERVED_UNIQUE_MAX) return reject('bad_count');
  if (!isHex64(obj.id_set_digest)) return reject('bad_digest');
  const issuedAt = parseIssuedAt(obj.issued_at);
  if (issuedAt === null || typeof obj.issued_at !== 'string') return reject('bad_issued_at');

  const statement: SourceEnumerationStatementV1 = Object.freeze({
    statement_version: 1,
    source_platform: obj.source_platform,
    account_scope_id_digest: obj.account_scope_id_digest,
    family: obj.family,
    challenge_b64: obj.challenge_b64,
    snapshot_ref_digest: obj.snapshot_ref_digest,
    date_window: null,
    terminal: 'end_of_list',
    observed_unique: count,
    id_set_digest: obj.id_set_digest,
    issued_at: obj.issued_at,
  });
  return { ok: true, value: { statement, challenge, issuedAt } };
}

// ── ObservationEvidenceV1 ───────────────────────────────────────────────────────────────

export interface ParsedEvidence {
  readonly evidence: ObservationEvidenceV1;
  /** The decoded canonical statement bytes: the exact Ed25519 message (never the base64 text). */
  readonly statementBytes: Buffer;
  readonly parsedStatement: ParsedStatement;
  readonly signature: Buffer;
}

/** Validate one uploaded or stored evidence object (D-S10-2). Never throws. */
export function parseEvidence(raw: unknown): ParseResult<ParsedEvidence> {
  const obj = asObject(raw);
  if (obj === null) return reject('not_object');
  const keys = keyRejection(obj, EVIDENCE_KEYS);
  if (keys !== null) return reject(keys);
  if (obj.evidence_version !== 1) return reject('bad_version');
  if (!isCanonicalPlatform(obj.source_platform)) return reject('bad_platform');
  if (!isHex64(obj.account_scope_id_digest)) return reject('bad_digest');
  if (!isCanonicalFamily(obj.family)) return reject('bad_family');
  if (!isProvingBasisKind(obj.basis_kind)) return reject('unknown_basis_kind');
  if (!isHex64(obj.mapping_spec_digest)) return reject('bad_digest');
  if (typeof obj.key_id !== 'string' || !KEY_ID_PATTERN.test(obj.key_id)) {
    return reject('bad_key_id');
  }
  if (typeof obj.statement_b64 !== 'string') return reject('bad_base64');
  if (obj.statement_b64.length > base64Length(STATEMENT_MAX_BYTES)) return reject('too_large');
  const statementBytes = decodeBase64Strict(obj.statement_b64);
  if (statementBytes === null) return reject('bad_base64');
  if (typeof obj.signature_b64 !== 'string') return reject('bad_base64');
  const signature = decodeBase64Strict(obj.signature_b64);
  if (signature === null) return reject('bad_base64');
  if (signature.length !== SIGNATURE_BYTES) return reject('bad_length');
  const parsedStatement = parseStatementBytes(statementBytes);
  if (!parsedStatement.ok) return parsedStatement;

  const evidence: ObservationEvidenceV1 = Object.freeze({
    evidence_version: 1,
    source_platform: obj.source_platform,
    account_scope_id_digest: obj.account_scope_id_digest,
    family: obj.family,
    basis_kind: obj.basis_kind,
    mapping_spec_digest: obj.mapping_spec_digest,
    statement_b64: obj.statement_b64,
    key_id: obj.key_id,
    signature_b64: obj.signature_b64,
  });
  return {
    ok: true,
    value: { evidence, statementBytes, parsedStatement: parsedStatement.value, signature },
  };
}

/** The unit key `(platform, scope, family)` of one evidence object. */
export function unitKey(platform: string, scope: string, family: string): string {
  return JSON.stringify([platform, scope, family]);
}

/**
 * The observation body size bound (R21): ≤ 32 KiB of UTF-8. The route envelope, cardinality and
 * one-per-unit checks are S10-B's; this is only the pure byte bound. Never throws.
 */
export function checkObservationBodySize(byteLength: number): ParseResult<number> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return reject('bad_length');
  if (byteLength > OBSERVATION_BODY_MAX_BYTES) return reject('too_large');
  return { ok: true, value: byteLength };
}

// ── Ed25519 public keys ─────────────────────────────────────────────────────────────────

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Import a raw 32-byte Ed25519 public key; `null` if it is not one. Never throws. */
export function ed25519PublicKey(raw: Uint8Array): KeyObject | null {
  if (raw.length !== PUBLIC_KEY_BYTES) return null;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

// ── InductionManifestV1 (repository data; throws at load) ───────────────────────────────

function invalid(origin: string, detail: string): Error {
  return new Error(`invalid induction manifest (${origin}): ${detail}`);
}

function assertKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  origin: string,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) throw invalid(origin, `unknown key ${where}.${key}`);
  }
  for (const key of keys) {
    if (!hasOwn(obj, key)) throw invalid(origin, `missing key ${where}.${key}`);
  }
}

function parseVerifier(raw: unknown, origin: string, where: string): InductionVerifierV1 {
  const obj = asObject(raw);
  if (obj === null) throw invalid(origin, `${where} must be an object`);
  assertKeys(obj, VERIFIER_KEYS, origin, where);
  const { key_id, alg, public_key_b64 } = obj;
  if (typeof key_id !== 'string' || !KEY_ID_PATTERN.test(key_id)) {
    throw invalid(origin, `${where}.key_id must match ${KEY_ID_PATTERN.source}`);
  }
  if (alg !== VERIFIER_ALGORITHM) throw invalid(origin, `${where}.alg must be ed25519`);
  const bytes = decodeBase64Strict(public_key_b64);
  if (typeof public_key_b64 !== 'string' || bytes === null || ed25519PublicKey(bytes) === null) {
    throw invalid(origin, `${where}.public_key_b64 must be a canonical base64 32-byte key`);
  }
  return Object.freeze({ key_id, alg: VERIFIER_ALGORITHM, public_key_b64 });
}

/**
 * Validate an opaque JSON value as an `InductionManifestV1`: V1 strict keys, version 1, canonical
 * slug; V4 `basisKinds` keys equal `expectedFamilies`, values unique proving kinds; V5 verifiers
 * valid with unique `key_id`s and at least one when any family lists a kind. The file-name and
 * cross-artifact rules (V1 name, V2, V3, V6) live in `manifest-registry.ts`.
 */
export function parseInductionManifest(raw: unknown, origin: string): InductionManifestV1 {
  const obj = asObject(raw);
  if (obj === null) throw invalid(origin, 'manifest must be an object');
  assertKeys(obj, MANIFEST_KEYS, origin, 'manifest');
  if (obj.manifestVersion !== 1) throw invalid(origin, 'manifestVersion must be 1');
  const sourcePlatform = obj.sourcePlatform;
  if (!isCanonicalPlatform(sourcePlatform)) {
    throw invalid(origin, 'sourcePlatform must be a canonical platform token');
  }

  const familiesRaw = obj.expectedFamilies;
  if (!Array.isArray(familiesRaw) || familiesRaw.length === 0) {
    throw invalid(origin, 'expectedFamilies must be a non-empty array');
  }
  const expectedFamilies: CanonicalFamily[] = [];
  for (const family of familiesRaw) {
    if (!isCanonicalFamily(family)) throw invalid(origin, `expectedFamilies: ${String(family)}`);
    const last = expectedFamilies[expectedFamilies.length - 1];
    if (last !== undefined && !(last < family)) {
      throw invalid(origin, 'expectedFamilies must be sorted and unique');
    }
    expectedFamilies.push(family);
  }

  const kindsRaw = asObject(obj.basisKinds);
  if (kindsRaw === null) throw invalid(origin, 'basisKinds must be an object');
  assertKeys(kindsRaw, expectedFamilies, origin, 'basisKinds');
  const basisKinds: Partial<Record<CanonicalFamily, readonly ProvingBasisKind[]>> = {};
  let anyKind = false;
  for (const family of expectedFamilies) {
    const list = kindsRaw[family];
    if (!Array.isArray(list)) throw invalid(origin, `basisKinds.${family} must be an array`);
    const kinds: ProvingBasisKind[] = [];
    for (const kind of list) {
      if (!isProvingBasisKind(kind) || kinds.includes(kind)) {
        throw invalid(origin, `basisKinds.${family} must list unique kinds other than none`);
      }
      kinds.push(kind);
    }
    anyKind = anyKind || kinds.length > 0;
    basisKinds[family] = Object.freeze(kinds);
  }

  if (!Array.isArray(obj.verifiers)) throw invalid(origin, 'verifiers must be an array');
  const verifiers = obj.verifiers.map((v, i) => parseVerifier(v, origin, `verifiers[${i}]`));
  const ids = new Set(verifiers.map((v) => v.key_id));
  if (ids.size !== verifiers.length) throw invalid(origin, 'verifiers key_id must be unique');
  if (anyKind && verifiers.length === 0) {
    throw invalid(origin, 'a non-empty basisKinds list requires at least one verifier');
  }

  const nativeRules = obj.nativeRules;
  if (
    typeof nativeRules !== 'string' ||
    !(NATIVE_RULES_DECLARATIONS as readonly string[]).includes(nativeRules)
  ) {
    throw invalid(origin, 'nativeRules must be declared|absent');
  }

  return Object.freeze({
    manifestVersion: 1,
    sourcePlatform,
    expectedFamilies: Object.freeze(expectedFamilies),
    basisKinds: Object.freeze(basisKinds),
    verifiers: Object.freeze(verifiers),
    nativeRules: nativeRules === 'declared' ? 'declared' : 'absent',
  } satisfies InductionManifestV1);
}
