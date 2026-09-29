import { verify as cryptoVerify, type KeyObject } from 'crypto';
import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';
import type { CoverageFact } from '../reconciliation/types';
import { isCanonicalPlatform } from '../scout-platform';
import {
  CHALLENGE_BYTES,
  REPLAY_ABORTED_STOPS,
  REPLAY_EXHAUSTED_STOPS,
  type CoverageReasonCode,
  type FamilyCountBasis,
  type ProvingBasisKind,
  type ReplayFanOutV1,
  type ReplayStepEvidenceV1,
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
// L3 (owner D1, 2026-09-28; L0 r5 D-L0-6 "Per-family counting evidence is kept") adds the
// `replay_terminal_enumeration` rule (`proveReplayTerminalEnumeration`), fail-closed: the
// extension's per-step evidence, bound to the run's challenge, every step verified against the
// staged rows of THAT step (digest and count; `StagedPlatformFacts.steps`), the family proven
// only by digest AND count equality with the staged side (E6). A step is positively exhausted
// only at `empty_page` / `absent_next` after ≥ 1 page with no advertised next link and no refused
// page; a fan-out step only when its parent binding (`parent_ids_digest` = the parent step's
// verified digest, `contexts_expected` = its count, chain ending in a root step) holds and every
// context is exhausted. Family `count_basis` (r5): `proven` iff every feeding step is exhausted;
// `observed` iff every step fetched and none aborted (`budget`/`cycle`/`error`) but one is not
// exhausted (short/first page, advertised next, refused page, fan-out short); `unknown` for
// anything else — a missing/extra/duplicate step, a synthetic or missing id, an inconsistent
// row, a fan-out whose parent is unverified, self or cyclic, or a staged mismatch (never 0).
//
// Executive reset 2026-09-29 §1/§8: NO package has a run-level completeness closure until a
// separate closure record lands. So a replay-counted family yields a SOURCE COUNT in
// `CoverageEvaluation.families` (for the one run-status projection, slice L2d) but NEVER a
// `CoverageFact` with `known: true`: the reconciler cannot see the replay kind at all, and the run
// settles `partial/coverage_basis_unknown` through the existing reason channel. `complete` stays
// reachable only through `source_signed_enumeration`, whose manifests are refused outside an
// explicit development/test runtime at the one registry boundary every package passes
// (`buildInductionRegistry`, L3 r4 `R589-c7B2-01`: file, pinned/learned and partition packages
// alike; the loader's `parseInductionManifestForRuntime` is the earlier redundant gate, S12-B2 +
// L3 r3).
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
  /**
   * L3 r3: per-STEP staged digest, keyed by the staged `entity_type` token (a spec step key or
   * the family token), over the `source_id`s staged under it — the same rows the family digests
   * union. Every step of the platform's spec must be present (zero rows → the empty-set digest);
   * a replay step with no entry here is unknown (`staged_digest_missing`). This is what makes a
   * multi-step family's per-step digests, and a fan-out's parent id set, verifiable
   * (`R589-c7A-04`, `R589-c7B-02`).
   */
  readonly steps: ReadonlyMap<string, IdentitySetDigest | null>;
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
  /**
   * The distinct source ids for the family across its declared platforms under `proven` or
   * `observed` (L0 r5 D-L0-6: the union distinct id count), else `null` — never 0 for unknown.
   */
  readonly source_count: number | null;
  readonly count_basis: FamilyCountBasis;
  /** The single basis kind that established the count, else `null`. */
  readonly basis_kind: ProvingBasisKind | null;
  /**
   * Why the family is not a run-level basis. `[]` iff `facts[family]` is `known: true` and covers
   * the staged set. A replay-counted family always carries `completeness_not_proven` (no
   * completeness closure exists for any package yet); an `observed` one also `list_not_exhausted`.
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

/** One replay step verified against the staged rows of that step (count and digest equal). */
interface VerifiedStep {
  readonly stepKey: string;
  /** The step's distinct staged identities (= `distinct_raw_ids` = the staged count). */
  readonly count: number;
  /** The step's `id_set_digest` (= the staged digest of the step). */
  readonly digest: string;
  /**
   * Positively exhausted on its own terms: `empty_page`/`absent_next`, no advertised next link,
   * no refused page and, for a fan-out, every expected context fetched and exhausted. The parent
   * binding of a fan-out is checked by `evaluate` across the platform's units.
   */
  readonly exhausted: boolean;
  readonly fanOut: ReplayFanOutV1 | null;
}

/** One verified `(platform, scope, family)` unit: its count, digest, basis kind and steps. */
interface ProvenUnit {
  readonly observed: number;
  readonly idSetDigest: string;
  readonly kind: ProvingBasisKind;
  /** Every step exhausted (a signed statement is exhausted by definition: `end_of_list`). */
  readonly exhausted: boolean;
  /** L3 r3: the replay steps, verified; `[]` for a signed unit. */
  readonly steps: readonly VerifiedStep[];
}

/** A unit either verifies or names the ONE reason it does not (the first failing check). */
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
  /** L3 r3: every counting platform exhausted every step (else the count is `observed`). */
  exhausted: boolean;
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

/**
 * The staged digest of one step token for the platform. `undefined` when the caller supplied no
 * staged facts for the platform at all (nothing staged: every step is the empty set); `null`
 * when the platform was staged but this step has no digest (unknown, never 0).
 */
type StagedStepLookup = (stepKey: string) => IdentitySetDigest | null;

/** E2-E5 for one `(platform, scope, family)` unit; the verified unit, or the reason it is not. */
function proveUnit(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  run: RunBinding,
  challenge: Buffer,
  index: IndexedObservations,
  stagedStep: StagedStepLookup,
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
      return proveReplayTerminalEnumeration(
        pkg,
        platform,
        scope,
        family,
        challenge,
        parsed,
        stagedStep,
      );
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
      exhausted: true,
      steps: [],
    },
  };
}

