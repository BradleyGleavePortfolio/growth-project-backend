/**
 * S11-A2 — the two synthetic induction sources J09–J11 stage, declare and observe
 * (docs/decisions/2026-09-26-s11-journey.md D-S11-6, §3 J09–J11, D-S11-7(7)).
 *
 * `first` is the S10-D D2 synthetic source (D-S10-5): its mapping spec, native rules and
 * induction manifest are repository-resident, its rows, statement template and TEST-ONLY
 * signing key live under `test/fixtures/scout/s10_unseen/`. `second` is the S11-A2 synthetic
 * source: EVERYTHING about it (spec, rules, manifest, rows, template, key) lives under
 * `test/fixtures/scout/s11/s11_second/` and reaches the worker only through the
 * `input.induction` injection (`test/utils/g2-s11-worker.cjs`), so no `src/` file changes.
 *
 * Platform slugs are read from the fixture data, never typed in a spec or harness (D-S11-7(7)).
 * Evidence is built exactly as the D2 live proof built it (`test/scout/s10/s10-unseen.pg.spec.ts`):
 * the statement's `id_set_digest` uses an INDEPENDENT reference digest (sorted unique ids as
 * `<len>:<id>` concatenated, sha256) so the proof compares two implementations; the spec digest
 * is the service's own `mappingSpecDigest` over the parsed spec, which is what the evaluator
 * binds (E3). TEST-ONLY keys: never a real source key.
 */
import { createHash, createPrivateKey, sign } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mappingSpecDigest } from '../../../../src/scout/induction/digest';
import { parseSourceMappingSpec } from '../../../../src/scout/reconstruct/mapping-spec';
import {
  buildSourceMapperRegistry,
  loadSourceMappingSpecs,
  type SourceMapper,
} from '../../../../src/scout/reconstruct/source-mapper-registry';

export interface FixtureRow {
  readonly token: string;
  readonly source_id: string;
  readonly payload: Record<string, unknown>;
}
interface KeyPair {
  readonly key_id: string;
  readonly public_key_b64: string;
  readonly private_key_pkcs8_b64: string;
}
interface Statements {
  readonly evidence_version: number;
  readonly basis_kind: string;
  readonly template: {
    readonly date_window: null;
    readonly snapshot_ref_seed: string;
    readonly statement_version: number;
    readonly terminal: string;
  };
  readonly families: readonly string[];
}

/** One synthetic source as the proof sees it: data only, slug taken from the rows file. */
export interface SyntheticSource {
  readonly platform: string;
  /** sha256 of the fixture's `account_scope_seed` — the one declared scope (E6: exactly one). */
  readonly scope: string;
  /** The native-clean rows (coach-owned templates only, no roster; D2 learning). */
  readonly nativeClean: readonly FixtureRow[];
  readonly statements: Statements;
  readonly key: KeyPair;
  /** `mappingSpecDigest` of the parsed spec — what the evaluator's package binds (E3). */
  readonly specDigest: string;
  /** The spec's `families` keys, sorted (what the manifest's `expectedFamilies` must equal). */
  readonly families: readonly string[];
  /** Data-only packages to inject into the worker; empty for a repository-resident source. */
  readonly injected: {
    readonly specs: readonly unknown[];
    readonly rules: readonly unknown[];
    readonly manifests: readonly unknown[];
  };
}

const FIXTURES = join(__dirname, '..');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The D2 reference identity-set digest, independent of `src/scout/induction/digest.ts`. */
export function referenceIdDigest(ids: readonly string[]): string {
  const sorted = [...new Set(ids)]
    .map((id) => Buffer.from(id, 'utf8'))
    .sort((a, b) => Buffer.compare(a, b));
  return createHash('sha256')
    .update(Buffer.concat(sorted.map((b) => Buffer.concat([Buffer.from(`${b.length}:`), b]))))
    .digest('hex');
}

function statementBytes(fields: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(fields).sort()) sorted[key] = fields[key];
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

interface RowsFile {
  readonly source_platform: string;
  readonly account_scope_seed: string;
  readonly sets: Record<string, readonly FixtureRow[]>;
}

/* The D2 source: repository-resident packages; the D2 fixtures hold rows, template and key. */
const firstDir = join(FIXTURES, 's10_unseen');
const firstRows = readJson<RowsFile>(join(firstDir, 'staged-rows.json'));
const firstKeys = readJson<{ source: KeyPair }>(join(firstDir, 'signer-test-key.json'));
const firstStatements = readJson<Statements>(join(firstDir, 'statements.json'));

/* The A2 source: every artifact under this directory. */
const secondDir = join(__dirname, 's11_second');
const secondRows = readJson<RowsFile>(join(secondDir, 'staged-rows.json'));
const secondKeys = readJson<{ source: KeyPair }>(join(secondDir, 'signer-test-key.json'));
const secondStatements = readJson<Statements>(join(secondDir, 'statements.json'));
const secondSpecRaw = readJson<unknown>(join(secondDir, 'mapping-spec.json'));
const secondRulesRaw = readJson<unknown>(join(secondDir, 'native-rules.json'));
const secondManifestRaw = readJson<unknown>(join(secondDir, 'induction-manifest.json'));

