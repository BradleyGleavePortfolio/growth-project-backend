import { createHash, createPrivateKey, sign, type KeyObject } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

// TEST-ONLY synthetic source signer for the S10-A pure tier. It builds statements
// independently of `src/scout/induction/digest.ts` (keys inserted in sorted order and
// serialised with JSON.stringify), so the parser is checked against bytes it did not make.

export const S10_PURE_DIR = __dirname;
export const S10_PURE_MANIFESTS_DIR = join(__dirname, 'induction');
export const S10_PURE_SPEC_PATH = join(__dirname, 'mapping', 's10_unseen.json');

interface KeyPair {
  readonly key_id: string;
  readonly public_key_b64: string;
  readonly private_key_pkcs8_b64: string;
}

function readKeys(): { readonly source: KeyPair; readonly observer: KeyPair } {
  return JSON.parse(readFileSync(join(__dirname, 'signer-test-key.json'), 'utf8'));
}

export const TEST_KEYS = readKeys();

function privateKey(pair: KeyPair): KeyObject {
  return createPrivateKey({
    key: Buffer.from(pair.private_key_pkcs8_b64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

export const SOURCE_KEY = privateKey(TEST_KEYS.source);
export const OBSERVER_KEY = privateKey(TEST_KEYS.observer);

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Independent reference identity digest: sorted `<len>:<id>` concatenation. */
export function referenceIdDigest(ids: readonly string[]): string {
  const sorted = [...new Set(ids)]
    .map((id) => Buffer.from(id, 'utf8'))
    .sort((a, b) => Buffer.compare(a, b));
  return createHash('sha256')
    .update(Buffer.concat(sorted.map((b) => Buffer.concat([Buffer.from(`${b.length}:`), b]))))
    .digest('hex');
}

export type StatementFields = Record<string, unknown>;

/** Canonical bytes of a flat statement: keys sorted by code point, compact JSON. */
export function canonicalStatementBytes(fields: StatementFields): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key];
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

export function signBytes(bytes: Uint8Array, key: KeyObject = SOURCE_KEY): Buffer {
  return sign(null, bytes, key);
}

export interface EvidenceParts {
  readonly statementBytes: Buffer;
  readonly signature?: Buffer;
  readonly key_id?: string;
  readonly overrides?: Record<string, unknown>;
}

/** An `ObservationEvidenceV1` object carrying `statementBytes` signed by the source key. */
export function evidenceFor(
  statement: StatementFields,
  specDigest: string,
  parts: Partial<EvidenceParts> = {},
): Record<string, unknown> {
  const statementBytes = parts.statementBytes ?? canonicalStatementBytes(statement);
  const signature = parts.signature ?? signBytes(statementBytes);
  return {
    evidence_version: 1,
    source_platform: statement.source_platform,
    account_scope_id_digest: statement.account_scope_id_digest,
    family: statement.family,
    basis_kind: 'source_signed_enumeration',
    mapping_spec_digest: specDigest,
    statement_b64: statementBytes.toString('base64'),
    key_id: parts.key_id ?? TEST_KEYS.source.key_id,
    signature_b64: signature.toString('base64'),
    ...(parts.overrides ?? {}),
  };
}
