import { coverageConditionHolds, coverageOf, requiredFamilies } from './coverage';
import {
  type FamilyFacts,
  type IdentityFacts,
  type LedgerRowFacts,
  NATIVE_TARGET_KINDS,
  type NativeTargetKind,
  type ReasonCount,
  type ReconciliationFacts,
  type ReconciliationFamilyV1,
  type ReconciliationReportV1,
  type ReconciliationResult,
  type ReconciliationVerdictV1,
  type RelationshipClosure,
  type RelationshipFacts,
  REJECTION_MISSING_SOURCE_ID,
  REJECTION_PREFIX_UNSUPPORTED_PLATFORM,
  S9_REASON_CODE,
  S9_REASON_CODES,
  type S9ReasonCode,
  S9_REPORT_CODE,
  type TokenReportV1,
  UNRESOLVED_CATALOGUE,
  UNRESOLVED_FAMILY_PREFIX,
  UNRESOLVED_PREFIX,
  WRITER_CODE,
} from './types';

// S9-A — the pure reconciler: `reconcile(facts)` → `{verdict, report}` (D-S9-1, D-S9-2). No I/O,
// no clock, no exceptions, deterministic (identical facts → identical bytes). It is the only code
// path that can produce `complete`, and it does so only when none of the D-S9-2 conditions hold:
//   C-FAM  an unmapped entry, or a mapped family without a native destination → `unresolved_family`
//   C-ID   a mapped family with unresolved/rejected/failed identities, unresolved children or
//          ledger rows without a staged identity → `unresolved_identities`
//   C-REL  a bucket-j identity whose closure edge fails → `relationship_unverified`
//   C-COV  coverage unknown for any family, or the claim is not `success` → `coverage_basis_unknown`
// `reason_code` is the first condition that holds; the report lists them all. Per-row detail lives
// in the D-S9-7 histogram, never in the run-level code (CQ-17), and no identity, name, email,
// label or payload is ever copied into the report (R14).

/** D-S9-4: the per-run split is `null` = "not yet known" until provenance carries intent attribution. */
export const CREATED_NATIVE_SPLIT: null = null;

/** The four buckets of the staged partition (D-S9-2: `staged_unique = j + rejected + unresolved + failed`). */
export type Bucket = 'native_present_verified' | 'rejected' | 'unresolved' | 'failed';

export interface Classified {
  readonly bucket: Bucket;
  /** D-S9-7 histogram key; `null` only for bucket j. */
  readonly code: string | null;
}

/** Tokens the catalogue admits as qualifiers: family, field, model, staged token or platform. */
const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const UNRESOLVED_REASON = /^unresolved:([a-z_]+)(?::([A-Za-z0-9_.-]{1,64}))?$/;

/** The bucket-k / unparsable-reason answer: never echoes input. */
const UNRECOGNISED: Classified = { bucket: 'unresolved', code: S9_REPORT_CODE.reason_unrecognised };

const isNativeKind = (kind: string | null): kind is NativeTargetKind =>
  kind !== null && (NATIVE_TARGET_KINDS as readonly string[]).includes(kind);

/**
 * Parse a writer's ledger reason into a bucket and a histogram key. Verbatim only when it parses in
 * the closed grammar (S8-DOC §3.7; D-S9-7 key rules); anything else is `reason_unrecognised`.
 */
export function parseLedgerReason(reason: string | null): Classified {
  if (reason === null) return UNRECOGNISED;
  if (reason === REJECTION_MISSING_SOURCE_ID) return { bucket: 'rejected', code: reason };
  if (reason.startsWith(REJECTION_PREFIX_UNSUPPORTED_PLATFORM)) {
    const token = reason.slice(REJECTION_PREFIX_UNSUPPORTED_PLATFORM.length);
    if (TOKEN.test(token)) return { bucket: 'rejected', code: reason };
    return UNRECOGNISED;
  }
  if (reason.startsWith(UNRESOLVED_FAMILY_PREFIX)) {
    const token = reason.slice(UNRESOLVED_FAMILY_PREFIX.length);
    if (TOKEN.test(token)) return { bucket: 'unresolved', code: reason };
    return UNRECOGNISED;
  }
  if (reason.startsWith(UNRESOLVED_PREFIX)) {
    const match = UNRESOLVED_REASON.exec(reason);
    if (match) {
      const shape = UNRESOLVED_CATALOGUE[match[1]];
      const qualified = match[2] !== undefined;
      if (shape === 'qualified' && qualified) return { bucket: 'unresolved', code: reason };
      if (shape === 'bare' && !qualified) return { bucket: 'unresolved', code: reason };
    }
  }
  return UNRECOGNISED;
}

