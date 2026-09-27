import { Prisma } from '@prisma/client';
import {
  REJECTION_MISSING_SOURCE_ID,
  S9_REPORT_CODE,
  UNRESOLVED_CATALOGUE,
  WRITER_CODE,
} from '../reconciliation/types';
import { CHILD_ENTITY_TYPE, NATIVE_FAMILY } from '../reconstruct/native/native-contract';
import { NATIVE_RULE_FIELDS } from '../reconstruct/native/native-rules';
import { RECONSTRUCT_FAMILY } from '../scout-reconstruct.dto';

/**
 * S9-C Addendum C-6 — the closed qualifier domains a D-S9-7 histogram key must belong to before
 * it reaches a DTO. Every set below is DERIVED from an existing code constant (a Prisma-generated
 * enum, the S8-C native contract/rules, the reconstruct family list or the S9-A catalogue), never
 * hand-listed, so the allow-list cannot drift from the writers by itself: a writer emitting a new
 * name must first add it to the constant it already reads from.
 *
 * A qualifier is admitted only if it names one of
 *  - a canonical family (`RECONSTRUCT_FAMILY`, `NATIVE_FAMILY`, the child entity type),
 *  - a native target model (`Prisma.ModelName` of the S8-B/S8-C native targets), or
 *  - a native column of one of those models (`Prisma.<Model>ScalarFieldEnum`) or a native rule
 *    field key the rule grammar accepts (`NATIVE_RULE_FIELDS`).
 * A person's name, an email, a source value or an unregistered field name is in none of them.
 */

/** Canonical / native family names and the nested child entity type. */
export const QUALIFIER_FAMILY_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(RECONSTRUCT_FAMILY),
  ...Object.values(NATIVE_FAMILY),
  ...Object.values(CHILD_ENTITY_TYPE),
]);

/** Native target models (generated `Prisma.ModelName`; a typo here fails to compile). */
export const QUALIFIER_MODEL_NAMES: ReadonlySet<string> = new Set<string>([
  Prisma.ModelName.WorkoutProgram,
  Prisma.ModelName.WorkoutPlan,
  Prisma.ModelName.WorkoutPlanExercise,
  Prisma.ModelName.Person,
]);

/** Native columns of the target models (generated scalar-field enums) plus rule field keys. */
export const QUALIFIER_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(Prisma.WorkoutProgramScalarFieldEnum),
  ...Object.values(Prisma.WorkoutPlanScalarFieldEnum),
  ...Object.values(Prisma.WorkoutPlanExerciseScalarFieldEnum),
  ...Object.values(Prisma.PersonScalarFieldEnum),
  ...NATIVE_RULE_FIELDS,
]);

/** The union: the only strings admissible as `<qualifier>` of `unresolved:<code>:<qualifier>`. */
export const UNRESOLVED_QUALIFIER_DOMAIN: ReadonlySet<string> = new Set<string>([
  ...QUALIFIER_FAMILY_NAMES,
  ...QUALIFIER_MODEL_NAMES,
  ...QUALIFIER_FIELD_NAMES,
]);

/**
 * Histogram keys that are complete constants (no qualifier): the S9-A report codes (D-S9-7),
 * the bare writer codes and the `missing_source_id` rejection. `unresolved:<code>` keys whose code
 * is a bare §3.7 catalogue entry are admitted by `unresolvedCodeShape` instead.
 */
export const CONSTANT_REASON_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(S9_REPORT_CODE),
  WRITER_CODE.no_native_client_principal,
  WRITER_CODE.native_target_removed,
  WRITER_CODE.identity_conflict,
  REJECTION_MISSING_SOURCE_ID,
]);

/** `qualified` / `bare` for a §3.7 catalogue code — `null` for a non-catalogue code. */
export function unresolvedCodeShape(code: string): 'qualified' | 'bare' | null {
  return Object.prototype.hasOwnProperty.call(UNRESOLVED_CATALOGUE, code)
    ? UNRESOLVED_CATALOGUE[code]
    : null;
}

/** Closed-domain membership for one `unresolved:<code>[:<qualifier>]` key. */
export function isAdmissibleUnresolved(code: string, qualifier: string | undefined): boolean {
  const shape = unresolvedCodeShape(code);
  if (shape === 'bare') return qualifier === undefined;
  if (shape === 'qualified') {
    return qualifier !== undefined && UNRESOLVED_QUALIFIER_DOMAIN.has(qualifier);
  }
  return false;
}
