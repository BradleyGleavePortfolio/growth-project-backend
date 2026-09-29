import { verify as cryptoVerify, type KeyObject } from 'crypto';
import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';
import type { CoverageFact } from '../reconciliation/types';
import { isCanonicalPlatform } from '../scout-platform';
import {
  CHALLENGE_BYTES,
  REPLAY_TERMINAL_STOPS,
  type CoverageReasonCode,
  type FamilyCountBasis,
  type ProvingBasisKind,
} from './contract';
import { EMPTY_IDENTITY_SET_DIGEST, type IdentitySetDigest } from './digest';
import type { InductionPackage, InductionRegistry } from './manifest-registry';
import {
  decodeBase64Strict,
  ed25519PublicKey,
  isCanonicalFamily,
  isHex64,
  parseEvidence,
  unitKey,
  type ParsedEvidence,
  type ParsedReplayTerminalEvidence,
  type ParsedSourceSignedEvidence,
} from './parse';

// S10-A — the pure server evaluator (D-S10-3). No I/O, no clock, no exceptions (like
// `arbiter.ts`): every input it cannot prove yields `{known: false}`, never a count of 0. It
// dispatches on `basis_kind` only and never on a source name (D-S10-8).
//
// L3 (owner D1, 2026-09-28; L0 r4 D-L0-6) adds the `replay_terminal_enumeration` rule
// (`proveReplayTerminalEnumeration`), fail-closed: the extension's per-step exhaustion evidence,
// bound to the run's challenge and proven only by digest AND count equality with the staged side
// (E6); any non-terminal stop, advertised next link, refused page, root step that fetched no
// page, synthetic or missing id, fan-out short of its parent set or whose `expected` is not the
// parent step's PROVEN count, step set short of the spec's, or digest/count mismatch is unknown
// (never 0).
//
// Executive reset 2026-09-29 §1/§8: NO package has a run-level completeness closure until a
// separate closure record lands. So a replay-proven family yields a PROVEN SOURCE COUNT in
// `CoverageEvaluation.families` (for the one run-status projection, slice L2) but NEVER a
// `CoverageFact` with `known: true`: the reconciler cannot see the replay kind at all, and the run
// settles `partial/coverage_basis_unknown` through the existing reason channel. `complete` stays
// reachable only through `source_signed_enumeration` (test-only outside dev/test, S12-B2).
// `evaluateCoverage` (the S9 facts) is otherwise unchanged; `evaluateCoverageDetailed` adds the
// typed per-family structure (closed reason codes in `COVERAGE_REASON_CODES`).

/** The settling run, read by S10-C under the run row lock. */
export interface RunBinding {
  readonly coach_id: string;
  readonly intent_id: string;
  readonly execution_epoch: number;
  readonly accepted_start_at: Date;
}

/** The run's immutable declaration (D-S10-2): one shared challenge, platforms and their scopes. */
export interface RunDeclaration {
  readonly challenge: Uint8Array;
  readonly platforms: readonly {
    readonly source_platform: string;
    readonly account_scope_id_digests: readonly string[];
  }[];
}

/** One stored `ScoutRunObservation` row with its server-bound columns. */
export interface StoredObservation {
  readonly coach_id: string;
  readonly intent_id: string;
  readonly execution_epoch: number;
  readonly received_at: Date;
  /** The stored `evidence jsonb`; re-validated here, never trusted. */
  readonly evidence: unknown;
}

/** E6: one staged platform as S9-B's own grouping partitioned it (S10-C supplies these). */
export interface StagedPlatformFacts {
  readonly source_platform: string;
  /** The family set S9-B grouped this platform's rows against. */
  readonly grouped_families: readonly string[];
  /**
   * Per-family staged digest (`digest.ts` `stagedFamilyDigests`). Every `grouped_families` entry
   * must be present (zero rows → the empty-set digest); a grouped family absent here is unknown.
   */
  readonly families: ReadonlyMap<string, IdentitySetDigest | null>;
}

/** One staged platform in the evaluator index; supplied twice → `conflict` (E6, fails closed). */
type StagedIndexEntry =
  { readonly kind: 'facts'; readonly facts: StagedPlatformFacts } | { readonly kind: 'conflict' };

