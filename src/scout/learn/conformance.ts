/**
 * L1 (D-L0-4 "Per-family and per-record enforcement", r7 `R581-c7A-07`, `R581-c7B-04`) — **C0
 * identity conformance, evaluated PER FAMILY**, as a pure, total function. Slice L2c wires it
 * into the one locked transaction before `reconstructRun` and persists the outcome on the pin
 * (`pin.conformance`, write-once per `execution_epoch`); nothing here touches a row, a lock or a
 * status. C1-C4 (per record, effective parent set) are L2c's; C5/C6 are EX1's.
 *
 * Per family, over the union of the steps and `:q` variants feeding it:
 *   Σ raw_items == Σ distinct_raw_ids + Σ duplicate_ids, Σ synthetic_ids == 0, and the union's
 *   distinct id-set size == the staged distinct `(entity_type, source_id)` count.
 * A family that fails is DROPPED for this run: zero writes for it, its staged identities
 * disclosed as `not_moved: identity_conflict` with a count (= staged distinct identities), and —
 * only when the family had raw items (D-L0-5: "C0 failure with non-zero raw items") — the
 * structural trigger `conformance_identity` recorded. Every other family proceeds. The package
 * as a whole is never refused here. No reason code or status field is added: the outcomes below
 * are consumed by L2c/L2d, which own `not_moved[]` and `INVALIDATION_TRIGGERS`.
 */

/** Engine evidence of one step (or one `:q` variant) feeding a family (D-L0-6 per-step evidence). */
export interface StepIdentityEvidence {
  readonly family: string;
  readonly rawItems: number;
  readonly distinctRawIds: number;
  readonly duplicateIds: number;
  /** Learned packages never synthesise ids; any count here is a conformance failure. */
  readonly syntheticIds: number;
}

/** Per-family counts the steps cannot supply alone (ids may repeat across steps of one family). */
export interface FamilyIdentityCounts {
  readonly family: string;
  /** Size of the distinct id set over every step feeding the family (engine, composed per idScope). */
  readonly unionDistinctIds: number;
  /** Staged distinct `(entity_type, source_id)` rows for the family (facts service). */
  readonly stagedDistinctIdentities: number;
}

export type C0Failure =
  | 'evidence_missing'
  | 'malformed_counts'
  | 'items_not_partitioned'
  | 'synthetic_ids'
  | 'staged_mismatch';

export interface FamilyC0Outcome {
  readonly family: string;
  readonly outcome: 'passed' | 'dropped';
  /** Every failed predicate, in evaluation order; empty when passed. */
  readonly failures: readonly C0Failure[];
  /** `not_moved: identity_conflict` count for a dropped family (its staged distinct identities). */
  readonly identityConflicts: number;
  /** D-L0-5: a structural trigger only when the failing family had raw items. */
  readonly trigger: 'conformance_identity' | null;
  readonly rawItems: number;
  readonly stepCount: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * C0 over every family named by either input, sorted by family. Total: malformed or missing
 * evidence drops that family (fail closed) and never throws or affects another family.
 */
export function checkIdentityConformance(
  steps: readonly StepIdentityEvidence[],
  counts: readonly FamilyIdentityCounts[],
): readonly FamilyC0Outcome[] {
  const families = [...new Set([...steps.map((s) => s.family), ...counts.map((c) => c.family)])]
    .filter((f) => typeof f === 'string' && f.length > 0)
    .sort(compareText);
  return Object.freeze(
    families.map((family) => {
      const feeding = steps.filter((s) => s.family === family);
      const familyCounts = counts.filter((c) => c.family === family);
      const failures: C0Failure[] = [];
      const wellFormed =
        feeding.every(
          (s) =>
            isCount(s.rawItems) &&
            isCount(s.distinctRawIds) &&
            isCount(s.duplicateIds) &&
            isCount(s.syntheticIds),
        ) &&
        familyCounts.every(
          (c) => isCount(c.unionDistinctIds) && isCount(c.stagedDistinctIdentities),
        );
      if (!wellFormed) failures.push('malformed_counts');
      if (familyCounts.length !== 1) failures.push('evidence_missing');
      const sum = (pick: (s: StepIdentityEvidence) => number): number =>
        wellFormed ? feeding.reduce((acc, s) => acc + pick(s), 0) : 0;
      const rawItems = sum((s) => s.rawItems);
      const staged =
        wellFormed && familyCounts.length === 1 ? familyCounts[0].stagedDistinctIdentities : 0;
      if (wellFormed && familyCounts.length === 1) {
        if (rawItems !== sum((s) => s.distinctRawIds) + sum((s) => s.duplicateIds))
          failures.push('items_not_partitioned');
        if (sum((s) => s.syntheticIds) !== 0) failures.push('synthetic_ids');
        if (familyCounts[0].unionDistinctIds !== staged) failures.push('staged_mismatch');
      }
      const dropped = failures.length > 0;
      return Object.freeze({
        family,
        outcome: dropped ? 'dropped' : 'passed',
        failures: Object.freeze(failures),
        identityConflicts: dropped ? staged : 0,
        trigger: dropped && rawItems > 0 ? 'conformance_identity' : null,
        rawItems,
        stepCount: feeding.length,
      } as const);
    }),
  );
}

/** The families a run drops at C0 (zero writes for them; every other family proceeds). */
export function droppedFamilies(outcomes: readonly FamilyC0Outcome[]): readonly string[] {
  return Object.freeze(outcomes.filter((o) => o.outcome === 'dropped').map((o) => o.family));
}
