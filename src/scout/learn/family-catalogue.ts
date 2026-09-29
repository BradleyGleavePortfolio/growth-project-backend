import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';

/**
 * L1 (D-L0-4 V-L4; D-L0-9 L1 owed item 3; FAM-0 r9 D-FAM-1) — the family catalogue BINDING.
 *
 * FAM-C1 is the ONE owner of the family catalogue module (L0 r7 `R581-c7B-05`; FAM-0 r9 §7 row
 * 1). At this head FAM-C1 has not landed: `integration/importer` carries no catalogue module and
 * FAM-0 (PR #590) is a decision record without code. L1 therefore defines only the minimum
 * contract SURFACE it consumes (`FamilyCatalogueV1`) and binds it in THIS ONE FILE to an interim
 * table transcribed from FAM-0 r9 D-FAM-1 (`0924fc15`, the family column of the catalogue
 * table). No other L1 module names a family: `contract-vocabulary.ts`, `canonical-contract.ts`,
 * `digest-contract.ts`, `proposal.ts` and `package.ts` import from here. When FAM-C1 lands this
 * file becomes a re-export of its module and `INTERIM_FAM0_R9_LABELS` is deleted; the test
 * `family-catalogue.spec.ts` pins the interim table to the record so the two cannot drift
 * silently. The PR body marks the hard dependency (D-L0-9 graph: FAM-C1 → L1).
 *
 * The catalogue is classification only: the model proposes a label, never a destination
 * (`destinationFor` is FAM-C1's pure function, consumed by L2c, not by this slice).
 */

/** Where the bound catalogue comes from; FAM-C1 replaces this with its own version token. */
export const FAMILY_CATALOGUE_SOURCE = 'interim:fam0-r9-d-fam-1' as const;

/** FAM-0 r9 D-FAM-1 catalogue, family column, sorted. Interim until FAM-C1 (see above). */
const INTERIM_FAM0_R9_LABELS = [
  'billing_history',
  'billing_schedule',
  'body_measurements',
  'body_weights',
  'checkins',
  'client_history',
  'client_profile',
  'clients',
  'coaching_sessions',
  'exercises',
  'food_logs',
  'form_responses',
  'forms',
  'goals',
  'habits',
  'meal_plans',
  'media',
  'messages',
  'notes',
  'nutrition_targets',
  'programs',
  'unclassified',
  'water_logs',
  'workout_assignments',
  'workout_logs',
  'workouts',
] as const;

export const FAMILY_LABELS: readonly FamilyLabel[] = Object.freeze([...INTERIM_FAM0_R9_LABELS]);
export type FamilyLabel = (typeof INTERIM_FAM0_R9_LABELS)[number];
/** The only catch-all label (D-FAM-1): a reachable coaching collection the mapping cannot name. */
export const CATCH_ALL_FAMILY = 'unclassified' as const satisfies FamilyLabel;

const FAMILY_LABEL_SET: ReadonlySet<string> = new Set(FAMILY_LABELS);
if (!CANONICAL_FAMILIES.every((f) => FAMILY_LABEL_SET.has(f)))
  throw new Error('the family catalogue must contain every canonical mapping family');
if (FAMILY_LABELS.some((f, i) => i > 0 && !(FAMILY_LABELS[i - 1] < f)))
  throw new Error('the family catalogue must be sorted and distinct');

export function isFamilyLabel(value: unknown): value is FamilyLabel {
  return typeof value === 'string' && FAMILY_LABEL_SET.has(value);
}

/**
 * The minimum catalogue surface L1 consumes (contract data; rendered in prompt part 2 through
 * the vocabulary and pinned by `contractHash`). `mappedFamilies` are the base's native-contract
 * families (`CANONICAL_FAMILIES`): a step of such a family needs a `mappingSpec.steps` entry
 * (V-L4); every other label is classification only in this slice.
 */
export interface FamilyCatalogueV1 {
  readonly source: typeof FAMILY_CATALOGUE_SOURCE;
  readonly labels: readonly FamilyLabel[];
  readonly catchAll: typeof CATCH_ALL_FAMILY;
  readonly mappedFamilies: readonly string[];
}

export function familyCatalogue(): FamilyCatalogueV1 {
  return Object.freeze({
    source: FAMILY_CATALOGUE_SOURCE,
    labels: FAMILY_LABELS,
    catchAll: CATCH_ALL_FAMILY,
    mappedFamilies: Object.freeze([...CANONICAL_FAMILIES].sort()),
  });
}
