/**
 * B-AIB2-126 — hard training limits and the minimum contraindication table
 * for the AI workout builder (plan section 2). Pure data, no I/O.
 *
 * These are tighter than the structural bounds in workout-diff.types.ts and
 * are enforced server-side on every op the model proposes. The coach can
 * still add any exercise or value by hand in the builder.
 */

/** Client-reported injury areas (UserProfile.injuries, consultation T3). */
export const INJURY_AREAS = [
  'lower_back',
  'upper_back_neck',
  'shoulder',
  'elbow_wrist',
  'hip',
  'knee',
  'ankle_foot',
  'other',
] as const;
export type InjuryArea = (typeof INJURY_AREAS)[number];

export function isInjuryArea(v: unknown): v is InjuryArea {
  return typeof v === 'string' && (INJURY_AREAS as readonly string[]).includes(v);
}

export const TRAINING_BOUNDS = {
  setsMin: 1,
  setsMax: 10,
  repsMin: 1,
  repsMax: 30,
  durationMinSeconds: 5,
  durationMaxSeconds: 3_600,
  restMin: 0,
  restMax: 600,
  exercisesPerWorkoutMax: 14,
  hardSetsPerMuscleMax: 12,
  progressLoadMaxPct: 10,
  progressRepsMax: 2,
  notesMax: 200,
  reasonMax: 200,
  summaryMax: 280,
} as const;

/** Human copy for an injury area (coach-facing warnings). */
export const INJURY_AREA_LABEL: Record<InjuryArea, string> = {
  lower_back: 'lower back',
  upper_back_neck: 'upper back or neck',
  shoulder: 'shoulder',
  elbow_wrist: 'elbow or wrist',
  hip: 'hip',
  knee: 'knee',
  ankle_foot: 'ankle or foot',
  other: 'other',
};

/**
 * Movements each injury area excludes. Matched against the exercise id (seed
 * catalog ids) and the exercise name. `other` never auto-drops; it only adds
 * a warning chip.
 */
export const CONTRAINDICATIONS: Record<
  Exclude<InjuryArea, 'other'>,
  { ids: readonly string[]; name: RegExp }
> = {
  knee: {
    ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-005', 'seed:legs-006', 'seed:legs-009', 'seed:cardio-004', 'seed:cardio-006'],
    name: /squat|lunge|leg extension|jump|burpee|plyo/i,
  },
  lower_back: {
    ids: ['seed:pull-010', 'seed:legs-001', 'seed:legs-003'],
    name: /deadlift|good morning|back squat|sit[- ]?up/i,
  },
  shoulder: {
    ids: ['seed:push-004', 'seed:push-005', 'seed:push-009'],
    name: /overhead press|shoulder press|military press|upright row|\bdips?\b|behind[- ]the[- ]neck/i,
  },
  elbow_wrist: {
    ids: ['seed:push-008', 'seed:pull-007'],
    name: /skull ?crusher|barbell curl|wrist extension/i,
  },
  hip: {
    ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-004'],
    name: /back squat|front squat|deep squat|leg press/i,
  },
  ankle_foot: {
    ids: ['seed:cardio-001', 'seed:cardio-004', 'seed:cardio-006'],
    name: /jump|\brun\b|running|sprint|burpee|hop|plyo/i,
  },
  upper_back_neck: {
    ids: [],
    name: /shrug|overhead carry/i,
  },
};

/** Injury areas the exercise loads (empty when none of the client's areas match). */
export function contraindicatedAreas(
  exercise: { id: string; name: string },
  injuries: readonly InjuryArea[],
): InjuryArea[] {
  const hits: InjuryArea[] = [];
  for (const area of injuries) {
    if (area === 'other') continue;
    const rule = CONTRAINDICATIONS[area];
    if (rule.ids.includes(exercise.id) || rule.name.test(exercise.name)) hits.push(area);
  }
  return hits;
}

/**
 * Medical-claim deny list (plan SAFE 7). Any sentence carrying one of these is
 * removed from model-written reason / summary / notes text.
 */
export const MEDICAL_CLAIM_PATTERN =
  /\b(cures?|cured|curing|treat(s|ed|ing|ment)?|heal(s|ed|ing)?|rehab\w*|diagnos\w*|therap\w*|prescri\w*)\b|recover(y|s|ed)? from (an? |the |your )?injur/i;

/** Remove sentences that make a medical claim; returns '' when nothing safe remains. */
export function stripMedicalClaims(text: string, max: number): string {
  const sentences = text.split(/(?<=[.;!?])\s+/);
  const kept = sentences.filter((s) => !MEDICAL_CLAIM_PATTERN.test(s));
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
