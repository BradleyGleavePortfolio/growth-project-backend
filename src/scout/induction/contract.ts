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
 * L3 (owner D1, 2026-09-28; L0 D-L0-6 "How a learned source earns a basis") appends
 * `replay_terminal_enumeration`: the extension-observed basis. One evidence row per
 * `(platform, scope, family)` states that every collection step feeding the family reached the
 * replay engine's pagination terminal under budget with zero refused pages, plus the family's
 * `observed_unique` and `id_set_digest`. The evaluator rule lives in `verify.ts`
 * (`proveReplayTerminalEnumeration`): digest AND count equal to the staged side ⇒ `known: true`;
 * any budget stop, refused page, retry exhaustion, fan-out short of its id set, a step set short
 * of the spec's, or a digest/count mismatch ⇒ `known: false`.
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
/** L3: at most this many collection steps may feed one family in a replay evidence row. */
export const REPLAY_MAX_STEPS = 16;
/** L3: a replay step token is the mapping spec's own step key (UTF-8 bytes, bounded). */
export const REPLAY_STEP_TOKEN_MAX_BYTES = 256;
/**
 * L3: an opaque template reference inside a family-set closure record (a digest ref, never a
 * URL, host or path: no `/`, `:` or `?` can appear).
 */
export const CLOSURE_TEMPLATE_REF_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** L3: at most this many observed collection templates in one closure record. */
export const CLOSURE_MAX_TEMPLATES = 256;
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
 * How one replay collection step stopped, as the engine reports it. Only `short_page` (a page
 * shorter than the page size) and `absent_next` (no next-page link/cursor) are pagination
 * terminals; every other stop is a truncated crawl and never proves.
 */
export const REPLAY_STEP_STOPS = [
  'short_page',
  'absent_next',
  'budget_stop',
  'refused_page',
  'retry_exhausted',
  'aborted',
] as const;
export type ReplayStepStop = (typeof REPLAY_STEP_STOPS)[number];
export const REPLAY_TERMINAL_STOPS: readonly ReplayStepStop[] = ['short_page', 'absent_next'];

/** The pages a fan-out step had to visit (its parent id set) against the pages it fetched. */
export interface ReplayFanOutV1 {
  readonly expected: number;
  readonly fetched: number;
}
export const REPLAY_FAN_OUT_KEYS = ['expected', 'fetched'] as const;

/** One collection step of the pinned mapping spec that feeds the family, and how it ended. */
export interface ReplayStepTerminalV1 {
  /** The mapping spec's step key (or the family token for a canonical-token collection). */
  readonly step: string;
  readonly stop: ReplayStepStop;
  /** Pages fetched by this step; must stay below `max_pages` (a step at its budget never proves). */
  readonly pages_fetched: number;
  /** The `maxPagesPerStep` budget in force for this step (≥ 1). */
  readonly max_pages: number;
  /** Pages the source refused (non-2xx, timeout after retries); must be 0. */
  readonly refused_pages: number;
  /** `null` for a root collection; a fan-out step must have fetched every expected page. */
  readonly fan_out: ReplayFanOutV1 | null;
}
export const REPLAY_STEP_KEYS = [
  'step',
  'stop',
  'pages_fetched',
  'max_pages',
  'refused_pages',
  'fan_out',
] as const;

/**
 * What the extension uploads for `replay_terminal_enumeration`, one per `(platform, scope,
 * family)`. Digests, counts and step terminals only: no URL, no source id, no free text. The
 * server binds it to the run through `challenge_b64` (the declaration challenge) and the row's
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
  readonly steps: readonly ReplayStepTerminalV1[];
  readonly observed_unique: number;
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

// ── L3: family-set closure (owner D1; L0 D-L0-6.1 (i)) ────────────────────────────────────

/**
 * Why a learned package left an observed collection template unmapped. Closed enum (the L1
 * proposal's `unmapped[].reason`). Only the three `out_of_scope_*` reasons can ever count toward
 * closure, and only when the deterministic structural rule confirmed them; the AI's
 * classification alone never permits `complete`.
 */
