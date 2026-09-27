import { verify as cryptoVerify, type KeyObject } from 'crypto';
import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';
import type { CoverageFact } from '../reconciliation/types';
import { isCanonicalPlatform } from '../scout-platform';
import { CHALLENGE_BYTES, type ProvingBasisKind } from './contract';
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
} from './parse';

// S10-A — the pure server evaluator (D-S10-3). No I/O, no clock, no exceptions (like
// `arbiter.ts`): every input it cannot prove yields `{known: false}`, never a count of 0. It
// dispatches on `basis_kind` only and never on a source name (D-S10-8).

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

const PROVEN_KIND: ProvingBasisKind = 'source_signed_enumeration';

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

/** E2-E5 for one `(platform, scope, family)` unit; the proven count, or `null`. */
function proveUnit(
  pkg: InductionPackage,
  platform: string,
  scope: string,
  family: string,
  run: RunBinding,
  challenge: Buffer,
  index: IndexedObservations,
): number | null {
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

  switch (evidence.basis_kind) {
    case PROVEN_KIND:
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
  parsed: ParsedEvidence,
): number | null {
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
  return statement.observed_unique;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  return left.size === a.length && left.size === new Set(b).size && b.every((v) => left.has(v));
}

function evaluate(input: CoverageEvaluationInput): Readonly<Record<string, CoverageFact>> {
  const acc = new Map<string, FamilyAccumulator>();
  const touch = (family: string): FamilyAccumulator => {
    let entry = acc.get(family);
    if (entry === undefined) {
      entry = { failed: false, observed: 0, covers: true };
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
    // E1 (manifest), E6 (partition agreement; multi-scope attribution deferred in v1).
    const platformUnprovable =
      declaration === null || pkg === undefined || !partitionAgrees || scopes.length !== 1;

    for (const family of families) {
      if (platformUnprovable || pkg === undefined || declaration === null) {
        fail(family);
        continue;
      }
      let observed = 0;
      let proven = true;
      for (const scope of scopes) {
        const count = proveUnit(pkg, platform, scope, family, run, declaration.challenge, index);
        if (count === null) proven = false;
        else observed += count;
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
      if (!proven || stagedDigest === null || stagedDigest === undefined) {
        fail(family);
        continue;
      }
      // E6: the single scope's statement against the platform's staged identities.
      const unit = index.byUnit.get(unitKey(platform, scopes[0], family))?.[0];
      const statementDigest = unit?.parsed.parsedStatement.statement.id_set_digest;
      const covers = statementDigest === stagedDigest.digest;
      if (covers && observed !== stagedDigest.count) {
        fail(family); // equal digest, unequal count: inconsistent
        continue;
      }
      const entry = touch(family);
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
    if (entry === undefined || entry.failed) {
      out[family] = { known: false };
      continue;
    }
    out[family] = {
      known: true,
      basis_kind: PROVEN_KIND,
      observed_unique: entry.observed,
      covers_staged_identities: entry.covers,
    };
  }
  return Object.freeze(out);
}

/**
 * D-S10-3 `evaluateCoverage`: per emitted family (every `expectedFamilies` entry of every
 * declared platform, plus every family of an undeclared staged platform) the S9 `CoverageFact`.
 * Total: an unexpected failure yields `{known: false}` for every canonical family.
 */
export function evaluateCoverage(
  input: CoverageEvaluationInput,
): Readonly<Record<string, CoverageFact>> {
  try {
    return evaluate(input);
  } catch {
    const out: Record<string, CoverageFact> = {};
    for (const family of CANONICAL_FAMILIES) out[family] = { known: false };
    return Object.freeze(out);
  }
}