/** One staged identity → exactly one bucket, first match wins (D-S9-2 buckets a–k). */
export function classifyIdentity(fact: IdentityFacts, family: FamilyFacts): Classified {
  if (!family.mapped) {
    // (a) unmapped entry: the resolution reason decides rejected vs unresolved.
    const parsed = parseLedgerReason(family.resolution_reason);
    if (parsed.bucket === 'rejected') return parsed;
    return {
      bucket: 'unresolved',
      code: TOKEN.test(family.family)
        ? `${UNRESOLVED_FAMILY_PREFIX}${family.family}`
        : S9_REPORT_CODE.reason_unrecognised,
    };
  }
  const row = fact.ledger;
  if (row === null) {
    // (b) mapped family, no ledger row for this intent.
    return {
      bucket: 'unresolved',
      code: family.ceiling_exceeded
        ? S9_REPORT_CODE.pass_ceiling_exceeded
        : S9_REPORT_CODE.not_reconstructed,
    };
  }
  switch (row.status) {
    case 'failed':
      return { bucket: 'failed', code: S9_REPORT_CODE.failed }; // (c)
    case 'skipped':
      return parseLedgerReason(row.reason); // (d), (e)
    case 'reconstructed':
      return classifyReconstructed(fact, row, family); // (f)–(j)
    default:
      // (k) catch-all: an unknown ledger status can only arrive from data outside the type.
      return UNRECOGNISED;
  }
}

type ReconstructedRow = Extract<LedgerRowFacts, { status: 'reconstructed' }>;

function classifyReconstructed(
  fact: IdentityFacts,
  row: ReconstructedRow,
  family: FamilyFacts,
): Classified {
  const provenance = row.provenance;
  if (!isNativeKind(row.target_kind)) {
    // (f) evidence only, keyed per row (S8-DOC L148-149): a client principal was needed when the
    // family is client-owned, the row carries a resolved client link, or the writer already said so.
    const clientPrincipal =
      family.client_owned ||
      fact.client_linked ||
      provenance?.reason === WRITER_CODE.no_native_client_principal;
    return {
      bucket: 'unresolved',
      code: clientPrincipal ? WRITER_CODE.no_native_client_principal : S9_REPORT_CODE.evidence_only,
    };
  }
  if (provenance === null || provenance.outcome === 'unresolved') {
    // (g) a native kind with no provenance of a native row.
    return { bucket: 'unresolved', code: S9_REPORT_CODE.provenance_missing };
  }
  switch (provenance.native) {
    case 'foreign_owner':
    case 'kind_mismatch':
    case 'provenance_mismatch':
      return { bucket: 'unresolved', code: WRITER_CODE.identity_conflict }; // (h)
    case 'removed':
      return { bucket: 'unresolved', code: WRITER_CODE.native_target_removed }; // (i)
    case 'present_owned':
      return { bucket: 'native_present_verified', code: null }; // (j)
    default:
      return UNRECOGNISED; // (k)
  }
}

const bump = (hist: Map<string, number>, code: string, by = 1): void => {
  if (by > 0) hist.set(code, (hist.get(code) ?? 0) + by);
};

/** Deterministic histogram: `{code, count}[]` in code-point order. */
const toReasonCounts = (hist: ReadonlyMap<string, number>): ReasonCount[] =>
  Array.from(hist.keys())
    .sort()
    .map((code) => ({ code, count: hist.get(code) ?? 0 }));

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface TokenTally {
  staged_unique: number;
  native_present_verified: number;
  rejected: number;
  unresolved: number;
  failed: number;
}

interface FamilyOutcome {
  readonly facts: FamilyFacts;
  readonly tally: TokenTally;
  readonly tokens: readonly TokenReportV1[];
  readonly reasons: readonly ReasonCount[];
  readonly child_reasons: readonly ReasonCount[];
  readonly unresolved_children: number;
  /** Bucket-j identities, for relationship closure. */
  readonly verified: ReadonlySet<string>;
}