export const CLOSURE_EXCLUSION_REASONS = [
  'out_of_scope_billing',
  'out_of_scope_account_settings',
  'out_of_scope_ui_config',
  'unsupported_coaching_data',
  'unknown',
] as const;
export type ClosureExclusionReason = (typeof CLOSURE_EXCLUSION_REASONS)[number];
export const CLOSURE_CONFIRMABLE_REASONS: readonly ClosureExclusionReason[] = [
  'out_of_scope_billing',
  'out_of_scope_account_settings',
  'out_of_scope_ui_config',
];

/**
 * The structure-only signals the deterministic exclusion rule (L0 D-L0-6.1 (i)
 * `confirmExclusion`, owned by the learn slice) computed for one excluded template. Stored as
 * signals, never as a verdict: the closure evaluator re-derives "confirmed" from them on every
 * run, so a rule reading is never frozen into a package. `path`/`key`/`shape` are the P/K/S
 * classes; `veto` is true when coaching vocabulary appears in the path tokens OR the item key
 * tokens, or an `email_like`/`phone_like` key exists; `empty_shape` is true when the collection
 * exposed no item shape (an empty collection can never be confirmed out of scope).
 */
export interface ExclusionSignalsV1 {
  readonly path: boolean;
  readonly key: boolean;
  readonly shape: boolean;
  readonly veto: boolean;
  readonly empty_shape: boolean;
}
export const EXCLUSION_SIGNAL_KEYS = ['path', 'key', 'shape', 'veto', 'empty_shape'] as const;

/** One observed collection template of the pinned package and what became of it. */
export type FamilySetClosureTemplateV1 =
  | {
      readonly template_ref: string;
      readonly disposition: 'mapped';
      readonly family: CanonicalFamily;
      /**
       * Distinct values seen on a non-pagination query key of this template that the replay did
       * not enumerate (e.g. an archived-status list). A COUNT only, never the values. Must be 0
       * for the template to close.
       */
      readonly unexplored_variants: number;
    }
  | {
      readonly template_ref: string;
      readonly disposition: 'excluded';
      readonly reason: ClosureExclusionReason;
      readonly signals: ExclusionSignalsV1;
    };
export const CLOSURE_MAPPED_TEMPLATE_KEYS = [
  'template_ref',
  'disposition',
  'family',
  'unexplored_variants',
] as const;
export const CLOSURE_EXCLUDED_TEMPLATE_KEYS = [
  'template_ref',
  'disposition',
  'reason',
  'signals',
] as const;

/**
 * The pinned package's closure record. `reviewed_package`: a repository (file) package whose
 * family set is fixed by reviewed data and has no observed template inventory.
 * `observed_templates`: a learned package (L1/L2), whose every observed collection template must
 * be mapped or confirmed out of scope AND whose discovery left nothing behind: no truncated
 * digest, no refused or withheld collection template, no unexplored navigation target. A missing
 * record (`null`) is NOT known and blocks `complete`.
 */
export type FamilySetClosureV1 =
  | {
      readonly closure_version: 1;
      readonly source_platform: string;
      /** Binds the record to the loaded package (must equal the package's `specDigest`). */
      readonly mapping_spec_digest: string;
      readonly origin: 'reviewed_package';
    }
  | {
      readonly closure_version: 1;
      readonly source_platform: string;
      readonly mapping_spec_digest: string;
      readonly origin: 'observed_templates';
      /** Version of the exclusion-rule token table the signals were computed with. */
      readonly rule_version: 1;
      /** The structure digest dropped templates at its bound (any drop blocks `complete`). */
      readonly digest_truncated: boolean;
      /** Collection-shaped templates refused or withheld from the digest (count only). */
      readonly refused_collections: number;
      /** Navigation targets discovery found but never visited (count only). */
      readonly unexplored_targets: number;
      readonly templates: readonly FamilySetClosureTemplateV1[];
    };
export const CLOSURE_OBSERVED_KEYS = [
  'closure_version',
  'source_platform',
  'mapping_spec_digest',
  'origin',
  'rule_version',
  'digest_truncated',
  'refused_collections',
  'unexplored_targets',
  'templates',
] as const;
export const CLOSURE_REVIEWED_KEYS = [
  'closure_version',
  'source_platform',
  'mapping_spec_digest',
  'origin',
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
  | 'bad_terminal'
  | 'bad_step';

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ArtifactRejection };
