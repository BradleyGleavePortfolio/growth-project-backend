import type { ArbiterInput, ReconciliationVerdict } from '../lifecycle/arbiter';
import type { RunReasonCode, ServerTerminalStatus } from '../lifecycle/reason-codes';

// S9-A — types of the pure reconciler (`reconcile.ts`) and the F1 coverage predicate
// (`coverage.ts`), following the S9 decision doc `docs/decisions/2026-09-25-s9-reconciliation.md`
// (D-S9-1 … D-S9-7) on top of the accepted S7-L lifecycle contract (`2026-09-24-s7l-run-lifecycle.md`
// §8 "S9") and S8 native contract (`2026-09-24-s8-native-contract.md` §3.2, §3.5, §3.7, §3.8).
//
// S9 computes; it never writes `terminal_status`, `completed_at`, `reason_code`, ledger,
// provenance or native rows, and never fences (D-S9-1). Facts arrive pre-collected (S9-B) and are
// consumed only through the fact types below. Nothing here imports the S8-C writer modules: the
// persist-outcome and provenance vocabularies are mirrored as literals frozen by the accepted
// contract (S8-DOC §3.2 outcomes, §3.7 codes, S8-B `target_kind` / `native_kind` CHECKs), so
// S9-A compiles at the landed S7-L head `df713fd9` and freezes to the S9-0 text once it lands.

// ── Reason codes (D-S9-7, run level) ────────────────────────────────────────────────────

/**
 * The run-level codes a reconciliation verdict may carry. `unresolved_family` is the existing
 * D-S7L-5 code, reused unchanged; the other three are appended to `RUN_REASON_CODES` by S9-C
 * (additive entries only). This object is their single spelling: renaming one — for example if
 * the landed S9-0 text fixes another name for the F1 code — is a one-line change here.
 */
/** The extension's stored `/complete` claim as the arbiter reads it (`success|partial|failed|null`). */
export type ClaimStatus = ArbiterInput['claim'];

export const S9_REASON_CODE = {
  /** C-FAM: an unmapped entry, or a mapped family with no native destination (PLAN L307). */
  unresolved_family: 'unresolved_family',
  /** C-ID: a staged identity in a mapped family is not natively present and verified, or a child is unresolved. */
  unresolved_identities: 'unresolved_identities',
  /** C-REL: a required parent link, soft link or child order failed closure (S8-DOC §3.8). */
  relationship_unverified: 'relationship_unverified',
  /** C-COV: a family lacks a recorded completeness basis, or the stored claim is not `success` (F1). */
  coverage_basis_unknown: 'coverage_basis_unknown',
} as const;
export type S9ReasonCode = (typeof S9_REASON_CODE)[keyof typeof S9_REASON_CODE];

/** D-S9-2 condition order: C-FAM, C-ID, C-REL, C-COV. `reason_code` is the first that holds. */
export const S9_REASON_CODES: readonly S9ReasonCode[] = [
  S9_REASON_CODE.unresolved_family,
  S9_REASON_CODE.unresolved_identities,
  S9_REASON_CODE.relationship_unverified,
  S9_REASON_CODE.coverage_basis_unknown,
];

/**
 * `RunReasonCode` is the S7-L closed list. After S9-C appends the three S9 codes, every
 * `S9ReasonCode` is a `RunReasonCode` and a v1 verdict is an S7-L `ReconciliationVerdict`
 * verbatim; until then this union names the widened set.
 */
export type ReconciliationReasonCode = RunReasonCode | S9ReasonCode;

// ── Verdict (D-S9-1 outcome set) ────────────────────────────────────────────────────────

/**
 * S9 emits only `complete` or `partial`. `blocked` comes only from the `revoked` fence (D-S9-6),
 * `cancelled`/`timed_out` only from fences and `failed` only from arbiter step 2.
 */
export type ReconciliationOutcome = Extract<ServerTerminalStatus, 'complete' | 'partial'>;

/** S9's output for arbiter step 3; see `ReconciliationReasonCode` for the S7-L seam. */
export interface ReconciliationVerdictV1 {
  outcome: ReconciliationOutcome;
  reason_code: S9ReasonCode | null;
}

/** The S7-L seam type, re-exported so S9-C wires `reconciliation:` from one import path. */
export type { ReconciliationVerdict };

// ── Frozen vocabularies mirrored from the accepted contracts (never imported) ───────────

/** Ledger `status` (`RECONSTRUCT_STATUS`; N/Q1 invariant 6). */
export type LedgerStatus = 'reconstructed' | 'skipped' | 'failed';

/**
 * S8-B `ScoutReconstructionLedger.target_kind` closed CHECK; `null` = legacy writer (never
 * reinterpreted). Only `person`, `workout_program` and `workout_plan` are native kinds;
 * `scout_entity` is evidence and never counts native (S8-DOC §3.2).
 */
