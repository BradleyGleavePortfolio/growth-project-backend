import {
  type ClaimStatus,
  COMPLETENESS_BASIS_NONE,
  type CoverageFact,
  type ReconciliationFacts,
} from './types';

// S9-A — the F1 completeness predicate (D-S9-3), isolated so that S10's observation contract
// lands here without a change to `reconcile.ts`. Parent S9 decision: `complete` requires a
// recorded per-family completeness basis; until S10 supplies one, no run reaches `complete` on
// native reconciliation alone. PLAN L321: "If the platform provides no reliable completeness
// basis, final status remains incomplete". A non-success or absent claim is a signal against
// coverage, never a basis for it.

/** What the report says about one family's coverage (CQ-13 manifest fields). */
export interface FamilyCoverage {
  readonly known: boolean;
  /** `'none'` when unknown; otherwise the S10 basis kind. */
  readonly completeness_basis: string;
  readonly observed_unique: number | null;
}

const UNKNOWN: FamilyCoverage = {
  known: false,
  completeness_basis: COMPLETENESS_BASIS_NONE,
  observed_unique: null,
};

/**
 * `coverageKnown(f)` holds when all of these are true: `coverage !== null`, `coverage[f].known`,
 * `covers_staged_identities` (an identity-set statement S10 establishes, not a count) and a stored
 * claim of `success`. The predicate reads only these; S10 adds evaluator, basis kinds and any
 * additive fields on the `known: true` branch.
 */
export function familyCoverage(fact: CoverageFact | undefined, claim: ClaimStatus): FamilyCoverage {
  if (fact === undefined || !fact.known) return UNKNOWN;
  if (!fact.covers_staged_identities || claim !== 'success') {
    // The observation exists but does not vouch for the staged set (or the claim contradicts
    // it): the count is a fact worth showing, the basis is not one worth trusting.
    return {
      known: false,
      completeness_basis: COMPLETENESS_BASIS_NONE,
      observed_unique: fact.observed_unique,
    };
  }
  return {
    known: true,
    completeness_basis: fact.basis_kind,
    observed_unique: fact.observed_unique,
  };
}

/** Coverage for one family name out of the run facts (`coverage: null` → unknown). */
export const coverageOf = (facts: ReconciliationFacts, family: string): FamilyCoverage =>
  familyCoverage(facts.coverage === null ? undefined : facts.coverage[family], facts.claim);

/**
 * D-S9-2 `required_families`: the canonical families of the staged mapped entries ∪ the families
 * the coverage map names ∪ every family the mapping spec declares. `null` (undeterminable) when
 * the run has zero staged identities or no staged row named a registered platform
 * (`spec_families === null`), so the set never depends only on what the evaluator lists and an
 * empty run is never vacuously complete (R18, R18b). Sorted for determinism.
 */
export function requiredFamilies(facts: ReconciliationFacts): readonly string[] | null {
  const staged = facts.families.reduce((sum, f) => sum + f.identities.length, 0);
  if (staged === 0 || facts.spec_families === null) return null;
  const names = new Set<string>(facts.spec_families);
  for (const f of facts.families) if (f.mapped) names.add(f.family);
  if (facts.coverage !== null) for (const name of Object.keys(facts.coverage)) names.add(name);
  return Array.from(names).sort();
}

/**
 * C-COV holds (the run is NOT covered) when `required_families` is undeterminable or empty, when
 * any required family lacks a known basis, or when the stored claim is not `success` (the claim is
 * already folded into `familyCoverage`, so an empty required set is the only extra case).
 */
export const coverageConditionHolds = (facts: ReconciliationFacts): boolean => {
  const required = requiredFamilies(facts);
  if (required === null || required.length === 0) return true;
  return required.some((f) => !coverageOf(facts, f).known);
};
