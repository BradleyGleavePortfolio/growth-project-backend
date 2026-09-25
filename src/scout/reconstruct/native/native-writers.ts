import { Prisma } from '@prisma/client';
import type { MappedEntity } from '../mapping-spec';
import {
  CHILD_ENTITY_TYPE,
  NATIVE_FAMILY,
  NATIVE_KIND,
  PROVENANCE_OUTCOME,
  UNRESOLVED_CODE,
  unresolved,
} from './native-contract';
import {
  countUnresolvedChildren,
  findProvenance,
  promoteToCreated,
  recordCreated,
  recordUnresolved,
  type ProvenanceKey,
  type ProvenanceRow,
  type Tx,
} from './native-provenance';
import type { MappedExerciseFields, MappedProgram, MappedWorkoutTemplate } from './native-rules';
import { LEDGER_TARGET_KIND, type LedgerTargetKind, type PersistOutcome } from './persist-outcome';

/**
 * S8-C native writers: WorkoutProgram / WorkoutPlan / WorkoutPlanExercise
 * TEMPLATES through persistence primitives only (contract §3.6). This module
 * imports Prisma types and the provenance helpers and nothing else: no
 * WorkoutBuilderService, assignment, notification, drip, email or billing code
 * path can be reached from an import. Column rules follow the accepted fork /
 * copyProgramPlans precedent (`workout-builder.service.ts`): version 1, owner =
 * importing coach, `owner_only` visibility, an `initial` coach-authored revision
 * 0 only for program-day plans, exercises_json in the serialiseExerciseRows shape.
 *
 * Every writer runs on the engine's per-row transaction: native rows first, then
 * provenance, then (in the engine) the ledger — so a failure anywhere rolls all
 * three back and a replay sees either everything or nothing (A1/A2/D-S8-3).
 */

export interface RowIdentity {
  readonly source_platform: string;
  readonly source_id: string;
}

const ok = (
  targetId: string,
  targetKind: LedgerTargetKind,
  unresolvedChildren = 0,
): PersistOutcome => ({
  ok: true,
  targetId,
  targetKind,
  unresolvedChildren,
});
const fail = (reason: string): PersistOutcome => ({ ok: false, reason });

function key(coachId: string, row: RowIdentity, entityType: string): ProvenanceKey {
  return { coachId, sourceNamespace: row.source_platform, entityType, sourceId: row.source_id };
}

/**
 * Verify a CREATED provenance row still points at a live native row this coach
 * owns (§3.5). The native id is the sole join; a missing or archived target is
 * `native_target_removed` (coach deletions are honoured, never re-created), a
 * kind or tenant mismatch is `identity_conflict`.
 */
async function verifyTarget(
  tx: Tx,
  coachId: string,
  existing: ProvenanceRow,
  expectedKind: 'workout_program' | 'workout_plan',
): Promise<PersistOutcome> {
  if (existing.native_kind !== expectedKind || existing.native_id === null) {
    return fail(unresolved(UNRESOLVED_CODE.identity_conflict));
  }
  const select = { coach_id: true, archived_at: true };
  const target: { coach_id: string; archived_at: Date | null } | null =
    expectedKind === 'workout_program'
      ? await tx.workoutProgram.findUnique({ where: { id: existing.native_id }, select })
      : await tx.workoutPlan.findUnique({ where: { id: existing.native_id }, select });
  if (target === null || target.archived_at !== null)
    return fail(unresolved(UNRESOLVED_CODE.native_target_removed));
  if (target.coach_id !== coachId) return fail(unresolved(UNRESOLVED_CODE.identity_conflict));
  return ok(
    existing.native_id,
    expectedKind === 'workout_program'
      ? LEDGER_TARGET_KIND.workout_program
      : LEDGER_TARGET_KIND.workout_plan,
  );
}