/**
 * L3 E4 for `replay_terminal_enumeration` (L0 r5 D-L0-6). The evidence must name this unit and
 * the run's declaration challenge and report EXACTLY the step set the pinned package maps to the
 * family (the family token alone when the spec maps no step to it); a missing, extra or
 * duplicate step key is unknown. Per step, in this order: a synthetic or missing id is
 * `identity_unproven`; `raw_items` not exactly the sum of the four identity counters (r4) is
 * `evidence_inconsistent`; a `budget`/`cycle`/`error` stop is `crawl_truncated`; a step that
 * fetched no page (a root step, or a fan-out with contexts to visit) is `zero_pages_fetched`;
 * fan-out counters that contradict each other or the pages are `fan_out_short`; an `empty_page`
 * stop whose page counts cannot hold the fetched empty terminal page (r4: root `pages_fetched <
 * 2`, fan-out `pages_fetched <= contexts_fetched`, with items) is `evidence_inconsistent`. The
 * family totals must be consistent with the steps (a single step
 * IS the family). Then every step's `id_set_digest` and `distinct_raw_ids` must equal the staged
 * rows of that step (`staged_digest_missing` / `step_staged_mismatch`) — that is what makes a
 * multi-step union and a fan-out's parent id set verifiable. The unit is `exhausted` iff every step
 * stopped at `empty_page`/`absent_next`, advertised no next link, had no refused page and, for a
 * fan-out, fetched and exhausted every expected context; otherwise the count is at most
 * `observed`. The parent binding of every fan-out (digest, count, no self/cycle, chain to a root
 * step) and the E6 equality with the staged family are the caller's.
 */
