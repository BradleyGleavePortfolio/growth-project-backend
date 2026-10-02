/**
 * Writes a WorkoutProgram tree (program -> plans -> exercise rows -> revision
 * heads) inside a caller-provided transaction. Shared by the seed script
 * (masters, is_template=true) and onboarding complete (client clones,
 * is_template=false). Mirrors the row shapes the workout builder writes so
 * assignProgramToClient and the builder UI treat these rows like any other.
 */
import { Prisma } from '@prisma/client';
import type { PlanContent } from './clinic-programs';

export interface ProgramTreeInput {
  tenantCoachId: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  weeks: number;
  daysPerWeek: number;
  goalTag: string | null;
  isTemplate: boolean;
  clonedFromId: string | null;
  plans: PlanContent[];
  /** Extra metadata recorded on the program revision (audit only). */
  revisionMeta: Record<string, unknown>;
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v));
}

export async function writeProgramTree(
  tx: Prisma.TransactionClient,
  input: ProgramTreeInput,
): Promise<{ id: string; name: string; plan_ids: string[] }> {
  const program = await tx.workoutProgram.create({
    data: {
      coach_id: input.tenantCoachId,
      owner_user_id: input.ownerUserId,
      visibility: 'owner_only',
      name: input.name,
      description: input.description,
      weeks: input.weeks,
      days_per_week: input.daysPerWeek,
      is_template: input.isTemplate,
      cloned_from_id: input.clonedFromId,
      goal_tag: input.goalTag,
      version: 1,
    },
  });
  const planIds: string[] = [];
  for (const plan of input.plans) {
    const created = await tx.workoutPlan.create({
      data: {
        coach_id: input.tenantCoachId,
        name: plan.data.name,
        type: plan.data.type,
        duration_estimate_minutes: plan.data.duration_estimate_minutes,
        program_id: program.id,
        week_index: plan.data.week_index,
        day_index: plan.data.day_index,
        is_template: input.isTemplate,
        cloned_from_plan_id: plan.source_plan_id ?? null,
        version: 1,
      },
    });
    const rows = plan.exercises.slice().sort((a, b) => a.order - b.order);
    await tx.workoutPlanExercise.createMany({
      data: rows.map((e) => ({
        workout_plan_id: created.id,
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs,
        rest_seconds: e.rest_seconds,
        superset_group_id: e.superset_group_id,
        notes: e.notes,
      })),
    });
    const revision = await tx.workoutPlanRevision.create({
      data: {
        workout_plan_id: created.id,
        revision_index: 0,
        exercises_json: toJson(rows),
        plan_meta_json: toJson(plan.data),
        author_id: input.ownerUserId,
        author_kind: 'coach',
        cause: input.clonedFromId ? 'clone' : 'initial',
      },
    });
    await tx.workoutPlan.update({
      where: { id: created.id },
      data: { head_revision_id: revision.id },
    });
    planIds.push(created.id);
  }
  const programRevision = await tx.workoutProgramRevision.create({
    data: {
      program_id: program.id,
      revision_index: 0,
      structure_json: toJson({
        program_id: program.id,
        weeks: input.weeks,
        days_per_week: input.daysPerWeek,
        cloned_from_id: input.clonedFromId,
        plan_ids: planIds,
        ...input.revisionMeta,
      }),
      author_id: input.ownerUserId,
      author_kind: 'coach',
      cause: input.clonedFromId ? 'clone' : 'initial',
    },
  });
  await tx.workoutProgram.update({
    where: { id: program.id },
    data: { head_revision_id: programRevision.id },
  });
  return { id: program.id, name: program.name, plan_ids: planIds };
}