export type LedgerTargetKind = 'person' | 'scout_entity' | 'workout_program' | 'workout_plan';
export type NativeTargetKind = Exclude<LedgerTargetKind, 'scout_entity'>;
export const NATIVE_TARGET_KINDS: readonly NativeTargetKind[] = [
  'person',
  'workout_program',
  'workout_plan',
];

/** S8-B `ImportNativeProvenance.outcome` closed CHECK (S8-DOC §3.2). */
export type ProvenanceOutcome = 'created' | 'already_present' | 'unresolved';

/**
 * S9-B's verification of the native row a provenance record points at (S8-DOC §3.5 rows 1–3;
 * D-S9-2 buckets h–j). `present_owned` is the only value that counts native.
 *  - `removed`             → the coach archived or deleted the row (bucket i)
 *  - `foreign_owner`       → the row belongs to another coach (bucket h)
 *  - `kind_mismatch`       → the row is not of the provenance's kind (bucket h)
 *  - `provenance_mismatch` → provenance `native_kind`/`native_id` differ from the ledger target (bucket h)
 */
export type NativeTargetCheck =
  'present_owned' | 'removed' | 'foreign_owner' | 'kind_mismatch' | 'provenance_mismatch';

// ── Facts (input) ───────────────────────────────────────────────────────────────────────

/** The D-S8-3 provenance record of a reconstructed identity plus its native verification. */
export interface ProvenanceFacts {
  readonly outcome: ProvenanceOutcome;
  readonly native: NativeTargetCheck;
  /**
   * The provenance row's §3.7 reason when `outcome` is `unresolved` (S8-C writes a top-level
   * unresolved provenance row for a client-linked evidence row; review C-4), else `null`.
   */
  readonly reason: string | null;
  /**
   * `unresolved` child provenance rows under this parent, as a reason → count histogram over
   * S8-DOC §3.7 child codes (for example `unresolved:exercise_reference`). Children are never
   * ledger rows (§3.3) and never enter the staged partition.
   */
  readonly unresolved_children: Readonly<Record<string, number>>;
}

/**
 * The intent's ledger row for one staged identity. `reason` is the writer's string in the
 * accepted grammar: `unresolved:<code>[:<qualifier>]`, `unresolved_family:<token>`, or a
 * rejection reason (`unsupported_platform:<token>`, `missing_source_id`). It is echoed into the
 * histogram only when it parses in the closed catalogue (D-S9-7), never verbatim otherwise.
 */
export type LedgerRowFacts =
  | { readonly status: 'failed' }
  | { readonly status: 'skipped'; readonly reason: string | null }
  | {
      readonly status: 'reconstructed';
      readonly target_kind: LedgerTargetKind | null;
      /** `null` when no provenance row exists for the identity (bucket g). */
      readonly provenance: ProvenanceFacts | null;
    };

/** One distinct staged identity `(source_platform, source_id)` of a family. */
export interface IdentityFacts {
  /** The staged `entity_type` token this identity arrived under (the `families[]` key, S7L-DOC §5). */
  readonly token: string;
  /**
   * Opaque identity built by S9-B (never a name or email). It resolves relationship targets and
   * is never copied into the report.
   */
  readonly identity: string;
  /** The intent's ledger row, or `null` when staging has the identity and the ledger does not. */
  readonly ledger: LedgerRowFacts | null;
  /**
   * The staged row carries a resolved client link (`client_source_id`, S8-DOC L320-323, read
   * through the S8-A interpreter). Bucket f keys such a row `no_native_client_principal` (L149).
   */
  readonly client_linked: boolean;
}

/** Family-level qualifiers the report carries verbatim (S8-DOC §4.1 `roster_bridge_pending`). */
export type FamilyQualifier = 'roster_bridge_pending';

/**
 * Everything the reconciler knows about one entry: a canonical family (grouped through the
 * accepted `resolveStagedFamily`) or, when `mapped` is false, an unmapped staged token.
 * `family` is a string rather than `CanonicalFamily` because the S8-C `programs` family is not
 * in the landed allow-list at this base and S9 never branches on a family name.
 */
export interface FamilyFacts {
  readonly family: string;
  readonly mapped: boolean;
  /** For an unmapped entry, the resolution failure (`unresolved_family:<token>` or `unsupported_platform:<p>`). */
  readonly resolution_reason: string | null;
  /** Client-owned under the D-S8-2 interim: evidence rows report `no_native_client_principal`. */
  readonly client_owned: boolean;
  /** The pass refused this family at `RECONSTRUCT_MAX_ROWS` (D-S9-6): missing ledger rows are the ceiling remainder. */
  readonly ceiling_exceeded: boolean;
  /** Every distinct staged identity. Its length is `staged_unique`. */
  readonly identities: readonly IdentityFacts[];
  /**
   * Ledger rows of this intent attributed to this family with no staged identity (a
   * contradiction; R05). The run-wide count lives on `ReconciliationFacts`.
   */
  readonly ledger_without_staged: number;
  readonly qualifiers: readonly FamilyQualifier[];
}