export interface CoverageEvaluationInput {
  readonly run: RunBinding;
  readonly declaration: RunDeclaration | null;
  readonly registry: InductionRegistry;
  /** Stored evidence at the settle epoch. */
  readonly observations: readonly StoredObservation[];
  readonly staged: readonly StagedPlatformFacts[];
}

/** L3 r2: one reason a family is not a run-level basis (or its count unknown); counts only. */
export interface CoverageReason {
  readonly code: CoverageReasonCode;
  /** The declared or staged platform the reason arose on; `null` for a run- or evaluator-wide one. */
  readonly platform: string | null;
}

/**
 * L3 r2: what the evaluator established for one family, for the ONE run-status projection
 * (executive reset 2026-09-29 §6: `families[].source_count`/`count_basis`, `gaps[]`). A count is
 * present only with `count_basis: 'proven'`; unknown is `null`, never 0.
 */
export interface FamilyCoverageDetail {
  /** The proven distinct source ids for the family across its declared platforms, else `null`. */
  readonly source_count: number | null;
  readonly count_basis: FamilyCountBasis;
  /** The single basis kind that proved the count, else `null`. */
  readonly basis_kind: ProvingBasisKind | null;
  /**
   * Why the family is not a run-level basis. `[]` iff `facts[family]` is `known: true` and covers
   * the staged set. A replay-proven family always carries `completeness_not_proven` (no
   * completeness closure exists for any package yet).
   */
  readonly reasons: readonly CoverageReason[];
}

/**
 * `evaluateCoverage` plus the per-family detail: the typed structure the run-status projection
 * slice (L2) consumes to show source counts and name gaps to the coach. Nothing here is
 * persisted or shown yet.
 */
export interface CoverageEvaluation {
  readonly facts: Readonly<Record<string, CoverageFact>>;
  /** Keyed like `facts` (same key set). */
  readonly families: Readonly<Record<string, FamilyCoverageDetail>>;
}

const SIGNED_KIND = 'source_signed_enumeration' as const;
const REPLAY_KIND = 'replay_terminal_enumeration' as const;

/** One fan-out step's binding claim: `expected` parent contexts, iterated over `parentStep`. */
interface FanOutClaim {
  readonly parentStep: string;
  readonly expected: number;
}

/** One proven `(platform, scope, family)` unit: its verified count, digest and basis kind. */
interface ProvenUnit {
  readonly observed: number;
  readonly idSetDigest: string;
  readonly kind: ProvingBasisKind;
  /** L3 r2: the replay steps' distinct id counts by step key (a fan-out's parent is looked up here). */
  readonly stepCounts: ReadonlyMap<string, number>;
  /** L3 r2: fan-out claims still to be bound to their parent step's proven count. */
  readonly fanOuts: readonly FanOutClaim[];
}

/** A unit either proves or names the ONE reason it does not (the first failing check). */
type UnitResult =
  | { readonly ok: true; readonly unit: ProvenUnit }
  | { readonly ok: false; readonly code: CoverageReasonCode };

const unproven = (code: CoverageReasonCode): UnitResult => ({ ok: false, code });

