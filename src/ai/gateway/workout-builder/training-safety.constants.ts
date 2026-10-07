// B-AIB2-126 — hard training limits, minimum contraindication table and medical-claim filter (plan section 2). Pure data.
export const INJURY_AREAS = ['lower_back', 'upper_back_neck', 'shoulder', 'elbow_wrist', 'hip', 'knee', 'ankle_foot', 'other'] as const;
export type InjuryArea = (typeof INJURY_AREAS)[number];

export function isInjuryArea(v: unknown): v is InjuryArea {
  return typeof v === 'string' && (INJURY_AREAS as readonly string[]).includes(v);
}

export const TRAINING_BOUNDS = {
  setsMin: 1, setsMax: 10, repsMin: 1, repsMax: 30, durationMinSeconds: 5, durationMaxSeconds: 3_600, restMin: 0, restMax: 600,
  exercisesPerWorkoutMax: 14, hardSetsPerMuscleMax: 12, progressLoadMaxPct: 10, progressRepsMax: 2, notesMax: 200, reasonMax: 200,
  summaryMax: 280,
} as const;

export const INJURY_AREA_LABEL: Record<InjuryArea, string> = {
  lower_back: 'lower back', upper_back_neck: 'upper back or neck', shoulder: 'shoulder', elbow_wrist: 'elbow or wrist', hip: 'hip',
  knee: 'knee', ankle_foot: 'ankle or foot', other: 'other',
};

// Movements each area excludes, by seed catalog id or exercise name. `other` never auto-drops (warning chip only).
export const CONTRAINDICATIONS: Record<Exclude<InjuryArea, 'other'>, { ids: readonly string[]; name: RegExp }> = {
  knee: { ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-005', 'seed:legs-006', 'seed:legs-009', 'seed:cardio-004', 'seed:cardio-006'], name: /squat|lunge|leg extension|jump|burpee|plyo/i },
  lower_back: { ids: ['seed:pull-010', 'seed:legs-001', 'seed:legs-003'], name: /deadlift|good morning|back squat|sit[- ]?up/i },
  shoulder: { ids: ['seed:push-004', 'seed:push-005', 'seed:push-009'], name: /overhead press|shoulder press|military press|upright row|\bdips?\b|behind[- ]the[- ]neck/i },
  elbow_wrist: { ids: ['seed:push-008', 'seed:pull-007'], name: /skull ?crusher|barbell curl|wrist extension/i },
  hip: { ids: ['seed:legs-001', 'seed:legs-002', 'seed:legs-004'], name: /back squat|front squat|deep squat|leg press/i },
  ankle_foot: { ids: ['seed:cardio-001', 'seed:cardio-004', 'seed:cardio-006'], name: /jump|\brun\b|running|sprint|burpee|hop|plyo/i },
  upper_back_neck: { ids: [], name: /shrug|overhead carry/i },
};

/** Injury areas (of the client's) that the exercise loads. */
export function contraindicatedAreas(exercise: { id: string; name: string }, injuries: readonly InjuryArea[]): InjuryArea[] {
  return injuries.filter((a) => a !== 'other' && (CONTRAINDICATIONS[a].ids.includes(exercise.id) || CONTRAINDICATIONS[a].name.test(exercise.name)));
}

// SAFE 7 deny list: any sentence with one of these is removed from model-written reason / summary / notes.
export const MEDICAL_CLAIM_PATTERN =
  /\b(cures?|cured|curing|treat(s|ed|ing|ment)?|heal(s|ed|ing)?|rehab\w*|diagnos\w*|therap\w*|prescri\w*)\b|recover(y|s|ed)? from (an? |the |your )?injur/i;

export function stripMedicalClaims(text: string, max: number): string {
  const kept = text.split(/(?<=[.;!?])\s+/).filter((s) => !MEDICAL_CLAIM_PATTERN.test(s));
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