/**
 * Closure edges S9 validates (D-S9-2 E-R1..E-R3). Parents are always read through provenance on
 * the D-S8-3 key, never by name, email or label.
 *  - `program_parent` (E-R1): a program-day plan's `program_id` and `(week_index, day_index)`
 *  - `child_order`    (E-R2): a created child's `workout_plan_id` and `#ord:` order
 *  - `client_link`    (E-R3): a `client_source_id` soft link on a counted identity
 */
export type RelationshipEdge = 'program_parent' | 'child_order' | 'client_link';

/**
 * One declared edge. The reconciler resolves `to_identity` inside `to_family` itself;
 * `consistent` is S9-B's data-level comparison of the native attributes (`null` = not compared,
 * which is never read as consistent for E-R1/E-R2; E-R3 has no attribute to compare).
 */
export interface RelationshipFacts {
  readonly edge: RelationshipEdge;
  readonly from_family: string;
  readonly from_identity: string;
  readonly to_family: string;
  readonly to_identity: string;
  readonly consistent: boolean | null;
}

/**
 * D-S9-3: the per-family completeness basis. `known: false` until S10 supplies an observation
 * contract. S10 extends the `known: true` branch additively; `coverage.ts` is the only reader.
 */
export type CoverageFact =
  | { readonly known: false }
  | {
      readonly known: true;
      /** S10's closed basis kind token (append-only enum owned by S10); reported as `completeness_basis`. */
      readonly basis_kind: string;
      readonly observed_unique: number;
      /** An identity-set statement established by S10, not a count comparison. */
      readonly covers_staged_identities: boolean;
    };

/** The complete, pre-collected fact set for one settled server run. */
export interface ReconciliationFacts {
  /** The extension's stored `/complete` claim (S7L-DOC D-S7L-2); a non-`success` claim is a signal against coverage. */
  readonly claim: ClaimStatus;
  readonly families: readonly FamilyFacts[];
  readonly relationships: readonly RelationshipFacts[];
  /**
   * Every canonical family the mapping spec of each staged, registered `source_platform`
   * declares (D-S9-2 required families; `mapping-spec.ts` `families` keys). `null` when the set
   * cannot be determined: no staged row names a registered platform (zero staged rows, or only
   * `unsupported_platform` rows). A declared family with no staged row gets a report entry with
   * `staged_unique: 0` and still needs a known basis before `complete`.
   */
  readonly spec_families: readonly string[] | null;
  /**
   * Run-wide: every ledger row of this intent with no staged identity, whether or not its token
   * or platform resolves (review C-2). Never below the sum of the per-family attributions.
   */
  readonly ledger_without_staged: number;
  /** Keyed by canonical family; `null` in v1 (S9-B always passes `null` until S10). */
  readonly coverage: Readonly<Record<string, CoverageFact>> | null;
}

// ── Report v1 (D-S9-5; also the CQ-13 coverage manifest v1) ──────────────────────────────

export interface ReasonCount {
  readonly code: string;
  readonly count: number;
}

/** Per staged token inside a canonical family (several tokens may share one family, D-S8-1). */
export interface TokenReportV1 {
  readonly token: string;
  readonly staged_unique: number;
  readonly native_present_verified: number;
  readonly rejected: number;
  readonly unresolved: number;
  readonly failed: number;
}

export type RelationshipClosure = 'verified' | 'unverified' | 'not_applicable';

/** `completeness_basis` when no basis is recorded (D-S9-3 `COMPLETENESS_BASIS_KINDS = ['none']` in v1). */
export const COMPLETENESS_BASIS_NONE = 'none';

export interface ReconciliationFamilyV1 {
  /** Canonical family, or the staged token for an unmapped entry. */
  readonly family: string;
  readonly mapped: boolean;
  readonly tokens: readonly TokenReportV1[];
  readonly staged_unique: number;
  /** D-S9-4: the verified union of `created` and `already_present` (bucket j). */
  readonly native_present_verified: number;
  /** D-S9-4: the per-run split is "not yet known" — `null`, never 0, never estimated. */
  readonly created_native: null;
  readonly already_present_verified: null;
  readonly rejected: number;
  readonly unresolved: number;
  readonly failed: number;
  readonly ledger_without_staged: number;
  readonly unresolved_children: number;
  readonly relationship_closure: RelationshipClosure;
  /** Bucket-j identities with at least one failing closure edge. */
  readonly relationship_unverified: number;
  /** D-S9-7 keys over the staged partition, sorted by code. */
  readonly reasons: readonly ReasonCount[];
  /** S8-DOC §3.7 child codes over `unresolved_children`, sorted by code. */
  readonly child_reasons: readonly ReasonCount[];
  readonly qualifiers: readonly FamilyQualifier[];
  // CQ-13 coverage-manifest fields (D-S9-3)
  /** `'none'` without a basis; otherwise S10's basis kind. */
  readonly completeness_basis: string;
  /** From a known basis; `null` = not observed (S7L-DOC §5 null-never-0 rule). */
  readonly observed_unique: number | null;
  readonly pagination_terminal_evidence: null;
  readonly date_window: null;
  readonly media_policy: null;
}

