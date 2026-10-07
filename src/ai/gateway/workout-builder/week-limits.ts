// B-809-2 — program-week ceiling inputs: hard sets per muscle on the week's OTHER days, and the client's weekly cap (plan
// section 2). Shared by the generator's validation and the selective-Apply re-check.
import type { PrismaService } from '../../../prisma.service';
import { SEED_EXERCISES } from '../../../exercise-library/seed-catalog';
import { PlanSnapshot, snapshotFromRevisionJson } from '../materialisers/__shared/workout-diff.types';
import { TRAINING_BOUNDS } from './training-safety.constants';
import type { LibraryExercise } from './workout-diff.validator';

// Same rule as the validator's library: muscle = catalog target; cardio and mobility carry no hard sets.
const MUSCLE_BY_ID: ReadonlyMap<string, string> = new Map(
  SEED_EXERCISES.filter((e) => e.bodyPart !== 'cardio' && e.bodyPart !== 'mobility').map((e) => [e.id, e.target]),
);

export type WeekRow = { exercise_external_id: string; sets: number };

// AIB-NAMES-127: a row outside the seed catalog counts under its catalog muscle when the builder resolved one.
function muscleOf(id: string, catalog?: ReadonlyMap<string, LibraryExercise>): string | undefined {
  const seed = MUSCLE_BY_ID.get(id);
  if (seed || !catalog) return seed;
  const ex = catalog.get(id);
  return ex && ex.muscle && ex.category !== 'cardio' && ex.category !== 'mobility' ? ex.muscle : undefined;
}

export function sumSetsByMuscle(rows: readonly WeekRow[], catalog?: ReadonlyMap<string, LibraryExercise>): Map<string, number> {
  const per = new Map<string, number>();
  for (const row of rows) {
    const muscle = muscleOf(row.exercise_external_id, catalog);
    if (muscle) per.set(muscle, (per.get(muscle) ?? 0) + row.sets);
  }
  return per;
}

export function setsByMuscle(snapshot: PlanSnapshot, catalog?: ReadonlyMap<string, LibraryExercise>): Map<string, number> {
  return sumSetsByMuscle(snapshot.exercises, catalog);
}

/** Plan section 2: hard sets per primary muscle per program week <= 24, beginner 16. No client (template) = the general cap. */
export function weeklySetsCap(client: { experience: string | null } | null): number {
  return client?.experience === 'beginner' ? TRAINING_BOUNDS.hardSetsPerMuscleWeekBeginnerMax : TRAINING_BOUNDS.hardSetsPerMuscleWeekMax;
}

type WeekReader = Pick<PrismaService, 'workoutPlan' | 'workoutPlanRevision' | 'workoutPlanExercise'>;
type WeekDay = { planId: string; coachId: string; programId: string; weekIndex: number };
/** Exercise rows (id + sets) on the same program week's other (non-archived) days of this coach's program. */
export async function loadWeekOtherRows(prisma: WeekReader, day: WeekDay): Promise<WeekRow[]> {
  const days = await prisma.workoutPlan.findMany({
    where: { program_id: day.programId, coach_id: day.coachId, week_index: day.weekIndex, archived_at: null, id: { not: day.planId } },
    select: { id: true, head_revision_id: true },
  });
  const revIds = days.map((d) => d.head_revision_id).filter((id): id is string => !!id);
  const legacyIds = days.filter((d) => !d.head_revision_id).map((d) => d.id);
  const [revs, legacyRows] = await Promise.all([
    revIds.length ? prisma.workoutPlanRevision.findMany({ where: { id: { in: revIds } }, select: { exercises_json: true, plan_meta_json: true } }) : [],
    legacyIds.length
      ? prisma.workoutPlanExercise.findMany({ where: { workout_plan_id: { in: legacyIds }, archived_at: null }, select: { exercise_external_id: true, sets: true } })
      : [],
  ]);
  const rows: WeekRow[] = [];
  for (const r of revs) rows.push(...snapshotFromRevisionJson(r.exercises_json, r.plan_meta_json).exercises);
  rows.push(...legacyRows);
  return rows;
}

/** Hard sets per muscle on the same program week's other (non-archived) days of this coach's program (seed rows only). */
export async function loadWeekOtherSetsByMuscle(prisma: WeekReader, day: WeekDay): Promise<Map<string, number>> {
  return sumSetsByMuscle(await loadWeekOtherRows(prisma, day));
}