function proveReplayTerminalEnumeration(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  challenge: Buffer,
  parsed: ParsedReplayTerminalEvidence,
  stagedStep: StagedStepLookup,
): UnitResult {
  const { evidence } = parsed;
  if (evidence.source_platform !== platform) return unproven('evidence_unbound');
  if (evidence.account_scope_id_digest !== scope) return unproven('evidence_unbound');
  if (evidence.family !== family) return unproven('evidence_unbound');
  if (!parsed.challenge.equals(challenge)) return unproven('evidence_unbound');
  if (!isCanonicalFamily(family)) return unproven('evidence_unbound');

  // r5: every step of the pinned package feeding the family, nothing else; the family token is a
  // step only when the spec maps no other step to the family (a canonical-token collection).
  const specSteps = pkg.stepsByFamily.get(family) ?? [];
  const expected = specSteps.length > 0 ? specSteps : [family];
  const reported = evidence.steps.map((s) => s.step_key);
  if (!sameSet(reported, expected)) return unproven('step_set_mismatch');

  // The row's own consistency first (no staged data needed), then every step against staging.
  let distinctSum = 0;
  for (const step of evidence.steps) {
    if (step.synthetic_ids !== 0 || step.missing_id_items !== 0) {
      return unproven('identity_unproven');
    }
    // L3 r4 (`R589-c7A2-01`; L0 r7 D-L0-4 C0 `raw_items == distinct_raw_ids + duplicate_ids`):
    // EXACT accounting. Every reported item is exactly one of a first-seen staged identity, a
    // repeat of one, a synthetic id or an item without an id; an item outside that partition has
    // no accounted identity, so the count it would support is unknown, never `proven`.
    if (!exactlyAccounted(step)) return unproven('evidence_inconsistent');
    if (REPLAY_ABORTED_STOPS.includes(step.stop)) return unproven('crawl_truncated');
    const fan = step.fan_out;
    if (fan === null) {
      if (step.pages_fetched < 1) return unproven('zero_pages_fetched');
    } else {
      if (fan.contexts_fetched > fan.contexts_expected) return unproven('fan_out_short');
      if (fan.contexts_exhausted > fan.contexts_fetched) return unproven('fan_out_short');
      if (step.pages_fetched < fan.contexts_fetched) return unproven('fan_out_short');
      // A fan-out with contexts to visit that fetched no page observed nothing (unknown, never 0).
      if (fan.contexts_expected > 0 && step.pages_fetched < 1) return unproven('zero_pages_fetched');
    }
    // L3 r4 (`R589-c7B2-02`): `empty_page` is proof only when the evidence can contain a FETCHED
    // empty terminal page. `pages_fetched` counts that page, so a step that held items needs a
    // page beyond the ones that held them: root `pages_fetched >= 2`; fan-out `pages_fetched >
    // contexts_fetched` (every context that held items ended on its own empty page). A single
    // 17-item page labelled `empty_page` is the L15 first page under another name: inconsistent.
    if (!emptyPageConsistent(step)) return unproven('evidence_inconsistent');
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
  // L3 r3: every step's own identities against the rows staged under its token — the check
  // that makes a multi-step union and a fan-out's parent id set verifiable.
  const steps: VerifiedStep[] = [];
  let exhausted = true;
  for (const step of evidence.steps) {
    const stagedDigest = stagedStep(step.step_key);
    if (stagedDigest === null) return unproven('staged_digest_missing');
    if (stagedDigest.digest !== step.id_set_digest || stagedDigest.count !== step.distinct_raw_ids) {
      return unproven('step_staged_mismatch');
    }
    const fan = step.fan_out;
    const stepExhausted =
      REPLAY_EXHAUSTED_STOPS.includes(step.stop) &&
      !step.advertised_next &&
      step.refused_pages === 0 &&
      (fan === null ||
        (fan.contexts_fetched === fan.contexts_expected &&
          fan.contexts_exhausted === fan.contexts_expected));
    exhausted = exhausted && stepExhausted;
    steps.push({
      stepKey: step.step_key,
      count: step.distinct_raw_ids,
      digest: step.id_set_digest,
      exhausted: stepExhausted,
      fanOut: fan,
    });
  }
  return {
    ok: true,
    unit: {
      observed: evidence.observed_unique,
      idSetDigest: evidence.id_set_digest,
      kind: REPLAY_KIND,
      exhausted,
      steps,
    },
  };
}

/** L3 r4: `raw_items` is exactly partitioned by the four identity counters (D-L0-4 C0). */
function exactlyAccounted(step: ReplayStepEvidenceV1): boolean {
  const accounted =
    step.distinct_raw_ids + step.duplicate_ids + step.synthetic_ids + step.missing_id_items;
  return Number.isSafeInteger(accounted) && accounted === step.raw_items;
}

/**
 * L3 r4: a step stopped at `empty_page` reports page counts that can hold the fetched empty
 * terminal page (`pages_fetched` includes it; `contract.ts` `ReplayStepEvidenceV1.pages_fetched`).
 * A step that held no item may have fetched only the empty page itself.
 */
function emptyPageConsistent(step: ReplayStepEvidenceV1): boolean {
  if (step.stop !== 'empty_page' || step.raw_items === 0) return true;
  const fan = step.fan_out;
  return fan === null ? step.pages_fetched >= 2 : step.pages_fetched > fan.contexts_fetched;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && left.size === new Set(b).size && b.every((v) => left.has(v));
}

/** One platform's provisional per-family proof, before fan-out binding and accumulation. */
interface PlatformFamilyProof {
  unit: ProvenUnit;
  readonly covers: boolean;
}

/** A verified step of the platform, with the family whose unit it belongs to. */
interface IndexedStep {
  readonly family: string;
  readonly step: VerifiedStep;
}

/**
 * L3 r3: every verified step of the platform by step key. A key verified in two units is
 * ambiguous and is dropped (no fan-out can bind to it).
 */
function indexSteps(proofs: ReadonlyMap<string, PlatformFamilyProof>): Map<string, IndexedStep> {
  const index = new Map<string, IndexedStep>();
  const ambiguous = new Set<string>();
  for (const [family, proof] of proofs) {
    for (const step of proof.unit.steps) {
      if (index.has(step.stepKey)) ambiguous.add(step.stepKey);
      else index.set(step.stepKey, { family, step });
    }
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

/**
 * L3 r3 (L0 r5 D-L0-6 "Fan-out"; `R589-c7A-03`, `R589-c7B-02`): the parent binding of one
 * fan-out step against the platform's verified steps. The parent must be a verified step of
 * another family-unit or the same one, its digest must equal `parent_ids_digest` and its count
 * `contexts_expected`, and following parents must reach a root step without revisiting a step
 * (no self-parent, no cycle). Returns the reason it does not, or the parent chain's families.
 */
function bindFanOut(
  own: string,
  step: VerifiedStep,
  index: ReadonlyMap<string, IndexedStep>,
): { readonly ok: true; readonly parents: readonly string[] } | { readonly ok: false; readonly code: CoverageReasonCode } {
  const visited = new Set<string>([step.stepKey]);
  const parents: string[] = [];
  let current: VerifiedStep = step;
  while (current.fanOut !== null) {
    const parent = index.get(current.fanOut.parent_step);
    if (parent === undefined) return { ok: false, code: 'fan_out_parent_unproven' };
    if (visited.has(parent.step.stepKey)) return { ok: false, code: 'fan_out_cycle' };
    if (current.fanOut.parent_ids_digest !== parent.step.digest) {
      return { ok: false, code: 'fan_out_parent_mismatch' };
    }
    if (current.fanOut.contexts_expected !== parent.step.count) {
      return { ok: false, code: 'fan_out_count_mismatch' };
    }
    visited.add(parent.step.stepKey);
    if (parent.family !== own) parents.push(parent.family);
    current = parent.step;
  }
  return { ok: true, parents };
}

function evaluate(input: CoverageEvaluationInput): CoverageEvaluation {
  const acc = new Map<string, FamilyAccumulator>();
  const touch = (family: string): FamilyAccumulator => {
    let entry = acc.get(family);
    if (entry === undefined) {
      entry = { failed: false, observed: 0, covers: true, exhausted: true, kind: null, reasons: [] };
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
    // L3 r3: the staged rows of one step token. Nothing staged for the platform at all → every
    // step is the empty set (like the family rule below); staged but no digest for the token →
    // unknown. A non-Map `steps` (hostile input) reads as "no digest".
    const stepDigests = stagedFacts?.steps;
    const stagedStep: StagedStepLookup = (stepKey) => {
      if (stagedFacts === undefined) return { digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 };
      if (!(stepDigests instanceof Map)) return null;
      return stepDigests.get(stepKey) ?? null;
    };

    // Pass 1: per family, the unit proof (E2-E5) and the staged-side equality (E6).
    const proofs = new Map<string, PlatformFamilyProof>();
    for (const family of families) {
      let observed = 0;
      let unit: ProvenUnit | null = null;
      let unitDigest: string | null = null;
      let unitCode: CoverageReasonCode | null = null;
      for (const scope of scopes) {
        const result = proveUnit(
          pkg,
          platform,
          scope,
          family,
          run,
          declaration.challenge,
          index,
          stagedStep,
        );
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

    // Pass 2 (L3 r3, L0 r5 D-L0-6 "Fan-out"): bind every fan-out step to its parent step's
    // VERIFIED id set among this platform's units — digest, count, no self-parent, no cycle, a
    // chain that ends in a root step. A failed parent family unproves the child, so the pass
    // repeats until nothing changes (bounded by the family count).
    let changed = true;
    while (changed) {
      changed = false;
      const stepIndex = indexSteps(proofs);
      for (const [family, proof] of proofs) {
        for (const step of proof.unit.steps) {
          if (step.fanOut === null) continue;
          const bound = bindFanOut(family, step, stepIndex);
          if (bound.ok) continue;
          fail(family, bound.code, platform);
          proofs.delete(family);
          changed = true;
          break;
        }
        if (changed) break;
      }
    }
    // Pass 3: a fan-out over a parent that is only observed (not exhausted) cannot itself be
    // proven — its context set is the parent's incomplete list. Propagate until stable.
    const stepIndex = indexSteps(proofs);
    changed = true;
    while (changed) {
      changed = false;
      for (const [family, proof] of proofs) {
        if (!proof.unit.exhausted) continue;
        for (const step of proof.unit.steps) {
          if (step.fanOut === null) continue;
          const bound = bindFanOut(family, step, stepIndex);
          const parentsExhausted =
            bound.ok && bound.parents.every((p) => proofs.get(p)?.unit.exhausted === true);
          if (parentsExhausted) continue;
          proof.unit = { ...proof.unit, exhausted: false };
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
      entry.exhausted = entry.exhausted && proof.unit.exhausted;
      if (!proof.unit.exhausted) note(family, 'list_not_exhausted', platform);
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
      // Executive reset 2026-09-29 §1: a SOURCE COUNT (r5: `proven` when every list is positively
      // exhausted, `observed` when every list was fetched but not all exhausted), never a
      // run-level basis — no completeness closure exists for any package, so the reconciler
      // never sees this kind.
      out[family] = { known: false };
      note(family, 'completeness_not_proven', null);
      families[family] = Object.freeze({
        source_count: entry.observed,
        count_basis: entry.exhausted ? 'proven' : 'observed',
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
