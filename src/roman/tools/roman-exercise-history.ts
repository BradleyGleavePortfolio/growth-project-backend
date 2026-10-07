/**
 * exercise_history (R11-T1): the caller's own logged sets for one exercise,
 * scoped through the workout (`workout.user_id = callerId`; ExerciseSet has no
 * owner column). Numbers are computed here: weights in lb as logged (0 = a
 * bodyweight set); est. 1RM is Epley, w * (1 + reps / 30), with the valid-set
 * filter of src/ai/context/workout-context.service.ts:57.
 */

import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { dateOnly } from '../context/roman-client-context.service';

export const EXERCISE_HISTORY_LIMITS = Object.freeze({ max_sessions: 60, default_days: 90, max_days: 180, max_changes: 8 });

export interface ExerciseSetRow {
  exercise_name: string;
  sets_completed: number;
  reps_per_set: number[];
  weight_per_set: number[];
  rpe: number | null;
  workout: { date: Date };
}

export type ExerciseSession = ReturnType<typeof summarizeExerciseSet>;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Epley estimated one-rep max, or null outside 1-30 reps / 0 < w <= 2000. */
export function epley1rm(w: number, reps: number): number | null {
  if (!(finite(w) && finite(reps) && reps >= 1 && reps <= 30 && w > 0 && w <= 2_000)) return null;
  return round1(w * (1 + reps / 30));
}

export function summarizeExerciseSet(row: ExerciseSetRow) {
  const n = Math.max(row.reps_per_set.length, row.weight_per_set.length);
  const reps: number[] = [];
  const weights: number[] = [];
  let top: { weight_lbs: number; reps: number } | null = null;
  let best: number | null = null;
  let volume = 0;
  for (let i = 0; i < n; i++) {
    const r = finite(row.reps_per_set[i]) ? Math.max(0, Math.round(row.reps_per_set[i])) : 0;
    const w = finite(row.weight_per_set[i]) ? Math.max(0, round1(row.weight_per_set[i])) : 0;
    reps.push(r);
    weights.push(w);
    volume += w * r;
    if (r >= 1 && (!top || w > top.weight_lbs || (w === top.weight_lbs && r > top.reps))) {
      top = { weight_lbs: w, reps: r };
    }
    const e1 = epley1rm(w, r);
    if (e1 !== null && (best === null || e1 > best)) best = e1;
  }
  return {
    date: row.workout.date.toISOString().slice(0, 10),
    exercise: sanitizePromptInput(row.exercise_name, 60).trim() || 'Exercise',
    sets: finite(row.sets_completed) ? row.sets_completed : reps.length,
    reps_per_set: reps,
    weight_per_set_lbs: weights,
    rpe: finite(row.rpe) ? round1(row.rpe) : null,
    top_set: top,
    est_1rm_lbs: best,
    volume_lbs: Math.round(volume),
  };
}

/**
 * First-vs-last change per exercise name, never mixing two exercises one
 * search matched ("bench" -> Bench Press, Incline Bench Press). `sessions`
 * oldest first; an exercise logged once has no change.
 */
export function exerciseChanges(sessions: readonly ExerciseSession[]) {
  const groups = new Map<string, ExerciseSession[]>();
  for (const s of sessions) {
    const k = s.exercise.toLowerCase().replace(/\s+/g, ' ');
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  type N = number | null | undefined;
  const diff = (a: N, b: N) => (finite(a) && finite(b) ? round1(b - a) : null);
  const pct = (a: N, b: N) =>
    finite(a) && finite(b) && a > 0 ? round1(((b - a) / a) * 100) : null;
  const point = (s: ExerciseSession) => ({
    date: s.date,
    top_set: s.top_set,
    est_1rm_lbs: s.est_1rm_lbs,
    volume_lbs: s.volume_lbs,
  });
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, EXERCISE_HISTORY_LIMITS.max_changes)
    .map((g) => {
      const [first, last] = [g[0], g[g.length - 1]];
      return {
        exercise: last.exercise,
        sessions: g.length,
        first: point(first),
        last: point(last),
        change: {
          top_weight_lbs: diff(first.top_set?.weight_lbs, last.top_set?.weight_lbs),
          est_1rm_lbs: diff(first.est_1rm_lbs, last.est_1rm_lbs),
          est_1rm_pct: pct(first.est_1rm_lbs, last.est_1rm_lbs),
          volume_lbs: last.volume_lbs - first.volume_lbs,
        },
      };
    });
}

/** The caller's matching sets on workouts dated [from, to], newest first, cap + 1 rows. */
export function readExerciseSets(
  prisma: PrismaService,
  callerId: string,
  q: { exercise: string; from: string; to: string },
): Promise<ExerciseSetRow[]> {
  return prisma.exerciseSet.findMany({
    where: {
      exercise_name: { contains: q.exercise, mode: 'insensitive' },
      workout: { user_id: callerId, date: { gte: dateOnly(q.from), lte: dateOnly(q.to) } },
    },
    orderBy: [{ workout: { date: 'desc' } }, { workout: { created_at: 'desc' } }, { id: 'asc' }],
    take: EXERCISE_HISTORY_LIMITS.max_sessions + 1,
    select: { exercise_name: true, sets_completed: true, reps_per_set: true, weight_per_set: true,
      rpe: true, workout: { select: { date: true } } },
  });
}