export interface ReconciliationReportV1 {
  readonly report_version: 1;
  readonly basis: 'recomputed';
  /** Every D-S9-2 condition that holds, in order; `[]` iff the verdict is `complete`. */
  readonly conditions: readonly S9ReasonCode[];
  /**
   * D-S9-2 `required_families`, sorted; `null` when undeterminable (then C-COV holds). Lets a
   * reader see which families the `complete` bar was measured against.
   */
  readonly required_families: readonly string[] | null;
  /** Run-wide ledger rows without a staged identity (C-ID input; outside every partition). */
  readonly ledger_without_staged: number;
  /**
   * Sorted by (`mapped` desc, `family`). Includes a zero-row entry for every required family
   * without a staged entry. The DTO projection (S9-C) exposes these fields as optional
   * properties, absent when no report applies (R-B1 option i); inside a report they are always
   * present.
   */
  readonly families: readonly ReconciliationFamilyV1[];
}

export interface ReconciliationResult {
  readonly verdict: ReconciliationVerdictV1;
  readonly report: ReconciliationReportV1;
}

// ── Histogram catalogue (D-S9-7, report level) ──────────────────────────────────────────

/** Keys the reconciler itself mints for conditions no writer records (D-S9-7 additions). */
export const S9_REPORT_CODE = {
  /** Bucket b: mapped family, no ledger row for this intent. */
  not_reconstructed: 'unresolved:not_reconstructed',
  /** Bucket b when the family is marked over `RECONSTRUCT_MAX_ROWS` (D-S9-6). */
  pass_ceiling_exceeded: 'unresolved:pass_ceiling_exceeded',
  /** Bucket g: native kind in the ledger but no provenance row. */
  provenance_missing: 'unresolved:provenance_missing',
  /** Bucket f: `target_kind` NULL or `scout_entity` in a coach-owned family. */
  evidence_only: 'unresolved:evidence_only',
  /** A ledger reason outside the closed grammar; the text is never echoed. */
  reason_unrecognised: 'unresolved:reason_unrecognised',
  /** Bucket c: ledger `failed`; the ledger reason text is never echoed. */
  failed: 'failed',
} as const;

/** S8-DOC §3.7 writer codes the reconciler assigns itself (buckets f, h, i). */
export const WRITER_CODE = {
  no_native_client_principal: 'unresolved:no_native_client_principal',
  native_target_removed: 'unresolved:native_target_removed',
  identity_conflict: 'unresolved:identity_conflict',
  /** Prefix of the C-FAM trigger for a mapped family without a native destination. */
  no_native_destination_prefix: 'unresolved:no_native_destination:',
} as const;

/**
 * The closed S8-DOC §3.7 `unresolved:<code>[:<qualifier>]` catalogue: code → whether a
 * qualifier is required (`qualified`) or forbidden (`bare`). A reason that does not parse here
 * is counted `unresolved:reason_unrecognised` and never echoed (D-S9-7 key rules).
 */
export const UNRESOLVED_CATALOGUE: Readonly<Record<string, 'qualified' | 'bare'>> = {
  no_native_client_principal: 'bare',
  no_native_destination: 'qualified',
  missing_required_field: 'qualified',
  invalid_value: 'qualified',
  enum_unmapped: 'qualified',
  unit_unknown: 'qualified',
  date_zone_unknown: 'qualified',
  prescription_not_integral: 'qualified',
  exercise_reference: 'bare',
  relationship_pending: 'qualified',
  relationship_missing: 'qualified',
  native_target_removed: 'bare',
  identity_conflict: 'bare',
  native_uniqueness: 'qualified',
  source_archived: 'bare',
};

/** Rejection reasons (S8-DOC §3.7, byte-identical to today's writers). */
export const REJECTION_PREFIX_UNSUPPORTED_PLATFORM = 'unsupported_platform:';
export const REJECTION_MISSING_SOURCE_ID = 'missing_source_id';
/** Prefix S8-A grants byte-exact for an unmapped staged label. */
export const UNRESOLVED_FAMILY_PREFIX = 'unresolved_family:';
export const UNRESOLVED_PREFIX = 'unresolved:';