const emptyTally = (): TokenTally => ({
  staged_unique: 0,
  native_present_verified: 0,
  rejected: 0,
  unresolved: 0,
  failed: 0,
});

function reconcileFamily(family: FamilyFacts): FamilyOutcome {
  const reasons = new Map<string, number>();
  const childReasons = new Map<string, number>();
  const tokens = new Map<string, TokenTally>();
  const total = emptyTally();
  const verified = new Set<string>();
  let unresolvedChildren = 0;

  for (const fact of family.identities) {
    const cls = classifyIdentity(fact, family);
    let token = tokens.get(fact.token);
    if (token === undefined) {
      token = emptyTally();
      tokens.set(fact.token, token);
    }
    token.staged_unique += 1;
    total.staged_unique += 1;
    token[cls.bucket] += 1;
    total[cls.bucket] += 1;
    if (cls.code !== null) bump(reasons, cls.code);
    if (cls.bucket !== 'native_present_verified') continue;
    verified.add(fact.identity);

    // Children are counted under bucket-j parents only (D-S9-2); a parent outside j is already
    // unresolved in its own right and its children never enter the partition.
    const row = fact.ledger;
    if (row !== null && row.status === 'reconstructed' && row.provenance !== null) {
      for (const [code, count] of Object.entries(row.provenance.unresolved_children)) {
        if (count > 0) {
          unresolvedChildren += count;
          bump(childReasons, code, count);
        }
      }
    }
  }

  return {
    facts: family,
    tally: total,
    tokens: Array.from(tokens.keys())
      .sort(byString)
      .map((name) => {
        const t = tokens.get(name) ?? emptyTally();
        return { token: name, ...t };
      }),
    reasons: toReasonCounts(reasons),
    child_reasons: toReasonCounts(childReasons),
    unresolved_children: unresolvedChildren,
    verified,
  };
}

/**
 * An edge closes iff its target is a bucket-j identity in the target family and S9-B's attribute
 * comparison did not fail. `consistent === null` is accepted only for `client_link` (E-R3), which
 * has no native attribute to compare (`client_source_id` is a soft link with no FK, S8-DOC §3.8);
 * `program_parent` and `child_order` need an explicit `true`, because `program_id`,
 * `(week_index, day_index)` and `order` are native attributes that must be compared, never assumed.
 */
export function edgeVerified(
  edge: RelationshipFacts,
  verifiedByFamily: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (verifiedByFamily.get(edge.to_family)?.has(edge.to_identity) !== true) return false;
  if (edge.consistent === true) return true;
  return edge.consistent === null && edge.edge === 'client_link';
}

interface FamilyClosure {
  readonly closure: RelationshipClosure;
  readonly unverified: number;
}

const NO_CLOSURE: FamilyClosure = { closure: 'not_applicable', unverified: 0 };

/**
 * Per family: the number of bucket-j identities with at least one failing edge. An edge declared
 * on an identity outside bucket j is not counted — that identity is already unresolved — and a
 * family with no edge on any bucket-j identity is `not_applicable`.
 */
function closeRelationships(
  outcomes: readonly FamilyOutcome[],
  relationships: readonly RelationshipFacts[],
): Map<string, FamilyClosure> {
  // Union per family name, never overwrite: two entries sharing a family (outside D-S9-2's
  // grouping, but type-valid) must not hide the first entry's bucket-j identities from an edge.
  const verifiedByFamily = new Map<string, ReadonlySet<string>>();
  for (const o of outcomes) {
    const prev = verifiedByFamily.get(o.facts.family);
    verifiedByFamily.set(
      o.facts.family,
      prev === undefined ? o.verified : new Set([...prev, ...o.verified]),
    );
  }

  const checked = new Set<string>();
  const failing = new Map<string, Set<string>>();
  for (const edge of relationships) {
    if (verifiedByFamily.get(edge.from_family)?.has(edge.from_identity) !== true) continue;
    checked.add(edge.from_family);
    if (edgeVerified(edge, verifiedByFamily)) continue;
    let set = failing.get(edge.from_family);
    if (set === undefined) {
      set = new Set<string>();
      failing.set(edge.from_family, set);
    }
    set.add(edge.from_identity);
  }

  const out = new Map<string, FamilyClosure>();
  for (const o of outcomes) {
    const family = o.facts.family;
    const unverified = failing.get(family)?.size ?? 0;
    const closure: RelationshipClosure =
      unverified > 0 ? 'unverified' : checked.has(family) ? 'verified' : 'not_applicable';
    out.set(family, { closure, unverified });
  }
  return out;
}

