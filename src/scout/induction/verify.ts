import { verify as cryptoVerify, type KeyObject } from 'crypto';
import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';
import type { CoverageFact } from '../reconciliation/types';
import { isCanonicalPlatform } from '../scout-platform';
import { evaluateFamilySetClosure, type ClosureVerdict } from './closure';
import {
  CHALLENGE_BYTES,
  REPLAY_TERMINAL_STOPS,
  type FamilySetClosureV1,
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
// L3 (owner D1, 2026-09-28) adds two things, both fail-closed:
// - the `replay_terminal_enumeration` rule (`proveReplayTerminalEnumeration`): the extension's
//   per-step terminal statement, bound to the run's challenge and proven only by digest AND count
//   equality with the staged side (E6); any budget stop, refused page, retry exhaustion, fan-out
//   short of its id set, a step set short of the spec's, or a digest/count mismatch is unknown;
// - family-set closure (`closure.ts`): a declared platform whose pinned package's closure record
//   is missing (`null`, the default) or not closed has every family unknown, so the run settles
//   `partial/coverage_basis_unknown` through the existing reason channel.

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
  /**
   * L3: the closure record of every declared platform's pinned package (`closure.ts`). Default
   * `null` = NOT known: every declared platform's families are unknown and the run cannot be
   * `complete`. A platform without a record is likewise unknown. File packages use
   * `reviewedPackageClosures(registry)`; a learned package (L2) supplies its `observed_templates`
   * record or `null`.
   */
  readonly closure?: readonly FamilySetClosureV1[] | null;
}

/** `evaluateCoverage` plus the per-platform closure verdicts (named gaps for the caller). */
export interface CoverageEvaluation {
  readonly facts: Readonly<Record<string, CoverageFact>>;
  /** Keyed by declared platform; absent for a platform without a package. */
  readonly closure: Readonly<Record<string, ClosureVerdict>>;
}

const SIGNED_KIND = 'source_signed_enumeration' as const;
const REPLAY_KIND = 'replay_terminal_enumeration' as const;

/** One proven `(platform, scope, family)` unit: its verified count, digest and basis kind. */
interface ProvenUnit {
  readonly observed: number;
  readonly idSetDigest: string;
  readonly kind: ProvingBasisKind;
}

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

/** E2-E5 for one `(platform, scope, family)` unit; the proven unit, or `null`. */
function proveUnit(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  run: RunBinding,
  challenge: Buffer,
  index: IndexedObservations,
): ProvenUnit | null {
  const key = unitKey(platform, scope, family);
  if (index.poisonedAll || index.poisonedUnits.has(key)) return null;
  // E2: exactly one row; an absent row is unknown, never 0.
  const rows = index.byUnit.get(key) ?? [];
  if (rows.length !== 1) return null;
  const { row, parsed } = rows[0];
  const { evidence } = parsed;

  // E3: binding to the settling run, the manifest, the family's kinds and the loaded spec.
  if (row.coach_id !== run.coach_id || row.intent_id !== run.intent_id) return null;
  if (!isSafeEpoch(row.execution_epoch) || row.execution_epoch !== run.execution_epoch) return null;
  if (!isCanonicalFamily(family) || !pkg.manifest.expectedFamilies.includes(family)) return null;
  const kinds = pkg.manifest.basisKinds[family] ?? [];
  if (!kinds.includes(evidence.basis_kind)) return null;
  if (evidence.mapping_spec_digest !== pkg.specDigest) return null;

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
      return null;
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
): ProvenUnit | null {
  const verifier = pkg.manifest.verifiers.find((v) => v.key_id === parsed.evidence.key_id);
  if (verifier === undefined) return null;
  const raw = decodeBase64Strict(verifier.public_key_b64);
  const key = raw === null ? null : ed25519PublicKey(raw);
  if (key === null) return null;
  if (!verifyEd25519(key, parsed.statementBytes, parsed.signature)) return null;

  const { statement, issuedAt } = parsed.parsedStatement;
  if (statement.source_platform !== platform) return null;
  if (statement.account_scope_id_digest !== scope) return null;
  if (statement.family !== family) return null;
  if (!parsed.parsedStatement.challenge.equals(challenge)) return null;
  if (statement.date_window !== null || statement.terminal !== 'end_of_list') return null;
  if (!isValidDate(run.accepted_start_at) || !isValidDate(row.received_at)) return null;
  if (issuedAt.floorMs < run.accepted_start_at.getTime()) return null;
  if (issuedAt.ceilMs > row.received_at.getTime()) return null;
  // E5.
  return {
    observed: statement.observed_unique,
    idSetDigest: statement.id_set_digest,
    kind: SIGNED_KIND,
  };
}

