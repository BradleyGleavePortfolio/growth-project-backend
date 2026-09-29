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
 *
 * L3 (owner D1, 2026-09-28; L0 r5 D-L0-6 "Per-family counting evidence is kept") appends
 * `replay_terminal_enumeration`: the extension-observed evidence. One evidence row per
 * `(platform, scope, family)` aggregates one `ReplayStepEvidenceV1` per collection step feeding
 * the family, plus the family's `observed_unique` and `id_set_digest`. The evaluator rule lives
 * in `verify.ts` (`proveReplayTerminalEnumeration`): every step verified against its own staged
 * rows, the family digest AND count equal to the staged side, every step positively exhausted
 * (`empty_page` / `absent_next` after ≥ 1 page, fan-out bound to its parent's verified id set)
 * ⇒ the family's SOURCE COUNT is `proven`; every step fetched but not all exhausted ⇒
 * `observed`; anything less ⇒ `unknown`, never 0.
 *
 * Executive reset 2026-09-29 §1/§8: NO package (file, learned, legacy) has a run-level
 * completeness closure until a separate closure record lands, so this kind never yields a
 * `CoverageFact` with `known: true` — it can prove a family's source count ("48 of 48"), never
 * the run's `complete`. `complete` stays reachable only through `source_signed_enumeration`
 * (test-only: S12-B2 refuses it outside dev/test). The kind stays in this enum (append-only) and
 * in `PROVING_BASIS_KINDS` because it proves the count; `familyCoverage` never sees it.
 */
export const COMPLETENESS_BASIS_KINDS = [
  'none',
  'source_signed_enumeration',
  'replay_terminal_enumeration',
] as const;
export type CompletenessBasisKind = (typeof COMPLETENESS_BASIS_KINDS)[number];

/** The kinds a manifest may list in `basisKinds` (D-S10-1 V4: every kind except `none`). */
export type ProvingBasisKind = Exclude<CompletenessBasisKind, 'none'>;
export const PROVING_BASIS_KINDS: readonly ProvingBasisKind[] = [
  'source_signed_enumeration',
  'replay_terminal_enumeration',
];

/**
 * The kinds whose evidence is verified against a manifest verifier (D-S10-1 V5: a manifest that
 * lists one of these for any family needs ≥ 1 verifier). `replay_terminal_enumeration` is an
 * observer statement bound to the run's declaration challenge and to the staged identity set,
 * never to a source key, so a learned package (derived manifest, `verifiers: []`) may list it.
 */
export const VERIFIER_BOUND_BASIS_KINDS: readonly ProvingBasisKind[] = [
  'source_signed_enumeration',
];

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
/**
 * L3 r2 (L0 r5 D-L0-6 "Evidence cardinality"): at most this many step evidences (steps,
 * `:s`/`:q` variants and probes) may feed one family in a replay evidence row.
 */
export const REPLAY_MAX_STEPS = 64;
/** L3 r2: the body bound for an observation body whose every entry is the replay kind (r5). */
export const REPLAY_OBSERVATION_BODY_MAX_BYTES = 64 * 1024;
/** L3: a replay step token is the mapping spec's own step key (UTF-8 bytes, bounded). */
export const REPLAY_STEP_TOKEN_MAX_BYTES = 256;
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

/** What the client uploads for `source_signed_enumeration`, one per `(platform, scope, family)`. */
export interface SourceSignedEvidenceV1 {
  readonly evidence_version: 1;
  readonly source_platform: string;
  readonly account_scope_id_digest: string;
  readonly family: CanonicalFamily;
  readonly basis_kind: 'source_signed_enumeration';
  readonly mapping_spec_digest: string;
  readonly statement_b64: string;
  readonly key_id: string;
  readonly signature_b64: string;
}

/** The `source_signed_enumeration` evidence keys (the S10-A shape, unchanged). */
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

// ── L3: `replay_terminal_enumeration` — the extension-observed evidence ───────────────────

/**
 * How one replay step stopped, as the engine reports it (L0 r5 D-L0-6 `StopReason`, verbatim).
 * Three classes, decided by `verify.ts`:
 * - `REPLAY_EXHAUSTED_STOPS` — positive exhaustion after ≥ 1 page: `empty_page` (page style: the
 *   page after the last one came back empty) and `absent_next` (cursor / `next_url` style: the
 *   next path resolved to null/absent). Only these can make a count `proven`.
 * - `REPLAY_OBSERVED_STOPS` — the list ended without positive proof: `short_page` (a page shorter
 *   than the page size; r5: "a short page is NOT proof") and `first_page_only` (a `style: 'none'`
 *   step, whose single page is never certified). The count is at most `observed`.
 * - `REPLAY_ABORTED_STOPS` — `budget`, `cycle`, `error`: the crawl did not finish; the count is
 *   `unknown`. `advertised_next` (a next link the step did not follow) is not exhausted either
 *   and, like `refused_pages > 0` or `advertised_next: true`, caps the family at `observed`.
 * The package carries no pagination style yet (L2b), so the server cannot check that a step of
 * page style reports `empty_page` rather than `absent_next`; both are positive terminals in r5,
 * and the engine (X2b) reports the one its style defines. Never a source-specific value.
 */
export const REPLAY_STEP_STOPS = [
  'absent_next',
  'empty_page',
  'short_page',
  'first_page_only',
  'budget',
  'cycle',
  'error',
  'advertised_next',
] as const;
export type ReplayStepStop = (typeof REPLAY_STEP_STOPS)[number];
export const REPLAY_EXHAUSTED_STOPS: readonly ReplayStepStop[] = ['absent_next', 'empty_page'];
export const REPLAY_OBSERVED_STOPS: readonly ReplayStepStop[] = ['short_page', 'first_page_only'];
export const REPLAY_ABORTED_STOPS: readonly ReplayStepStop[] = ['budget', 'cycle', 'error'];

/**
 * The parent contexts a fan-out step visited (L0 r5 D-L0-6 "Fan-out"). The evaluator binds the
 * claim to the PARENT STEP'S VERIFIED ID SET, never to the step's own numbers:
 * `parent_ids_digest` must equal the parent step's `id_set_digest` (itself verified against the
 * staged rows of that step) and `contexts_expected` its `distinct_raw_ids`; the parent must be
 * another step of this platform whose chain of parents ends in a root step (no self-parent, no
 * cycle). `parent_ids_digest` is the D-S10-2 digest of the DISTINCT parent identities the step
 * actually fetched a context for — visiting parent A twice and omitting B digests to a different
 * set and never proves. The fan-out is exhausted only when `contexts_exhausted ===
 * contexts_fetched === contexts_expected` with every context positively exhausted;
 * `pages_fetched` on the step is the page total across contexts (≥ `contexts_fetched`; a context
 * may take several pages). `contexts_expected: 0` proves only against a parent that verified
 * empty. `parent_step` names the parent step (additive to r5's shape: the pinned package carries
 * no `forEach`/`parentEdge` yet; when L2b's pin does, the evaluator must also require equality
 * with it). Additive fields only; nothing here is a URL or an id.
 */
export interface ReplayFanOutV1 {
  readonly parent_step: string;
  readonly parent_ids_digest: string;
  readonly contexts_expected: number;
  readonly contexts_fetched: number;
  readonly contexts_exhausted: number;
}
export const REPLAY_FAN_OUT_KEYS = [
  'parent_step',
  'parent_ids_digest',
  'contexts_expected',
  'contexts_fetched',
  'contexts_exhausted',
] as const;

/**
 * One step evidence of the pinned package that feeds the family (L0 r5 D-L0-6 `StepEvidenceV1`,
 * snake_case on the wire like the rest of the row): a mapped step, a `:s`/`:q` variant or a probe.
 *
 * Identity scope (r5 D-L0-6 "Identity", D-L0-4 C0): `distinct_raw_ids`, `duplicate_ids` and
 * `id_set_digest` are computed over the step's STAGED IDENTITY — the exact `sourceId` string the
 * engine stages: the raw `idField` value under `idScope: 'global'`, the composed
 * `${parentId}:${id}` under `idScope: 'parent'`. The server verifies every step's digest and
 * count against the staged rows of that step (`StagedPlatformFacts.steps`), so a raw digest for
 * a parent-scoped step, or two parents' children collapsed on a shared raw id, never verifies.
 */
export interface ReplayStepEvidenceV1 {
  /** The mapping spec's step key (or the family token when the spec maps no step to the family). */
  readonly step_key: string;
  /**
   * Pages fetched by this step. A root step (`fan_out: null`) must have fetched ≥ 1 page (the
   * parser refuses 0): a crawl that fetched nothing observed no terminal, so an empty collection
   * is proven only by a positive GET (unknown is never 0). For a fan-out step, the total across
   * its contexts (≥ `contexts_fetched`).
   */
  readonly pages_fetched: number;
  /** Items the pages held, before identity. */
  readonly raw_items: number;
  /** Distinct staged identities among them (never a synthetic id). */
  readonly distinct_raw_ids: number;
  /** Items whose identity repeated an earlier one. */
  readonly duplicate_ids: number;
  /** Items given a synthetic positional id; must be 0 (a fabricated identity never counts). */
  readonly synthetic_ids: number;
  /** Items without an id; must be 0. */
  readonly missing_id_items: number;
  readonly stop: ReplayStepStop;
  /** A next link/cursor the last page advertised and the step did not follow; caps at observed. */
  readonly advertised_next: boolean;
  /** Pages the source refused (non-2xx, timeout after retries); > 0 caps at observed. */
  readonly refused_pages: number;
  /** `null` for a root collection; the parent-bound context claim for a fan-out step. */
  readonly fan_out: ReplayFanOutV1 | null;
  /** The D-S10-2 identity-set digest of this step's distinct staged identities. */
  readonly id_set_digest: string;
}
export const REPLAY_STEP_KEYS = [
  'step_key',
  'pages_fetched',
  'raw_items',
  'distinct_raw_ids',
  'duplicate_ids',
  'synthetic_ids',
  'missing_id_items',
  'stop',
  'advertised_next',
  'refused_pages',
  'fan_out',
  'id_set_digest',
] as const;

/**
 * What the extension uploads for `replay_terminal_enumeration`, one per `(platform, scope,
 * family)` (r5: no schema or unique-key change; the row aggregates the family's step evidences).
 * Digests, counts and step terminals only: no URL, no source id, no free text. The server binds
 * it to the run through `challenge_b64` (the declaration challenge) and the row's
 * coach/intent/epoch, and proves it only against the staged identity digest (E6).
 */
export interface ReplayTerminalEvidenceV1 {
  readonly evidence_version: 1;
  readonly source_platform: string;
  readonly account_scope_id_digest: string;
  readonly family: CanonicalFamily;
  readonly basis_kind: 'replay_terminal_enumeration';
  readonly mapping_spec_digest: string;
  readonly challenge_b64: string;
  readonly steps: readonly ReplayStepEvidenceV1[];
  /** Distinct ids over the union of the steps' id sets. */
  readonly observed_unique: number;
  /** The D-S10-2 digest of that union. */
  readonly id_set_digest: string;
}
export const REPLAY_EVIDENCE_KEYS = [
  'evidence_version',
  'source_platform',
  'account_scope_id_digest',
  'family',
  'basis_kind',
  'mapping_spec_digest',
  'challenge_b64',
  'steps',
  'observed_unique',
  'id_set_digest',
] as const;

/** Every evidence shape the observation route stores (discriminated by `basis_kind`). */
export type ObservationEvidenceV1 = SourceSignedEvidenceV1 | ReplayTerminalEvidenceV1;

// ── L3 r2: per-family coverage detail (executive reset 2026-09-29 §1, §6, §8) ────────────

/**
 * How a family's SOURCE COUNT was established (L0 r5 D-L0-6 "Family count basis", consumed by
 * D-L0-6.3 `FamilyRowV1.count_basis`). `'proven'`: every step feeding the family on every declared
 * platform is positively exhausted, every step's digest and count equal its staged rows, the
 * family's union digest and count equal the staged side (E6) and the step set is exactly the
 * pinned one. `'observed'`: every feeding step fetched ≥ 1 page (or had no context to visit),
 * verified the same way, with no `budget`/`cycle`/`error` stop, but at least one step is not
 * positively exhausted (a short or first page, an advertised next link, a refused page, a
 * fan-out short of its contexts) — the count is what the lists returned, not their end.
 * `'unknown'`: anything less; no count is shown (`source_count: null`, never 0).
 */
export const FAMILY_COUNT_BASES = ['proven', 'observed', 'unknown'] as const;
export type FamilyCountBasis = (typeof FAMILY_COUNT_BASES)[number];

/**
 * L3 r2: why a family is not a run-level completeness basis (`known: false`), or why its source
 * count is unknown. Closed, append-only, counts only — no source id, URL, token or free text (an
 * A1 value path). `evaluateCoverageDetailed()` returns them per family so the ONE run-status
 * projection (executive reset 2026-09-29 §6: `families[]`/`not_moved[]`/`gaps[]`, slice L2) can
 * consume them; nothing here is persisted or shown yet (see the L3 record §5).
 */
export const COVERAGE_REASON_CODES = [
  /** No run declaration, or a malformed one (E1). */
  'declaration_missing',
  /** The platform has no induction package in the settling registry (E1). */
  'package_missing',
  /** S9-B grouped the platform against a family set the package does not declare (E6). */
  'partition_disagreement',
  /** More than one account scope was declared for the platform (multi-scope attribution deferred). */
  'multi_scope',
  /**
   * The family's source count is proven by observed (replay) evidence, but no completeness-closure
   * record exists for any package yet (executive reset 2026-09-29 §1): the count is known, the
   * run-level basis is not. Always present on such a family; never on a source-signed one.
   */
  'completeness_not_proven',
  /** The staged platform was never declared for this run (E1). */
  'platform_undeclared',
  /** No evidence row for the unit (E2). Unknown, never 0. */
  'evidence_missing',
  /** More than one evidence row for the unit (E2). */
  'evidence_duplicate',
  /** A row that does not parse poisons its unit (or, nameless, every unit). */
  'evidence_malformed',
  /** The row binds to another run, package, kind, scope, challenge or spec digest (E3). */
  'evidence_unbound',
  /** The source signature or verifier failed, or the statement is outside the run window (E4). */
  'signature_unverified',
  /** The reported replay step set differs from the pinned spec's steps for the family. */
  'step_set_mismatch',
  /** A replay step stopped at budget, a refused page, retry exhaustion or an abort. */
  'crawl_truncated',
  /** A root replay step fetched zero pages: no terminal was observed (unknown, never 0). */
  'zero_pages_fetched',
  /** A replay step counted a synthetic or missing id: a fabricated identity never proves. */
  'identity_unproven',
  /** A replay row's step counters or digests contradict its family totals. */
  'evidence_inconsistent',
  /**
   * A fan-out step's context counters contradict each other or its pages (`contexts_fetched` >
   * `contexts_expected`, `contexts_exhausted` > `contexts_fetched`, or fewer pages than contexts).
   */
  'fan_out_short',
  /** A fan-out step's parent step is not a verified step of this platform (or its family failed). */
  'fan_out_parent_unproven',
  /** A fan-out step's `contexts_expected` does not equal the parent step's verified `distinct_raw_ids`. */
  'fan_out_count_mismatch',
  /** The staged side has no digest for the family (S9-B could not digest it). */
  'staged_digest_missing',
  /** The evidence digest or count does not equal the staged identity set (E6). */
  'staged_mismatch',
  /** Two basis kinds proved one family: no single truthful `basis_kind`. */
  'basis_kind_conflict',
  /** The evaluator hit an unexpected failure and answered unknown for every family. */
  'evaluator_failure',
  /**
   * L3 r3 (L0 r5 D-L0-6.3 `GapCode` of the same name): a feeding step is not positively exhausted
   * (short/first page, advertised next link, refused page, fan-out short of its contexts); the
   * count is `observed`, never `proven`.
   */
  'list_not_exhausted',
  /** A fan-out step's `parent_ids_digest` is not the parent step's verified `id_set_digest`. */
  'fan_out_parent_mismatch',
  /** A fan-out step's parent chain does not end in a root step (self-parent or cycle). */
  'fan_out_cycle',
  /** A replay step's `id_set_digest` or `distinct_raw_ids` differs from the staged rows of that step. */
  'step_staged_mismatch',
] as const;
export type CoverageReasonCode = (typeof COVERAGE_REASON_CODES)[number];

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
  | 'bad_terminal'
  | 'bad_step';

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ArtifactRejection };