/** D-S9-2 run-level conditions, in order. `[]` iff `complete`. */
export function conditions(
  facts: ReconciliationFacts,
  families: readonly ReconciliationFamilyV1[],
): S9ReasonCode[] {
  const held: S9ReasonCode[] = [];
  const mapped = families.filter((f) => f.mapped);

  const noDestination = (f: ReconciliationFamilyV1): boolean =>
    f.reasons.some((r) => r.code.startsWith(WRITER_CODE.no_native_destination_prefix));
  if (families.some((f) => !f.mapped) || mapped.some(noDestination)) {
    held.push(S9_REASON_CODE.unresolved_family);
  }
  if (
    facts.ledger_without_staged > 0 ||
    mapped.some(
      (f) =>
        f.unresolved + f.rejected + f.failed > 0 ||
        f.unresolved_children > 0 ||
        f.ledger_without_staged > 0,
    )
  ) {
    held.push(S9_REASON_CODE.unresolved_identities);
  }
  if (families.some((f) => f.relationship_unverified > 0)) {
    held.push(S9_REASON_CODE.relationship_unverified);
  }
  if (coverageConditionHolds(facts)) held.push(S9_REASON_CODE.coverage_basis_unknown);

  // The order above is D-S9-2's; pin it against the exported catalogue order.
  return S9_REASON_CODES.filter((code) => held.includes(code));
}

/** A zero-row entry for a required family the run never staged (D-S9-2 required families). */
const declaredOnly = (family: string): FamilyFacts => ({
  family,
  mapped: true,
  resolution_reason: null,
  client_owned: false,
  ceiling_exceeded: false,
  identities: [],
  ledger_without_staged: 0,
  qualifiers: [],
});

export function reconcile(facts: ReconciliationFacts): ReconciliationResult {
  const required = requiredFamilies(facts);
  const staged = new Set(facts.families.map((f) => f.family));
  const entries: FamilyFacts[] = [...facts.families];
  for (const family of required ?? []) if (!staged.has(family)) entries.push(declaredOnly(family));

  const outcomes = entries
    .sort((a, b) => (a.mapped !== b.mapped ? (a.mapped ? -1 : 1) : byString(a.family, b.family)))
    .map(reconcileFamily);
  const closures = closeRelationships(outcomes, facts.relationships);

  const families: ReconciliationFamilyV1[] = outcomes.map((o) => {
    const coverage = coverageOf(facts, o.facts.family);
    const closure = closures.get(o.facts.family) ?? NO_CLOSURE;
    return {
      family: o.facts.family,
      mapped: o.facts.mapped,
      tokens: o.tokens,
      staged_unique: o.tally.staged_unique,
      native_present_verified: o.tally.native_present_verified,
      created_native: CREATED_NATIVE_SPLIT,
      already_present_verified: CREATED_NATIVE_SPLIT,
      rejected: o.tally.rejected,
      unresolved: o.tally.unresolved,
      failed: o.tally.failed,
      ledger_without_staged: o.facts.ledger_without_staged,
      unresolved_children: o.unresolved_children,
      relationship_closure: closure.closure,
      relationship_unverified: closure.unverified,
      reasons: o.reasons,
      child_reasons: o.child_reasons,
      qualifiers: [...o.facts.qualifiers].sort(byString),
      completeness_basis: coverage.completeness_basis,
      observed_unique: coverage.observed_unique,
      pagination_terminal_evidence: null,
      date_window: null,
      media_policy: null,
    };
  });

  const held = conditions(facts, families);
  const verdict: ReconciliationVerdictV1 =
    held.length === 0
      ? { outcome: 'complete', reason_code: null }
      : { outcome: 'partial', reason_code: held[0] };
  const report: ReconciliationReportV1 = {
    report_version: 1,
    basis: 'recomputed',
    conditions: held,
    required_families: required,
    ledger_without_staged: facts.ledger_without_staged,
    families,
  };
  return { verdict, report };
}