/** `programs` → WorkoutProgram template (§4.2). Create-only; replay is `already_present`. */
export async function persistProgram(
  tx: Tx,
  coachId: string,
  row: RowIdentity,
  mapped: MappedProgram,
): Promise<PersistOutcome> {
  const provenance = key(coachId, row, NATIVE_FAMILY.programs);
  const existing = await findProvenance(tx, provenance);
  if (existing !== null && existing.outcome !== PROVENANCE_OUTCOME.unresolved) {
    return verifyTarget(tx, coachId, existing, 'workout_program');
  }
  const program = await tx.workoutProgram.create({
    data: {
      coach_id: coachId,
      owner_user_id: coachId,
      visibility: 'owner_only',
      name: mapped.name,
      description: mapped.description,
      weeks: mapped.weeks,
      days_per_week: mapped.daysPerWeek,
      is_template: true,
      is_regime: false,
      version: 1,
    },
    select: { id: true },
  });
  if (existing === null)
    await recordCreated(tx, provenance, NATIVE_KIND.workout_program, program.id, mapped.tags);
  else
    await promoteToCreated(tx, existing.id, NATIVE_KIND.workout_program, program.id, mapped.tags);
  return ok(program.id, LEDGER_TARGET_KIND.workout_program);
}

/**
 * Resolve the parent program for a program-day plan through provenance only
 * (same coach, same namespace, `programs` family). Absent → `relationship_pending`
 * (converges once the programs family has run); present but unresolved, removed
 * or conflicting → `relationship_missing`.
 */
async function resolveParentProgram(
  tx: Tx,
  coachId: string,
  row: RowIdentity,
  programSourceId: string,
): Promise<
  | { readonly ok: true; readonly programId: string }
  | { readonly ok: false; readonly reason: string }
> {
  const parent = await findProvenance(
    tx,
    key(
      coachId,
      { source_platform: row.source_platform, source_id: programSourceId },
      NATIVE_FAMILY.programs,
    ),
  );
  if (parent === null)
    return {
      ok: false,
      reason: unresolved(UNRESOLVED_CODE.relationship_pending, NATIVE_FAMILY.programs),
    };
  if (parent.outcome === PROVENANCE_OUTCOME.unresolved) {
    return {
      ok: false,
      reason: unresolved(UNRESOLVED_CODE.relationship_missing, NATIVE_FAMILY.programs),
    };
  }
  const verified = await verifyTarget(tx, coachId, parent, 'workout_program');
  if (!verified.ok)
    return {
      ok: false,
      reason: unresolved(UNRESOLVED_CODE.relationship_missing, NATIVE_FAMILY.programs),
    };
  return { ok: true, programId: verified.targetId };
}

/**
 * Exact catalog verification (§4.4 precondition): a child links to the catalog
 * only when its source reference equals an `ExerciseCatalogItem.id` or `.slug`
 * byte-for-byte — the two identifier shapes every renderer resolves
 * (`exercise-catalog.service.ts` `{ OR: [{ id }, { slug }] }`). No normalization,
 * no fuzzy match, no creation. Unverified references stay `exercise_reference`.
 */
async function verifiedCatalogRefs(tx: Tx, refs: readonly string[]): Promise<ReadonlySet<string>> {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return new Set();
  const rows = await tx.exerciseCatalogItem.findMany({
    where: { OR: [{ id: { in: unique } }, { slug: { in: unique } }] },
    select: { id: true, slug: true },
  });
  const known = new Set<string>();
  for (const item of rows) {
    known.add(item.id);
    known.add(item.slug);
  }
  return new Set(unique.filter((ref) => known.has(ref)));
}

interface ExerciseRow {
  readonly exercise_external_id: string;
  readonly order: number;
  readonly sets: number;
  readonly reps_or_duration_seconds: number;
  readonly weight_lbs: number | null;
  readonly rest_seconds: number | null;
  readonly superset_group_id: string | null;
  readonly notes: string | null;
}