/**
 * L3 E4 for `replay_terminal_enumeration` (L0 D-L0-6 "How a learned source earns a basis"). The
 * evidence must name this unit and the run's declaration challenge, and report a terminal for
 * every collection step the pinned spec maps to the family (a canonical-token collection may
 * appear as the family token). Every step must have stopped at a pagination terminal
 * (`short_page` | `absent_next`) below its page budget, with zero refused pages, and a fan-out step
 * must have fetched every expected page. Anything else is a truncated crawl: unknown, never 0.
 * The count and digest are proven against the staged side by the caller (E6, equality only).
 */
function proveReplayTerminalEnumeration(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  challenge: Buffer,
  parsed: ParsedReplayTerminalEvidence,
): ProvenUnit | null {
  const { evidence } = parsed;
  if (evidence.source_platform !== platform) return null;
  if (evidence.account_scope_id_digest !== scope) return null;
  if (evidence.family !== family) return null;
  if (!parsed.challenge.equals(challenge)) return null;
  if (!isCanonicalFamily(family)) return null;

  const specSteps = pkg.stepsByFamily.get(family) ?? [];
  const reported = new Set(evidence.steps.map((s) => s.step));
  // Every spec step feeding the family needs a terminal; no step outside the spec (or the
  // family's own token) may be reported.
  if (!specSteps.every((step) => reported.has(step))) return null;
  for (const step of reported) {
    if (step !== family && !specSteps.includes(step)) return null;
  }
  for (const step of evidence.steps) {
    if (!REPLAY_TERMINAL_STOPS.includes(step.stop)) return null;
    if (step.refused_pages !== 0) return null;
    if (step.pages_fetched >= step.max_pages) return null; // hit `maxPagesPerStep`
    if (step.fan_out !== null && step.fan_out.fetched !== step.fan_out.expected) return null;
  }
  return {
    observed: evidence.observed_unique,
    idSetDigest: evidence.id_set_digest,
    kind: REPLAY_KIND,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && left.size === new Set(b).size && b.every((v) => left.has(v));
}

function evaluate(input: CoverageEvaluationInput): CoverageEvaluation {
  const acc = new Map<string, FamilyAccumulator>();
  const closureVerdicts: Record<string, ClosureVerdict> = {};
  const touch = (family: string): FamilyAccumulator => {
    let entry = acc.get(family);
    if (entry === undefined) {
      entry = { failed: false, observed: 0, covers: true, kind: null };
      acc.set(family, entry);
    }
    return entry;
  };
  const fail = (family: string): void => {
    if (isCanonicalFamily(family)) touch(family).failed = true;
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

  // L3: closure records by platform; a platform listed twice is a contradiction (unknown).
  const closures = new Map<string, FamilySetClosureV1 | null>();
  const closureList = input.closure ?? null;
  if (closureList !== null && isArrayValue(closureList)) {
    for (const record of closureList) {
      if (record === null || typeof record !== 'object') continue;
      const platform: unknown = record.source_platform;
      if (typeof platform !== 'string') continue;
      closures.set(platform, closures.has(platform) ? null : record);
    }
  }

  const declaredScopes = declaration?.scopes ?? new Map<string, readonly string[]>();
  for (const [platform, scopes] of declaredScopes) {
    const pkg = registry.packages.get(platform);
    const families: readonly string[] =
      pkg?.manifest.expectedFamilies ?? registry.specFamilies.get(platform) ?? CANONICAL_FAMILIES;
    // L3: family-set closure of the pinned package (null/absent = not known = unknown).
    const closure =
      pkg === undefined ? null : evaluateFamilySetClosure(closures.get(platform), platform, pkg);
    if (closure !== null) closureVerdicts[platform] = closure;
    const stagedEntry = staged.get(platform);
    const stagedFacts = stagedEntry?.kind === 'facts' ? stagedEntry.facts : undefined;
    // A 'conflict' entry has no facts, so it never agrees.
    const partitionAgrees =
      stagedEntry === undefined ||
      (stagedFacts !== undefined &&
        sameSet(stagedFacts.grouped_families, families) &&
        [...stagedFacts.families.keys()].every((f) => families.includes(f)));
    // E1 (manifest), E6 (partition agreement; multi-scope attribution deferred in v1).
    const platformUnprovable =
      declaration === null ||
      pkg === undefined ||
      !partitionAgrees ||
      scopes.length !== 1 ||
      closure === null ||
      !closure.closed;

    for (const family of families) {
      if (platformUnprovable || pkg === undefined || declaration === null) {
        fail(family);
        continue;
      }
      let observed = 0;
      let proven = true;
      let unitKind: ProvingBasisKind | null = null;
      let unitDigest: string | null = null;
      for (const scope of scopes) {
        const unit = proveUnit(pkg, platform, scope, family, run, declaration.challenge, index);
        if (unit === null) proven = false;
        else {
          observed += unit.observed;
          unitKind = unit.kind;
          unitDigest = unit.idSetDigest;
        }
      }
      // A grouped family missing from the digest map is unknown, never zero.
      if (
        stagedFacts !== undefined &&
        stagedFacts.grouped_families.includes(family) &&
        !stagedFacts.families.has(family)
      ) {
        fail(family);
        continue;
      }
      // Only a family absent from both (genuinely not staged) is the empty identity set.
      const stagedDigest =
        stagedFacts !== undefined && stagedFacts.families.has(family)
          ? stagedFacts.families.get(family)
          : { digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 };
      if (!proven || unitKind === null || stagedDigest === null || stagedDigest === undefined) {
        fail(family);
        continue;
      }
      // E6: the single scope's evidence digest against the platform's staged identities.
      const covers = unitDigest === stagedDigest.digest;
      if (covers && observed !== stagedDigest.count) {
        fail(family); // equal digest, unequal count: inconsistent
        continue;
      }
      // L3: an observer-asserted count is a fact only when it equals the staged set exactly.
      if (unitKind === REPLAY_KIND && !covers) {
        fail(family);
        continue;
      }
      const entry = touch(family);
      if (entry.kind !== null && entry.kind !== unitKind) {
        entry.failed = true; // two basis kinds in one family: no single truthful `basis_kind`
        continue;
      }
      entry.kind = unitKind;
      entry.observed += observed;
      entry.covers = entry.covers && covers;
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
    families.forEach(fail);
  }

  const out: Record<string, CoverageFact> = {};
  for (const family of [...acc.keys()].sort()) {
    const entry = acc.get(family);
    if (entry === undefined || entry.failed || entry.kind === null) {
      out[family] = { known: false };
      continue;
    }
    out[family] = {
      known: true,
      basis_kind: entry.kind,
      observed_unique: entry.observed,
      covers_staged_identities: entry.covers,
    };
  }
  return { facts: Object.freeze(out), closure: Object.freeze(closureVerdicts) };
}

function allUnknown(): Readonly<Record<string, CoverageFact>> {
  const out: Record<string, CoverageFact> = {};
  for (const family of CANONICAL_FAMILIES) out[family] = { known: false };
  return Object.freeze(out);
}

/**
 * `evaluateCoverage` with the per-platform closure verdicts beside the facts, so the caller can
 * record the named gaps. Total: an unexpected failure yields `{known: false}` for every
 * canonical family and no closure verdict.
 */
export function evaluateCoverageDetailed(input: CoverageEvaluationInput): CoverageEvaluation {
  try {
    return evaluate(input);
  } catch {
    return { facts: allUnknown(), closure: Object.freeze({}) };
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