/** What the worker receives as `input.induction`: the second source's data-only packages. */
export const INDUCTION_INPUT = Object.freeze({
  specs: [secondSpecRaw],
  rules: [secondRulesRaw],
  manifests: [secondManifestRaw],
});

/** The two-source mapper partition exactly as the worker composes it (defaults + injected). */
export const MAPPERS: ReadonlyMap<string, SourceMapper> = buildSourceMapperRegistry([
  ...loadSourceMappingSpecs(),
  parseSourceMappingSpec(secondSpecRaw, 's11-sources:second'),
]);

function source(
  rows: RowsFile,
  set: string,
  keys: { source: KeyPair },
  statements: Statements,
  injected: SyntheticSource['injected'],
): SyntheticSource {
  const mapper = MAPPERS.get(rows.source_platform);
  if (mapper === undefined) throw new Error(`no mapping spec for ${rows.source_platform}`);
  const nativeClean = rows.sets[set];
  if (nativeClean === undefined) throw new Error(`no row set ${set} for ${rows.source_platform}`);
  const specDigest = mappingSpecDigest(mapper.spec);
  if (specDigest === null) throw new Error(`mapping spec of ${rows.source_platform} has no digest`);
  return Object.freeze({
    platform: rows.source_platform,
    scope: sha256(rows.account_scope_seed),
    nativeClean,
    statements,
    key: keys.source,
    specDigest,
    families: Object.freeze(Object.keys(mapper.spec.families).sort(byString)),
    injected,
  });
}

/** The D2 source's `base` set minus its roster rows: the native-clean shape D2 (a) settled `complete` with. */
const firstNativeClean: RowsFile = {
  ...firstRows,
  sets: {
    native_clean: firstRows.sets.base.filter(
      (row) => mapperFamily(firstRows.source_platform, row.token) !== 'clients',
    ),
  },
};

function mapperFamily(platform: string, token: string): string | null {
  const mapper = MAPPERS.get(platform);
  if (mapper === undefined) return null;
  const step = mapper.resolveStep(token);
  return step.ok ? step.family : null;
}

export const SOURCES = Object.freeze({
  first: source(firstNativeClean, 'native_clean', firstKeys, firstStatements, {
    specs: [],
    rules: [],
    manifests: [],
  }),
  second: source(secondRows, 'native_clean', secondKeys, secondStatements, INDUCTION_INPUT),
});

/** The staged ids of `rows` per spec family of `src` (a declared family with no row → `[]`). */
export function idsByFamily(
  src: SyntheticSource,
  rows: readonly FixtureRow[],
): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  for (const family of src.families) ids[family] = [];
  for (const row of rows) {
    const family = mapperFamily(src.platform, row.token);
    if (family !== null) (ids[family] ??= []).push(row.source_id);
  }
  return ids;
}

/** The declaration entry for one source (one scope). */
export const declarationOf = (src: SyntheticSource) => ({
  source_platform: src.platform,
  account_scope_id_digests: [src.scope],
});

/** The worker's `ingest` body for one token of one source. */
export function batchOf(src: SyntheticSource, token: string, rows: readonly FixtureRow[]) {
  return {
    entity_type: token,
    sourcePlatform: src.platform,
    entities: rows
      .filter((row) => row.token === token)
      .map((row) => ({ sourceId: row.source_id, payload: row.payload })),
  };
}

/** Distinct tokens of `rows`, in first-seen order. */
export const tokensOf = (rows: readonly FixtureRow[]): string[] => [
  ...new Set(rows.map((row) => row.token)),
];

/**
 * One source-signed enumeration evidence for `(src, family)` over `ids`, bound to the run's
 * `challenge_b64` and `issued_at` — byte-for-byte the D2 construction.
 */
export function evidenceFor(
  src: SyntheticSource,
  family: string,
  ids: readonly string[],
  challengeB64: string,
  issuedAt: string,
) {
  const bytes = statementBytes({
    account_scope_id_digest: src.scope,
    challenge_b64: challengeB64,
    date_window: src.statements.template.date_window,
    family,
    id_set_digest: referenceIdDigest(ids),
    issued_at: issuedAt,
    observed_unique: new Set(ids).size,
    snapshot_ref_digest: sha256(src.statements.template.snapshot_ref_seed),
    source_platform: src.platform,
    statement_version: src.statements.template.statement_version,
    terminal: src.statements.template.terminal,
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(src.key.private_key_pkcs8_b64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    evidence_version: src.statements.evidence_version,
    source_platform: src.platform,
    account_scope_id_digest: src.scope,
    family,
    basis_kind: src.statements.basis_kind,
    mapping_spec_digest: src.specDigest,
    statement_b64: bytes.toString('base64'),
    key_id: src.key.key_id,
    signature_b64: sign(null, bytes, privateKey).toString('base64'),
  };
}

/** Every (family) evidence of `src` over `rows` — one statement per spec family, empty sets signed too. */
export function evidenceSet(
  src: SyntheticSource,
  rows: readonly FixtureRow[],
  challengeB64: string,
  issuedAt: string,
) {
  const ids = idsByFamily(src, rows);
  return src.families.map((family) =>
    evidenceFor(src, family, ids[family] ?? [], challengeB64, issuedAt),
  );
}
