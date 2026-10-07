// B-AIB3-126 — contraindication substitutions (plan section 2) and the bounds pass for the per-client program generator.
// Pure data + pure functions. The "loads" table mirrors b#809 training-safety.constants.ts CONTRAINDICATIONS (same seed ids
// and name patterns); follow-up AIB-3b folds the two into one file once b#809 merges.
import { INJURY_AREAS } from '../../../onboarding/consultation-answers';
import { SEED_EXERCISES } from '../../../exercise-library/seed-catalog';

export type InjuryAreaV2 = (typeof INJURY_AREAS)[number];
type LoadedArea = Exclude<InjuryAreaV2, 'other'>;
export interface NamedExercise {
  id: string;
  name: string;
}

const AREA_LOADS: Record<LoadedArea, { ids: readonly string[]; name: RegExp }> = {
  knee: { ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-005', 'seed:legs-006', 'seed:legs-009', 'seed:cardio-004', 'seed:cardio-006'], name: /squat|lunge|leg extension|jump|burpee|plyo/i },
  lower_back: { ids: ['seed:pull-010', 'seed:legs-001', 'seed:legs-003'], name: /deadlift|good morning|back squat|sit[- ]?up/i },
  shoulder: { ids: ['seed:push-004', 'seed:push-005', 'seed:push-009'], name: /overhead press|shoulder press|military press|upright row|\bdips?\b|behind[- ]the[- ]neck/i },
  elbow_wrist: { ids: ['seed:push-008', 'seed:pull-007'], name: /skull ?crusher|barbell curl|wrist extension/i },
  hip: { ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-004'], name: /back squat|front squat|deep squat|leg press/i },
  ankle_foot: { ids: ['seed:cardio-001', 'seed:cardio-004', 'seed:cardio-006'], name: /jump|\brun\b|running|sprint|burpee|hop|plyo/i },
  upper_back_neck: { ids: [], name: /shrug|overhead carry/i },
};

// Per area: first rule whose pattern matches the dropped exercise wins; its seed ids are tried in order and the first one that
// loads none of the client's areas is used. The last rule of each area is the catch-all.
export const SUBSTITUTIONS: Record<LoadedArea, ReadonlyArray<{ when: RegExp; use: readonly string[] }>> = {
  knee: [
    { when: /jump|burpee|plyo|hop/i, use: ['seed:cardio-002', 'seed:cardio-003'] },
    { when: /leg extension/i, use: ['seed:legs-008', 'seed:legs-007'] },
    { when: /./, use: ['seed:legs-007', 'seed:legs-003', 'seed:legs-008'] },
  ],
  lower_back: [
    { when: /sit[- ]?up/i, use: ['seed:core-004', 'seed:core-001'] },
    { when: /squat/i, use: ['seed:legs-004', 'seed:legs-007'] },
    { when: /./, use: ['seed:legs-007', 'seed:legs-008'] },
  ],
  shoulder: [
    { when: /\bdips?\b/i, use: ['seed:push-007', 'seed:push-003'] },
    { when: /upright row|shrug/i, use: ['seed:pull-006', 'seed:pull-009'] },
    { when: /./, use: ['seed:push-002', 'seed:push-003'] },
  ],
  elbow_wrist: [{ when: /curl/i, use: ['seed:pull-008'] }, { when: /./, use: ['seed:push-007'] }],
  hip: [{ when: /./, use: ['seed:legs-009', 'seed:legs-008'] }],
  ankle_foot: [{ when: /./, use: ['seed:cardio-002', 'seed:cardio-003'] }],
  upper_back_neck: [{ when: /./, use: ['seed:pull-006', 'seed:pull-009'] }],
};

const SEED_BY_ID = new Map(SEED_EXERCISES.map((e) => [e.id, e]));
const SEED_BY_NAME = new Map(SEED_EXERCISES.map((e) => [e.name.trim().toLowerCase(), e]));

/** Seed catalog row for a library id or an exact (case-insensitive) exercise name; null when neither matches. */
export function seedExerciseFor(idOrName: string): { id: string; name: string; bodyPart: string; target: string } | null {
  return SEED_BY_ID.get(idOrName) ?? SEED_BY_NAME.get(idOrName.trim().toLowerCase()) ?? null;
}

const AREA_KEYWORDS: ReadonlyArray<[RegExp, InjuryAreaV2]> = [
  [/knee/i, 'knee'], [/neck|upper back/i, 'upper_back_neck'], [/back|spine/i, 'lower_back'], [/shoulder/i, 'shoulder'],
  [/elbow|wrist/i, 'elbow_wrist'], [/hip/i, 'hip'], [/ankle|foot|feet/i, 'ankle_foot'],
];

/** Profile injuries -> area enums. Consultation writes enums; an older free-text entry maps by keyword, else `other`. */
export function toInjuryAreas(values: readonly unknown[] | null | undefined): InjuryAreaV2[] {
  const out = new Set<InjuryAreaV2>();
  for (const v of values ?? []) {
    if (typeof v !== 'string' || !v.trim()) continue;
    if ((INJURY_AREAS as readonly string[]).includes(v)) {
      out.add(v as InjuryAreaV2);
      continue;
    }
    out.add(AREA_KEYWORDS.find(([re]) => re.test(v))?.[1] ?? 'other');
  }
  return [...out];
}

/** Injury areas (of the client's) that the exercise loads. `other` never auto-drops. */
export function loadedAreas(exercise: NamedExercise, injuries: readonly InjuryAreaV2[]): LoadedArea[] {
  return injuries.filter(
    (a): a is LoadedArea => a !== 'other' && (AREA_LOADS[a].ids.includes(exercise.id) || AREA_LOADS[a].name.test(exercise.name)),
  );
}

/** A library exercise that replaces `exercise`, loads none of the client's areas and is not in `avoid`; null when none is left. */
export function substituteFor(exercise: NamedExercise, injuries: readonly InjuryAreaV2[], avoid: ReadonlySet<string> = new Set()): NamedExercise | null {
  for (const area of loadedAreas(exercise, injuries)) {
    const rule = SUBSTITUTIONS[area].find((r) => r.when.test(exercise.name)) ?? SUBSTITUTIONS[area][SUBSTITUTIONS[area].length - 1];
    for (const id of rule.use) {
      const seed = SEED_BY_ID.get(id);
      if (seed && seed.id !== exercise.id && !avoid.has(seed.id) && loadedAreas(seed, injuries).length === 0) return { id: seed.id, name: seed.name };
    }
  }
  return null;
}

const AVOID_LABEL: Record<LoadedArea, string> = {
  knee: 'loaded deep knee flexion and impact (squats, lunges, leg extension, jumps)',
  lower_back: 'loaded spinal flexion and axial load (deadlifts, good mornings, back squat, sit-ups)',
  shoulder: 'overhead pressing, upright rows, dips and behind-the-neck work',
  elbow_wrist: 'skull crushers, heavy barbell curls and loaded wrist extension',
  hip: 'deep loaded hip flexion (deep squats, leg press)',
  ankle_foot: 'jumps, running, sprints and hops',
  upper_back_neck: 'loaded shrugs and overhead carries',
};

/** Prompt lines naming each loaded area's excluded movements and the swaps to use instead (enums and catalog names only). */
export function substitutionGuide(injuries: readonly InjuryAreaV2[]): string[] {
  return injuries
    .filter((a): a is LoadedArea => a !== 'other')
    .map((a) => {
      const swaps = [...new Set(SUBSTITUTIONS[a].flatMap((r) => r.use))].map((id) => SEED_BY_ID.get(id)?.name).filter(Boolean);
      return `${a}: avoid ${AVOID_LABEL[a]}; swap to ${swaps.join(', ')}`;
    });
}

// Plan section 2 hard bounds, as applied to the per-client multi-week generator (reps and timed work share one column there).
export const PROGRAM_BOUNDS = { setsMin: 1, setsMax: 10, repsOrSecondsMax: 3_600, restMax: 600, exercisesPerDayMax: 14, notesMax: 200, loadOverLastMax: 1.05 } as const;

export interface ProgramRowLike {
  exercise_external_id: string; name: string; sets: number; reps_or_duration_seconds: number;
  weight_lbs?: number | null; rest_seconds?: number | null; notes?: string | null;
}
type AreaRow = { name: string; area: string };
export interface ProgramSafetyReport { substituted: Array<{ from: string; to: string; area: string }>; removed: AreaRow[]; kept: AreaRow[] }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const KEEP_WORD = /\b(keep|include|add|use|still|want|incorporate|program)\b/;
const NEGATION = /\b(no|not|never|avoid|without|skip|exclude|remove|drop|replace|swap|instead|except|don'?t|nothing)\b/;

/** True only for a clear positive keep/include of `name` (a keep word in the same clause, no negation); a mention is not enough. */
export function coachAskedToKeep(coachText: string, name: string): boolean {
  const [text, n] = [coachText.toLowerCase(), name.trim().toLowerCase()];
  if (n.length < 3) return false;
  for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
    const clause = text.slice(0, i).split(/[.;,!?\n]|\bbut\b/).pop() ?? '';
    if (KEEP_WORD.test(clause) && !NEGATION.test(clause)) return true;
  }
  return false;
}

/**
 * Server-side pass over generated program days: swap any exercise that loads a client injury area (unless the coach clearly
 * asked to keep it), drop it when no safe swap exists, clamp sets / reps / rest / notes to the hard bounds, cap exercises
 * per day, and keep a load only when the client has logged that exercise (at most 105% of the last logged weight).
 */
export function applyProgramSafety(
  days: Array<{ exercises: ProgramRowLike[] }>,
  opts: { injuries: readonly InjuryAreaV2[]; coachText: string; lastWeightById: ReadonlyMap<string, number> },
): ProgramSafetyReport {
  const report: ProgramSafetyReport = { substituted: [], removed: [], kept: [] };
  for (const day of days) {
    const kept: ProgramRowLike[] = [];
    const used = new Set(day.exercises.map((r) => seedExerciseFor(r.exercise_external_id)?.id ?? seedExerciseFor(r.name)?.id ?? r.exercise_external_id));
    for (const row of day.exercises) {
      const ex = { id: row.exercise_external_id, name: row.name || row.exercise_external_id };
      const areas = loadedAreas(ex, opts.injuries);
      if (areas.length > 0 && coachAskedToKeep(opts.coachText, ex.name)) report.kept.push({ name: ex.name, area: areas[0] });
      else if (areas.length > 0) {
        const sub = substituteFor(ex, opts.injuries, used); // no duplicate swaps within one day
        if (!sub) {
          report.removed.push({ name: ex.name, area: areas[0] });
          continue;
        }
        used.add(sub.id);
        report.substituted.push({ from: ex.name, to: sub.name, area: areas[0] });
        row.exercise_external_id = sub.id;
        row.name = sub.name;
        row.weight_lbs = null;
        row.notes = `Swapped from ${ex.name} for the ${areas[0].replace(/_/g, ' ')} limitation.`;
      }
      row.sets = clamp(row.sets, PROGRAM_BOUNDS.setsMin, PROGRAM_BOUNDS.setsMax);
      row.reps_or_duration_seconds = clamp(row.reps_or_duration_seconds, 1, PROGRAM_BOUNDS.repsOrSecondsMax);
      if (row.rest_seconds != null) row.rest_seconds = clamp(row.rest_seconds, 0, PROGRAM_BOUNDS.restMax);
      if (row.notes) row.notes = row.notes.slice(0, PROGRAM_BOUNDS.notesMax);
      if (row.weight_lbs != null) {
        const seedId = seedExerciseFor(row.exercise_external_id)?.id ?? seedExerciseFor(row.name)?.id;
        const last = seedId ? opts.lastWeightById.get(seedId) : undefined;
        row.weight_lbs = last && last > 0 ? Math.min(row.weight_lbs, Math.round(last * PROGRAM_BOUNDS.loadOverLastMax)) : null;
      }
      kept.push(row);
    }
    day.exercises = kept.slice(0, PROGRAM_BOUNDS.exercisesPerDayMax);
  }
  return report;
}