function exerciseRow(fields: MappedExerciseFields): ExerciseRow {
  return {
    exercise_external_id: fields.exerciseRef,
    order: fields.order,
    sets: fields.sets,
    reps_or_duration_seconds: fields.repsOrDurationSeconds,
    weight_lbs: fields.weightLbs,
    rest_seconds: fields.restSeconds,
    superset_group_id: fields.supersetGroupId,
    notes: fields.notes,
  };
}

/** Same frozen shape as WorkoutBuilderService.serialiseExerciseRows (revision snapshot). */
export function serialiseExerciseRows(rows: readonly ExerciseRow[]): Prisma.InputJsonValue {
  return rows
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((r): Prisma.InputJsonObject => ({
      exercise_external_id: r.exercise_external_id,
      order: r.order,
      sets: r.sets,
      reps_or_duration_seconds: r.reps_or_duration_seconds,
      weight_lbs: r.weight_lbs ?? null,
      rest_seconds: r.rest_seconds ?? null,
      superset_group_id: r.superset_group_id ?? null,
      notes: r.notes ?? null,
    }));
}

/**
 * `workouts` (unlinked) → WorkoutPlan template with ordered exercise children
 * (§4.3/§4.4). Create-only: an existing CREATED identity is verified and
 * returned `already_present` with its unresolved children re-counted; coach edits
 * to the live plan are never touched. Unresolved children never block the parent;
 * each gets its own provenance row so the plan can never be reported complete.
 */
export async function persistWorkoutTemplate(
  tx: Tx,
  coachId: string,
  row: RowIdentity,
  mapped: MappedWorkoutTemplate,
): Promise<PersistOutcome> {
  const provenance = key(coachId, row, NATIVE_FAMILY.workouts);
  const existing = await findProvenance(tx, provenance);
  if (existing !== null && existing.outcome !== PROVENANCE_OUTCOME.unresolved) {
    const verified = await verifyTarget(tx, coachId, existing, 'workout_plan');
    if (!verified.ok) return verified;
    return ok(
      verified.targetId,
      LEDGER_TARGET_KIND.workout_plan,
      await countUnresolvedChildren(tx, provenance),
    );
  }

  let programId: string | null = null;
  if (mapped.programSourceId !== null) {
    const parent = await resolveParentProgram(tx, coachId, row, mapped.programSourceId);
    if (!parent.ok) return fail(parent.reason);
    programId = parent.programId;
  }

  const verified = await verifiedCatalogRefs(
    tx,
    mapped.exercises.flatMap((child) => (child.ok ? [child.fields.exerciseRef] : [])),
  );

  const plan = await tx.workoutPlan.create({
    data: {
      coach_id: coachId,
      name: mapped.name,
      type: mapped.type,
      duration_estimate_minutes: mapped.durationEstimateMinutes,
      // Standalone: legacy shape (program_id null, is_template false). Program day:
      // is_template mirrors the (template) program exactly like copyProgramPlans.
      program_id: programId,
      week_index: programId === null ? null : mapped.weekIndex,
      day_index: programId === null ? null : mapped.dayIndex,
      is_template: programId !== null,
      version: 1,
    },
    select: { id: true },
  });

  const written: ExerciseRow[] = [];
  let unresolvedChildren = 0;
  for (const child of mapped.exercises) {
    const childKey: ProvenanceKey = {
      ...provenance,
      entityType: CHILD_ENTITY_TYPE.workouts_exercise,
      sourceId: child.childSourceId,
    };
    if (!child.ok) {
      unresolvedChildren += 1;
      await recordUnresolved(tx, childKey, NATIVE_KIND.workout_plan_exercise, child.reason);
      continue;
    }
    if (!verified.has(child.fields.exerciseRef)) {
      unresolvedChildren += 1;
      await recordUnresolved(
        tx,
        childKey,
        NATIVE_KIND.workout_plan_exercise,
        unresolved(UNRESOLVED_CODE.exercise_reference),
      );
      continue;
    }
    const data = exerciseRow(child.fields);
    const exercise = await tx.workoutPlanExercise.create({
      data: { ...data, workout_plan_id: plan.id },
      select: { id: true },
    });
    written.push(data);
    await recordCreated(
      tx,
      childKey,
      NATIVE_KIND.workout_plan_exercise,
      exercise.id,
      child.fields.tags,
    );
  }

  if (programId !== null) {
    // Program-day baseline exactly like copyProgramPlans: revision 0, cause `initial`,
    // authored by the importing coach, then the head pointer.
    const revision = await tx.workoutPlanRevision.create({
      data: {
        workout_plan_id: plan.id,
        revision_index: 0,
        exercises_json: serialiseExerciseRows(written),
        plan_meta_json: {
          name: mapped.name,
          type: mapped.type,
          duration_estimate_minutes: mapped.durationEstimateMinutes,
          week_index: mapped.weekIndex,
          day_index: mapped.dayIndex,
        },
        author_id: coachId,
        author_kind: 'coach',
        cause: 'initial',
      },
      select: { id: true },
    });
    await tx.workoutPlan.update({
      where: { id: plan.id },
      data: { head_revision_id: revision.id },
    });
  }

  if (existing === null)
    await recordCreated(tx, provenance, NATIVE_KIND.workout_plan, plan.id, mapped.tags);
  else await promoteToCreated(tx, existing.id, NATIVE_KIND.workout_plan, plan.id, mapped.tags);
  return ok(plan.id, LEDGER_TARGET_KIND.workout_plan, unresolvedChildren);
}