/** Ed25519 (RFC 8032) over `message`; `false` on any error. Never throws. */
export function verifyEd25519(key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

interface FamilyAccumulator {
  failed: boolean;
  observed: number;
  covers: boolean;
  /** The one basis kind every proven platform used; two kinds in one family fail closed. */
  kind: ProvingBasisKind | null;
  /** L3 r2: why the family is unknown (empty iff known); first occurrence order, deduplicated. */
  readonly reasons: CoverageReason[];
}

interface UnitRow {
  readonly row: StoredObservation;
  readonly parsed: ParsedEvidence;
}

interface IndexedObservations {
  readonly byUnit: ReadonlyMap<string, readonly UnitRow[]>;
  /** Units with an unparseable row (the row fails its unit, never another). */
  readonly poisonedUnits: ReadonlySet<string>;
  /** An unparseable row that names no unit poisons everything. */
  readonly poisonedAll: boolean;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** A runtime shape check that deliberately does not narrow the declared type. */
function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function isSafeEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** A structurally valid declaration, as platform → scopes; `null` means "no declaration" (E1). */
function readDeclaration(
  declaration: RunDeclaration | null,
): { readonly challenge: Buffer; readonly scopes: ReadonlyMap<string, readonly string[]> } | null {
  if (declaration === null || !(declaration.challenge instanceof Uint8Array)) return null;
  if (declaration.challenge.length !== CHALLENGE_BYTES) return null;
  if (!isArrayValue(declaration.platforms) || declaration.platforms.length === 0) return null;
  const scopes = new Map<string, readonly string[]>();
  for (const entry of declaration.platforms) {
    const platform = entry.source_platform;
    const list = entry.account_scope_id_digests;
    if (!isCanonicalPlatform(platform) || scopes.has(platform)) return null;
    if (!isArrayValue(list) || list.length === 0 || !list.every(isHex64)) return null;
    if (new Set(list).size !== list.length) return null;
    scopes.set(platform, [...list]);
  }
  return { challenge: Buffer.from(declaration.challenge), scopes };
}

function looseUnitKey(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj: object = raw;
  const fields = Object.fromEntries(Object.entries(obj));
  const { source_platform, account_scope_id_digest, family } = fields;
  if (typeof source_platform !== 'string' || typeof account_scope_id_digest !== 'string') {
    return null;
  }
  if (typeof family !== 'string') return null;
  return unitKey(source_platform, account_scope_id_digest, family);
}

function indexObservations(rows: readonly StoredObservation[]): IndexedObservations {
  const byUnit = new Map<string, UnitRow[]>();
  const poisonedUnits = new Set<string>();
  const malformed = !isArrayValue(rows);
  let poisonedAll = malformed;
  for (const row of malformed ? [] : rows) {
    const parsed = parseEvidence(row === null || typeof row !== 'object' ? null : row.evidence);
    if (!parsed.ok) {
      const key = looseUnitKey(row === null || typeof row !== 'object' ? null : row.evidence);
      if (key === null) poisonedAll = true;
      else poisonedUnits.add(key);
      continue;
    }
    const { source_platform, account_scope_id_digest, family } = parsed.value.evidence;
    const key = unitKey(source_platform, account_scope_id_digest, family);
    const list = byUnit.get(key) ?? [];
    list.push({ row, parsed: parsed.value });
    byUnit.set(key, list);
  }
  return { byUnit, poisonedUnits, poisonedAll };
}

/** E2-E5 for one `(platform, scope, family)` unit; the proven unit, or the reason it is not. */
function proveUnit(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  run: RunBinding,
  challenge: Buffer,
  index: IndexedObservations,
): UnitResult {
  const key = unitKey(platform, scope, family);
  if (index.poisonedAll || index.poisonedUnits.has(key)) return unproven('evidence_malformed');
  // E2: exactly one row; an absent row is unknown, never 0.
  const rows = index.byUnit.get(key) ?? [];
  if (rows.length === 0) return unproven('evidence_missing');
  if (rows.length > 1) return unproven('evidence_duplicate');
  const { row, parsed } = rows[0];
  const { evidence } = parsed;

  // E3: binding to the settling run, the manifest, the family's kinds and the loaded spec.
  if (row.coach_id !== run.coach_id || row.intent_id !== run.intent_id) {
    return unproven('evidence_unbound');
  }
  if (!isSafeEpoch(row.execution_epoch) || row.execution_epoch !== run.execution_epoch) {
    return unproven('evidence_unbound');
  }
  if (!isCanonicalFamily(family) || !pkg.manifest.expectedFamilies.includes(family)) {
    return unproven('evidence_unbound');
  }
  const kinds = pkg.manifest.basisKinds[family] ?? [];
  if (!kinds.includes(evidence.basis_kind)) return unproven('evidence_unbound');
  if (evidence.mapping_spec_digest !== pkg.specDigest) return unproven('evidence_unbound');

  switch (parsed.basis_kind) {
    case SIGNED_KIND:
      return proveSourceSignedEnumeration(
        pkg,
        platform,
        scope,
        family,
        run,
        challenge,
        row,
        parsed,
      );
    case REPLAY_KIND:
      return proveReplayTerminalEnumeration(pkg, platform, scope, family, challenge, parsed);
    default:
      return unproven('evidence_unbound');
  }
}

/** E4 for `source_signed_enumeration`: source verifier, signature over decoded bytes, unit match. */
function proveSourceSignedEnumeration(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  run: RunBinding,
  challenge: Buffer,
  row: StoredObservation,
  parsed: ParsedSourceSignedEvidence,
): UnitResult {
  const verifier = pkg.manifest.verifiers.find((v) => v.key_id === parsed.evidence.key_id);
  if (verifier === undefined) return unproven('signature_unverified');
  const raw = decodeBase64Strict(verifier.public_key_b64);
  const key = raw === null ? null : ed25519PublicKey(raw);
  if (key === null) return unproven('signature_unverified');
  if (!verifyEd25519(key, parsed.statementBytes, parsed.signature)) {
    return unproven('signature_unverified');
  }

  const { statement, issuedAt } = parsed.parsedStatement;
  if (statement.source_platform !== platform) return unproven('evidence_unbound');
  if (statement.account_scope_id_digest !== scope) return unproven('evidence_unbound');
  if (statement.family !== family) return unproven('evidence_unbound');
  if (!parsed.parsedStatement.challenge.equals(challenge)) return unproven('evidence_unbound');
  if (statement.date_window !== null || statement.terminal !== 'end_of_list') {
    return unproven('signature_unverified');
  }
  if (!isValidDate(run.accepted_start_at) || !isValidDate(row.received_at)) {
    return unproven('signature_unverified');
  }
  if (issuedAt.floorMs < run.accepted_start_at.getTime()) return unproven('signature_unverified');
  if (issuedAt.ceilMs > row.received_at.getTime()) return unproven('signature_unverified');
  // E5.
  return {
    ok: true,
    unit: {
      observed: statement.observed_unique,
      idSetDigest: statement.id_set_digest,
      kind: SIGNED_KIND,
      stepCounts: new Map(),
      fanOuts: [],
    },
  };
}

/**
 * L3 E4 for `replay_terminal_enumeration` (L0 r4 D-L0-6 "Pagination exhaustion is proven per
 * endpoint, positively"). The evidence must name this unit and the run's declaration challenge,
 * and report a step evidence for every collection step the pinned package maps to the family (a
 * canonical-token collection may appear as the family token); a missing, extra or duplicate step
 * key is unknown. Every step must be exhausted: stopped at `absent_next`, `empty_page` or
 * `short_page` after ≥ 1 page, no advertised next link, zero refused pages, no synthetic or
 * missing id. A fan-out step must have visited every expected parent context (`fetched ===
 * expected === pages_fetched`); its `expected` is bound to the parent step's proven
 * `distinct_raw_ids` by `evaluate` (`fanOuts`). The row's step counters must agree with its
 * family totals (a single-step family's step digest and count ARE the family's). Anything else is
 * a truncated or inconsistent crawl: unknown, never 0. The count and digest are proven against the
 * staged side by the caller (E6, equality only). The package carries no pagination style yet, so
 * the terminal set is style-agnostic (see the L3 record §3).
 */
function proveReplayTerminalEnumeration(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  challenge: Buffer,
  parsed: ParsedReplayTerminalEvidence,
): UnitResult {
  const { evidence } = parsed;
  if (evidence.source_platform !== platform) return unproven('evidence_unbound');
  if (evidence.account_scope_id_digest !== scope) return unproven('evidence_unbound');
  if (evidence.family !== family) return unproven('evidence_unbound');
  if (!parsed.challenge.equals(challenge)) return unproven('evidence_unbound');
  if (!isCanonicalFamily(family)) return unproven('evidence_unbound');

  const specSteps = pkg.stepsByFamily.get(family) ?? [];
  const reported = new Set(evidence.steps.map((s) => s.step_key));
  // Every spec step feeding the family needs a terminal; no step outside the spec (or the
  // family's own token) may be reported.
  if (!specSteps.every((step) => reported.has(step))) return unproven('step_set_mismatch');
  for (const step of reported) {
    if (step !== family && !specSteps.includes(step)) return unproven('step_set_mismatch');
  }
  const fanOuts: FanOutClaim[] = [];
  const stepCounts = new Map<string, number>();
  let distinctSum = 0;
  for (const step of evidence.steps) {
    if (!REPLAY_TERMINAL_STOPS.includes(step.stop)) return unproven('crawl_truncated');
    if (step.advertised_next) return unproven('crawl_truncated');
    if (step.refused_pages !== 0) return unproven('crawl_truncated');
    if (step.synthetic_ids !== 0 || step.missing_id_items !== 0) {
      return unproven('identity_unproven');
    }
    if (step.distinct_raw_ids > step.raw_items) return unproven('evidence_inconsistent');
    if (step.distinct_raw_ids + step.duplicate_ids > step.raw_items) {
      return unproven('evidence_inconsistent');
    }
    if (step.fan_out === null) {
      if (step.pages_fetched < 1) return unproven('zero_pages_fetched');
    } else {
      if (step.fan_out.fetched !== step.fan_out.expected) return unproven('fan_out_short');
      if (step.pages_fetched !== step.fan_out.fetched) return unproven('fan_out_short');
      fanOuts.push({ parentStep: step.fan_out.parent_step, expected: step.fan_out.expected });
    }
    stepCounts.set(step.step_key, step.distinct_raw_ids);
    distinctSum += step.distinct_raw_ids;
  }
  // The family totals are the union of the steps' id sets: never more than their sum, and for
  // a single step exactly that step's count and digest.
  if (evidence.observed_unique > distinctSum) return unproven('evidence_inconsistent');
  if (evidence.steps.length === 1) {
    const only = evidence.steps[0];
    if (only.distinct_raw_ids !== evidence.observed_unique) {
      return unproven('evidence_inconsistent');
    }
    if (only.id_set_digest !== evidence.id_set_digest) return unproven('evidence_inconsistent');
  }
  return {
    ok: true,
    unit: {
      observed: evidence.observed_unique,
      idSetDigest: evidence.id_set_digest,
      kind: REPLAY_KIND,
      stepCounts,
      fanOuts,
    },
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && left.size === new Set(b).size && b.every((v) => left.has(v));
}

/** One platform's provisional per-family proof, before fan-out binding and accumulation. */
interface PlatformFamilyProof {
  readonly unit: ProvenUnit;
  readonly covers: boolean;
}

/** The proven `distinct_raw_ids` of `stepKey` among this platform's proven units, or `null`. */
function provenStepCount(
  proofs: ReadonlyMap<string, PlatformFamilyProof>,
  stepKey: string,
): number | null {
  let found: number | null = null;
  for (const proof of proofs.values()) {
    const count = proof.unit.stepCounts.get(stepKey);
    if (count === undefined) continue;
    if (found !== null) return null; // the same step key in two proven rows: ambiguous
    found = count;
  }
  return found;
}

function evaluate(input: CoverageEvaluationInput): CoverageEvaluation {
  const acc = new Map<string, FamilyAccumulator>();
  const touch = (family: string): FamilyAccumulator => {
    let entry = acc.get(family);
    if (entry === undefined) {
      entry = { failed: false, observed: 0, covers: true, kind: null, reasons: [] };
      acc.set(family, entry);
    }
    return entry;
  };
  const note = (family: string, code: CoverageReasonCode, platform: string | null): void => {
    const entry = touch(family);
    if (!entry.reasons.some((r) => r.code === code && r.platform === platform)) {
      entry.reasons.push(Object.freeze({ code, platform }));
    }
  };
  const fail = (family: string, code: CoverageReasonCode, platform: string | null): void => {
    if (!isCanonicalFamily(family)) return;
    touch(family).failed = true;
    note(family, code, platform);
  };

  const { run, registry } = input;
  const declaration = readDeclaration(input.declaration);
  const index = indexObservations(input.observations);

  // Staged platforms; a platform supplied twice is a partition disagreement (fails closed).
  const staged = new Map<string, StagedIndexEntry>();
  for (const entry of input.staged) {
    staged.set(
      entry.source_platform,
      staged.has(entry.source_platform) ? { kind: 'conflict' } : { kind: 'facts', facts: entry },
    );
  }

  const declaredScopes = declaration?.scopes ?? new Map<string, readonly string[]>();
  for (const [platform, scopes] of declaredScopes) {
    const pkg = registry.packages.get(platform);
    const families: readonly string[] =
      pkg?.manifest.expectedFamilies ?? registry.specFamilies.get(platform) ?? CANONICAL_FAMILIES;
    const stagedEntry = staged.get(platform);
    const stagedFacts = stagedEntry?.kind === 'facts' ? stagedEntry.facts : undefined;
    // A 'conflict' entry has no facts, so it never agrees.
    const partitionAgrees =
      stagedEntry === undefined ||
      (stagedFacts !== undefined &&
        sameSet(stagedFacts.grouped_families, families) &&
        [...stagedFacts.families.keys()].every((f) => families.includes(f)));
    // E1 (manifest), E6 (partition agreement; multi-scope attribution deferred in v1). Every
    // platform-wide blocker is named (nothing hides behind the first).
    const platformReasons: CoverageReasonCode[] = [];
    if (declaration === null) platformReasons.push('declaration_missing');
    if (pkg === undefined) platformReasons.push('package_missing');
    if (!partitionAgrees) platformReasons.push('partition_disagreement');
    if (scopes.length !== 1) platformReasons.push('multi_scope');
    if (platformReasons.length > 0 || pkg === undefined || declaration === null) {
      for (const family of families) {
        for (const code of platformReasons) fail(family, code, platform);
      }
      continue;
    }

    // Pass 1: per family, the unit proof (E2-E5) and the staged-side equality (E6).
    const proofs = new Map<string, PlatformFamilyProof>();
    for (const family of families) {
      let observed = 0;
      let unit: ProvenUnit | null = null;
      let unitDigest: string | null = null;
      let unitCode: CoverageReasonCode | null = null;
      for (const scope of scopes) {
        const result = proveUnit(pkg, platform, scope, family, run, declaration.challenge, index);
        if (!result.ok) unitCode = result.code;
        else {
          observed += result.unit.observed;
          unit = result.unit;
          unitDigest = result.unit.idSetDigest;
        }
      }
      // A grouped family missing from the digest map is unknown, never zero.
      if (
        stagedFacts !== undefined &&
        stagedFacts.grouped_families.includes(family) &&
        !stagedFacts.families.has(family)
      ) {
        fail(family, 'staged_digest_missing', platform);
        continue;
      }
      // Only a family absent from both (genuinely not staged) is the empty identity set.
      const stagedDigest =
        stagedFacts !== undefined && stagedFacts.families.has(family)
          ? stagedFacts.families.get(family)
          : { digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 };
      if (unitCode !== null || unit === null) {
        fail(family, unitCode ?? 'evidence_missing', platform);
        continue;
      }
      if (stagedDigest === null || stagedDigest === undefined) {
        fail(family, 'staged_digest_missing', platform);
        continue;
      }
      // E6: the single scope's evidence digest against the platform's staged identities.
      const covers = unitDigest === stagedDigest.digest;
      if (covers && observed !== stagedDigest.count) {
        fail(family, 'staged_mismatch', platform); // equal digest, unequal count: inconsistent
        continue;
      }
      // L3: an observer-asserted count is a fact only when it equals the staged set exactly.
      if (unit.kind === REPLAY_KIND && !covers) {
        fail(family, 'staged_mismatch', platform);
        continue;
      }
      proofs.set(family, { unit: { ...unit, observed }, covers });
    }

    // Pass 2 (L3 r2, L0 r4 D-L0-6): bind every fan-out claim to its parent step's PROVEN
    // `distinct_raw_ids` — a step of a family this platform proved (E6), possibly its own. A
    // parent whose family is unproven (including through its own fan-out) unproves the child,
    // so the pass repeats until nothing changes (bounded by the family count).
    let changed = true;
    while (changed) {
      changed = false;
      for (const [family, proof] of proofs) {
        for (const claim of proof.unit.fanOuts) {
          const parentCount = provenStepCount(proofs, claim.parentStep);
          if (parentCount === null) {
            fail(family, 'fan_out_parent_unproven', platform);
          } else if (parentCount !== claim.expected) {
            fail(family, 'fan_out_count_mismatch', platform);
          } else continue;
          proofs.delete(family);
          changed = true;
          break;
        }
      }
    }

    for (const [family, proof] of proofs) {
      const entry = touch(family);
      if (entry.kind !== null && entry.kind !== proof.unit.kind) {
        // Two basis kinds in one family: no single truthful `basis_kind`.
        fail(family, 'basis_kind_conflict', platform);
        continue;
      }
      entry.kind = proof.unit.kind;
      entry.observed += proof.unit.observed;
      entry.covers = entry.covers && proof.covers;
      // A signed count that does not equal the staged set is a fact worth showing, not a basis.
      if (!proof.covers) note(family, 'staged_mismatch', platform);
    }
  }

  // E1: every family of an undeclared staged platform is unknown (and stays emitted).
  for (const [platform, entry] of staged) {
    if (declaredScopes.has(platform)) continue;
    const families = new Set<string>(registry.specFamilies.get(platform) ?? []);
    const named: readonly string[] =
      entry.kind === 'conflict'
        ? CANONICAL_FAMILIES
        : [...entry.facts.grouped_families, ...entry.facts.families.keys()];
    named.forEach((f) => families.add(f));
    families.forEach((f) => fail(f, 'platform_undeclared', platform));
  }

  const out: Record<string, CoverageFact> = {};
  const families: Record<string, FamilyCoverageDetail> = {};
  for (const family of [...acc.keys()].sort()) {
    const entry = acc.get(family);
    if (entry === undefined || entry.failed || entry.kind === null) {
      out[family] = { known: false };
      families[family] = unknownDetail(
        entry === undefined || entry.reasons.length > 0
          ? [...(entry?.reasons ?? [])]
          : [Object.freeze({ code: 'evidence_missing' as const, platform: null })],
      );
      continue;
    }
    if (entry.kind === REPLAY_KIND) {
      // Executive reset 2026-09-29 §1: a proven SOURCE COUNT, never a run-level basis — no
      // completeness closure exists for any package, so the reconciler never sees this kind.
      out[family] = { known: false };
      note(family, 'completeness_not_proven', null);
      families[family] = Object.freeze({
        source_count: entry.observed,
        count_basis: 'proven',
        basis_kind: entry.kind,
        reasons: Object.freeze([...entry.reasons]),
      });
      continue;
    }
    out[family] = {
      known: true,
      basis_kind: entry.kind,
      observed_unique: entry.observed,
      covers_staged_identities: entry.covers,
    };
    families[family] = Object.freeze({
      source_count: entry.observed,
      count_basis: 'proven',
      basis_kind: entry.kind,
      reasons: Object.freeze([...entry.reasons]),
    });
  }
  return { facts: Object.freeze(out), families: Object.freeze(families) };
}

function unknownDetail(reasons: readonly CoverageReason[]): FamilyCoverageDetail {
  return Object.freeze({
    source_count: null,
    count_basis: 'unknown',
    basis_kind: null,
    reasons: Object.freeze([...reasons]),
  });
}

function allUnknown(): CoverageEvaluation {
  const facts: Record<string, CoverageFact> = {};
  const families: Record<string, FamilyCoverageDetail> = {};
  for (const family of CANONICAL_FAMILIES) {
    facts[family] = { known: false };
    families[family] = unknownDetail([
      Object.freeze({ code: 'evaluator_failure', platform: null }),
    ]);
  }
  return { facts: Object.freeze(facts), families: Object.freeze(families) };
}

/**
 * `evaluateCoverage` with the per-family detail beside the facts (the typed structure the
 * run-status projection slice consumes). Total: an unexpected failure yields `{known: false}` /
 * `evaluator_failure` for every canonical family.
 */
export function evaluateCoverageDetailed(input: CoverageEvaluationInput): CoverageEvaluation {
  try {
    return evaluate(input);
  } catch {
    return allUnknown();
  }
}

/**
 * D-S10-3 `evaluateCoverage`: per emitted family (every `expectedFamilies` entry of every
 * declared platform, plus every family of an undeclared staged platform) the S9 `CoverageFact`.
 * Total: an unexpected failure yields `{known: false}` for every canonical family.
 */
export function evaluateCoverage(
  input: CoverageEvaluationInput,
): Readonly<Record<string, CoverageFact>> {
  return evaluateCoverageDetailed(input).facts;
}
