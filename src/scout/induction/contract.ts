import type { CanonicalFamily } from '../reconstruct/mapping-spec';

// S10-A — the pure induction contract (docs/decisions/2026-09-26-s10-induction.md D-S10-1,
// D-S10-2, D-S10-4 "Refusals"). Data shapes, closed vocabularies and bounds only: no I/O, no
// Nest, no source-name literal (D-S10-8). `parse.ts` validates, `digest.ts` digests and
// `verify.ts` evaluates against these definitions.

// ── Closed, append-only vocabularies ────────────────────────────────────────────────────

/**
 * D-S10-2: `COMPLETENESS_BASIS_KINDS` (S9-DOC L217-218; S9-ADD-A A.2). `none` ⇔ `known: false`.
 * Append-only: a new kind needs an addendum, an evaluator rule and negative cases; no kind is
 * removed, renamed or named after a source. A page-chain kind is deferred (§5) and absent here,
 * so chain evidence is always an unknown kind.
 */
export const COMPLETENESS_BASIS_KINDS = ['none', 'source_signed_enumeration'] as const;
export type CompletenessBasisKind = (typeof COMPLETENESS_BASIS_KINDS)[number];

/** The kinds a manifest may list in `basisKinds` (D-S10-1 V4: every kind except `none`). */
export type ProvingBasisKind = Exclude<CompletenessBasisKind, 'none'>;
export const PROVING_BASIS_KINDS: readonly ProvingBasisKind[] = ['source_signed_enumeration'];

/** D-S10-4 refusal codes of the S10-B observation routes (beside `RUN_CONFLICT_CODES`, unedited). */
export const OBSERVATION_CONFLICT_CODES = [
  'declaration_conflict',
  'declaration_after_ingest',
  'declaration_missing',
  'observation_conflict',
  'observation_after_claim',
  'observation_not_declared',
] as const;
export type ObservationConflictCode = (typeof OBSERVATION_CONFLICT_CODES)[number];

export type NativeRulesDeclaration = 'declared' | 'absent';
export const NATIVE_RULES_DECLARATIONS: readonly NativeRulesDeclaration[] = ['declared', 'absent'];

export const VERIFIER_ALGORITHM = 'ed25519';

// ── Bounds (D-S10-2 "Signed-artifact encoding" and "Privacy and bounds") ─────────────────

export const STATEMENT_MAX_BYTES = 1024;
export const SIGNATURE_BYTES = 64;
export const PUBLIC_KEY_BYTES = 32;
export const CHALLENGE_BYTES = 32;
export const ISSUED_AT_MAX_BYTES = 32;
export const OBSERVED_UNIQUE_MAX = 2 ** 31 - 1;
/** Upper bound of one observation upload body, in UTF-8 bytes (32 KiB; R21). */
export const OBSERVATION_BODY_MAX_BYTES = 32 * 1024;
export const KEY_ID_PATTERN = /^[a-z0-9._-]{1,64}$/;
export const HEX64_PATTERN = /^[0-9a-f]{64}$/;
/** RFC 3339 UTC (`Z` only); calendar validity is checked separately in `parse.ts`. */
export const ISSUED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

// ── D-S10-1: the induction manifest ─────────────────────────────────────────────────────

export interface InductionVerifierV1 {
  readonly key_id: string;
  readonly alg: typeof VERIFIER_ALGORITHM;
  readonly public_key_b64: string;
}

/**
 * One source's induction manifest (`src/scout/induction/sources/<p>.json`). A verifier is a
 * trust anchor for statements issued by the SOURCE; custody is an external manifest-approval
 * fact set by governance (Q1/Q2), never inferred from the key or the signed bytes.
 */
export interface InductionManifestV1 {
  readonly manifestVersion: 1;
  readonly sourcePlatform: string;
  /** Sorted by code point, unique, non-empty; equals the mapping spec's `families` keys (V2). */
  readonly expectedFamilies: readonly CanonicalFamily[];
  /** Keys === `expectedFamilies`; an empty list means that family is never provable (V4). */
  readonly basisKinds: Readonly<Partial<Record<CanonicalFamily, readonly ProvingBasisKind[]>>>;
  readonly verifiers: readonly InductionVerifierV1[];
  readonly nativeRules: NativeRulesDeclaration;
}

export const MANIFEST_KEYS = [
  'manifestVersion',
  'sourcePlatform',
  'expectedFamilies',
  'basisKinds',
  'verifiers',
  'nativeRules',
] as const;
export const VERIFIER_KEYS = ['key_id', 'alg', 'public_key_b64'] as const;

// ── D-S10-2: the source statement and the uploaded evidence ─────────────────────────────

/** Strict canonical JSON, issued and signed by the source (Ed25519 over the decoded bytes). */
export interface SourceEnumerationStatementV1 {
  readonly statement_version: 1;
  readonly source_platform: string;
  readonly account_scope_id_digest: string;
  readonly family: CanonicalFamily;
  readonly challenge_b64: string;
  readonly snapshot_ref_digest: string;
  readonly date_window: null;
  readonly terminal: 'end_of_list';
  readonly observed_unique: number;
  readonly id_set_digest: string;
  readonly issued_at: string;
}

/** Exactly the statement keys, sorted by code point (the canonical order). */
export const STATEMENT_KEYS = [
  'account_scope_id_digest',
  'challenge_b64',
  'date_window',
  'family',
  'id_set_digest',
  'issued_at',
  'observed_unique',
  'snapshot_ref_digest',
  'source_platform',
  'statement_version',
  'terminal',
] as const;

/** What the client uploads, one per `(platform, scope, family)`. */
export interface ObservationEvidenceV1 {
  readonly evidence_version: 1;
  readonly source_platform: string;
  readonly account_scope_id_digest: string;
  readonly family: CanonicalFamily;
  readonly basis_kind: ProvingBasisKind;
  readonly mapping_spec_digest: string;
  readonly statement_b64: string;
  readonly key_id: string;
  readonly signature_b64: string;
}

export const EVIDENCE_KEYS = [
  'evidence_version',
  'source_platform',
  'account_scope_id_digest',
  'family',
  'basis_kind',
  'mapping_spec_digest',
  'statement_b64',
  'key_id',
  'signature_b64',
] as const;

/**
 * Why an artifact failed to parse. Diagnostic only (tests and S10-B's 400 path): the evaluator
 * never surfaces it — a failure shows only as `completeness_basis: 'none'` (D-S10-8).
 */
export type ArtifactRejection =
  | 'not_object'
  | 'unknown_key'
  | 'missing_key'
  | 'bad_version'
  | 'bad_platform'
  | 'bad_family'
  | 'bad_digest'
  | 'bad_count'
  | 'unknown_basis_kind'
  | 'bad_key_id'
  | 'bad_base64'
  | 'bad_length'
  | 'too_large'
  | 'non_canonical_json'
  | 'bad_issued_at'
  | 'bad_date_window'
  | 'bad_terminal';

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ArtifactRejection };