/**
 * The accepted generic evidence write for a `workouts` row (byte-identical data
 * to `genericEntityFamily.persist` in ../families.ts; the unit test pins that),
 * typed `scout_entity` for the ledger. Used when the source declares no native
 * rules (nothing native is attempted) and for client-linked workouts (§3.8:
 * client-owned, no native principal; the evidence row continues and the native
 * outcome is recorded as an explicit unresolved provenance row when rules exist).
 */
export async function persistEvidence(
  tx: Tx,
  coachId: string,
  row: RowIdentity,
  entity: MappedEntity,
  options: { readonly recordNoNativePrincipal: boolean },
): Promise<PersistOutcome> {
  const provenance = key(coachId, row, NATIVE_FAMILY.workouts);
  if (options.recordNoNativePrincipal) {
    const existing = await findProvenance(tx, provenance);
    if (existing !== null && existing.outcome !== PROVENANCE_OUTCOME.unresolved) {
      // A native plan was already brought across for this identity; it stays the target.
      // A failed verification (§3.5 `native_target_removed` / `identity_conflict`) is returned
      // as-is before any evidence or provenance write: the CREATED row is never rewritten.
      const verified = await verifyTarget(tx, coachId, existing, 'workout_plan');
      if (!verified.ok) return verified;
      return ok(
        verified.targetId,
        LEDGER_TARGET_KIND.workout_plan,
        await countUnresolvedChildren(tx, provenance),
      );
    }
  }
  const record = await tx.scoutReconstructedEntity.upsert({
    where: {
      coach_id_source_platform_entity_type_source_id: {
        coach_id: coachId,
        source_platform: entity.sourcePlatform,
        entity_type: NATIVE_FAMILY.workouts,
        source_id: row.source_id,
      },
    },
    create: {
      coach_id: coachId,
      source_platform: entity.sourcePlatform,
      entity_type: NATIVE_FAMILY.workouts,
      source_id: row.source_id,
      client_source_id: entity.clientSourceId,
      label: entity.label,
    },
    update: { client_source_id: entity.clientSourceId, label: entity.label },
    select: { id: true },
  });
  if (options.recordNoNativePrincipal) {
    await recordUnresolved(
      tx,
      provenance,
      NATIVE_KIND.workout_plan,
      unresolved(UNRESOLVED_CODE.no_native_client_principal),
    );
  }
  return ok(record.id, LEDGER_TARGET_KIND.scout_entity);
}
