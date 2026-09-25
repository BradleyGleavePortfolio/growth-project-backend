/**
 * S8-C native materialization — the closed vocabulary shared by the native
 * writers, the pure rule interpreter and the tests. Everything here mirrors the
 * accepted contract `docs/decisions/2026-09-24-s8-native-contract.md` (§3.2
 * outcomes, §3.3 child identity, §3.7 unresolved codes, §3.9 units) and the S8-B
 * database CHECKs (`20270122000000_scout_native_provenance_expand`). Nothing in
 * this module knows a source platform: a new source is data under
 * `./sources/*.json`, never a branch here.
 */

/** Closed `ImportNativeProvenance.native_kind` set (S8-B CHECK). */
export const NATIVE_KIND = {
  workout_program: 'workout_program',
  workout_plan: 'workout_plan',
  workout_plan_exercise: 'workout_plan_exercise',
} as const;
export type NativeKind = (typeof NATIVE_KIND)[keyof typeof NATIVE_KIND];

/** Closed `ImportNativeProvenance.outcome` set (S8-B CHECK). */
export const PROVENANCE_OUTCOME = {
  created: 'created',
  already_present: 'already_present',
  unresolved: 'unresolved',
} as const;
export type ProvenanceOutcome = (typeof PROVENANCE_OUTCOME)[keyof typeof PROVENANCE_OUTCOME];

/**
 * The canonical families this module materializes natively. `programs` is the
 * S8-C addition to the canonical list; `workouts` keeps its accepted token.
 * Spelled here as literals (not via the DTO) so the writers compile whether or
 * not the request allow-list already exposes `programs`.
 */
export const NATIVE_FAMILY = { programs: 'programs', workouts: 'workouts' } as const;
export type NativeFamily = (typeof NATIVE_FAMILY)[keyof typeof NATIVE_FAMILY];
/**
 * Provenance `entity_type` of a workout's nested exercise children (§3.3). Not a
 * staged family: the unique provenance key omits `native_kind` and top-level
 * source ids are arbitrary text, so children live in their own namespace.
 */
export const CHILD_ENTITY_TYPE = { workouts_exercise: 'workouts.exercise' } as const;

/** Closed unresolved code catalogue (§3.7). A code takes at most one qualifier. */
export const UNRESOLVED_CODE = {
  missing_required_field: 'missing_required_field',
  invalid_value: 'invalid_value',
  enum_unmapped: 'enum_unmapped',
  prescription_not_integral: 'prescription_not_integral',
  exercise_reference: 'exercise_reference',
  no_native_client_principal: 'no_native_client_principal',
  relationship_pending: 'relationship_pending',
  relationship_missing: 'relationship_missing',
  native_target_removed: 'native_target_removed',
  identity_conflict: 'identity_conflict',
  source_archived: 'source_archived',
  native_uniqueness: 'native_uniqueness',
} as const;
export type UnresolvedCode = (typeof UNRESOLVED_CODE)[keyof typeof UNRESOLVED_CODE];

/** Codes that MUST carry a qualifier (a native field/family/model name, never source data). */
const QUALIFIED: ReadonlySet<UnresolvedCode> = new Set<UnresolvedCode>([
  UNRESOLVED_CODE.missing_required_field,
  UNRESOLVED_CODE.invalid_value,
  UNRESOLVED_CODE.enum_unmapped,
  UNRESOLVED_CODE.prescription_not_integral,
  UNRESOLVED_CODE.relationship_pending,
  UNRESOLVED_CODE.relationship_missing,
  UNRESOLVED_CODE.native_uniqueness,
]);

/**
 * Build the exact ledger/provenance reason string `unresolved:<code>[:<qualifier>]`.
 * The qualifier is a native column, canonical family or model name chosen by
 * core code — never a source value, so no PII can ride along.
 */
export function unresolved(code: UnresolvedCode, qualifier?: string): string {
  if (QUALIFIED.has(code)) {
    if (qualifier === undefined || !/^[a-z_.A-Z]+$/.test(qualifier)) {
      throw new Error(`unresolved code ${code} requires a native-name qualifier`);
    }
    return `unresolved:${code}:${qualifier}`;
  }
  if (qualifier !== undefined) throw new Error(`unresolved code ${code} takes no qualifier`);
  return `unresolved:${code}`;
}

/** Provenance `reason` tags on CREATED records (§3.9 / §4.4): annotation, not failure. */
export const CREATED_TAG = {
  /** A spec-declared explicit default filled the named native field. */
  defaulted: (field: string): string => `defaulted:${field}`,
  /** `reps_or_duration_seconds` holds seconds (time prescription), not reps. */
  prescription_time: 'prescription:time',
} as const;

/** Join created-record tags into the single nullable `reason` column (null when none). */
export function joinTags(tags: readonly string[]): string | null {
  return tags.length === 0 ? null : tags.join(',');
}

/**
 * Child identity (§3.3): a nested child's provenance `source_id` is derived from
 * its parent's source_id with a length prefix so the parent can never be
 * ambiguous, then `#id:<child id>` when the source provides a stable child id or
 * `#ord:<0-based ordinal>` when it does not. Deterministic; never parsed back.
 */
export function childSourceId(
  parentSourceId: string,
  child: { id: string } | { ordinal: number },
): string {
  const prefix = `${parentSourceId.length}:${parentSourceId}#`;
  if ('id' in child) return `${prefix}id:${child.id}`;
  if (!Number.isInteger(child.ordinal) || child.ordinal < 0) {
    throw new Error('child ordinal must be a non-negative integer');
  }
  return `${prefix}ord:${child.ordinal}`;
}

/** The prefix every child source_id of a parent starts with (for child lookups). */
export function childSourceIdPrefix(parentSourceId: string): string {
  return `${parentSourceId.length}:${parentSourceId}#`;
}

/** Deterministic, plan-scoped superset group id derived from the source group key. */
export function supersetGroupId(parentSourceId: string, groupKey: string): string {
  return `${childSourceIdPrefix(parentSourceId)}group:${groupKey}`;
}

/** Exact international avoirdupois pound (§3.9): 1 lb = 0.45359237 kg. */
export const KG_PER_LB = 0.45359237;

/** Convert a mass to the native `weight_lbs` column; kilograms divide by the exact factor. */
export function toPounds(value: number, unit: 'lb' | 'kg'): number {
  return unit === 'lb' ? value : value / KG_PER_LB;
}

/** Closed native `WorkoutPlan.type` values (Prisma enum `WorkoutPlanType`). */
export const WORKOUT_PLAN_TYPES = ['strength', 'cardio', 'mobility'] as const;
export type WorkoutPlanTypeValue = (typeof WORKOUT_PLAN_TYPES)[number];
