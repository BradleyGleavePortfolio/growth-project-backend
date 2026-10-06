/**
 * Roman v1.1 coach twin, slice R11-P1: the shape of a coach playbook.
 *
 * A playbook is how one head coach trains, feeds and recovers clients, in
 * short structured items. The builder (R11-P3b) writes it, Roman reads it in
 * client turns (R11-P4) and the post-check enforces its red lines (R11-P5).
 * Coaches and clients never see it (owner 10-05 11:22).
 *
 * `validateCoachPlaybook` is the single gate for both JSON columns of
 * CoachPlaybook (`sections`, `red_lines`): every write goes through it and
 * every reader may re-run it on a stored row. It rejects unknown keys at
 * every level, text over 160 characters, more than 12 items in any list and
 * any red-line kind outside the closed set. Issues carry the JSON path and a
 * code only, never the offending text, so they are safe to log.
 *
 * Nothing here is called while FEATURE_ROMAN_PLAYBOOK is off; this file only
 * defines the shape.
 */
import { z } from 'zod';

/** Longest text of one playbook item (characters, after trimming). */
export const PLAYBOOK_ITEM_TEXT_MAX = 160;
/** Most items in any one list, and most red lines. */
export const PLAYBOOK_LIST_MAX = 12;
/** Longest exercise or supplement name a red line may carry. */
export const PLAYBOOK_RED_LINE_VALUE_MAX = 80;
/** Ceiling for evidence_count (a count of source rows, never a person). */
export const PLAYBOOK_EVIDENCE_MAX = 100_000;

/** CoachPlaybook.status (SQL CHECK CoachPlaybook_status_check). */
export const PLAYBOOK_STATUSES = ['active', 'superseded'] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** CoachPlaybookSource.source_kind (SQL CHECK CoachPlaybookSource_source_kind_check). */
export const PLAYBOOK_SOURCE_KINDS = [
  'adjustment_decision',
  'program',
  'template',
  'meal_plan',
  'guideline',
  'coach_message',
  'session_note',
] as const;
export type PlaybookSourceKind = (typeof PLAYBOOK_SOURCE_KINDS)[number];

/** `stated`: the coach said or wrote it. `observed`: seen in what the coach does. */
export const PLAYBOOK_ITEM_BASES = ['stated', 'observed'] as const;

/** Closed set of red-line kinds the post-check understands. */
export const PLAYBOOK_RED_LINE_KINDS = [
  'no_exercise',
  'no_supplement',
  'no_train_through_pain',
  'no_failure_training',
  'min_kcal',
  'no_fasted_training',
  'custom',
] as const;
export type PlaybookRedLineKind = (typeof PLAYBOOK_RED_LINE_KINDS)[number];

/** Every list key per section, in render order. */
export const PLAYBOOK_SECTION_KEYS = {
  exercises: ['go_to', 'avoid', 'substitutions', 'cues', 'warm_up'],
  training: [
    'split',
    'frequency',
    'progression',
    'volume_intensity',
    'failure',
    'deload',
    'cardio',
    'missed_sessions',
    'plateaus',
  ],
  diet: [
    'macro_method',
    'protein',
    'flexibility',
    'meal_timing',
    'cut_bulk',
    'refeeds',
    'supplements_endorse',
    'supplements_reject',
    'bad_day',
  ],
  recovery: ['sleep_target', 'wind_down', 'poor_sleep_low_hrv', 'rest_days'],
} as const;
export type PlaybookSectionName = keyof typeof PLAYBOOK_SECTION_KEYS;

// One line of plain text: trimmed, non-empty, capped, no control characters
// (no newlines), so a rendered item can never break out of its line.
// eslint-disable-next-line no-control-regex
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/;
const lineText = (max: number) => z.string().trim().min(1).max(max).regex(ONE_LINE);

const evidence = {
  basis: z.enum(PLAYBOOK_ITEM_BASES),
  evidence_count: z.number().int().min(0).max(PLAYBOOK_EVIDENCE_MAX),
};

const Item = z.strictObject({ text: lineText(PLAYBOOK_ITEM_TEXT_MAX), ...evidence });
const Substitution = z.strictObject({
  for: lineText(PLAYBOOK_ITEM_TEXT_MAX),
  use: lineText(PLAYBOOK_ITEM_TEXT_MAX),
  when: lineText(PLAYBOOK_ITEM_TEXT_MAX).optional(),
  ...evidence,
});

const items = z.array(Item).max(PLAYBOOK_LIST_MAX).optional();
const substitutions = z.array(Substitution).max(PLAYBOOK_LIST_MAX).optional();

const Exercises = z.strictObject({
  go_to: items,
  avoid: items,
  substitutions,
  cues: items,
  warm_up: items,
});
const Training = z.strictObject({
  split: items,
  frequency: items,
  progression: items,
  volume_intensity: items,
  failure: items,
  deload: items,
  cardio: items,
  missed_sessions: items,
  plateaus: items,
});
const Diet = z.strictObject({
  macro_method: items,
  protein: items,
  flexibility: items,
  meal_timing: items,
  cut_bulk: items,
  refeeds: items,
  supplements_endorse: items,
  supplements_reject: items,
  bad_day: items,
});
const Recovery = z.strictObject({
  sleep_target: items,
  wind_down: items,
  poor_sleep_low_hrv: items,
  rest_days: items,
});

const SectionsInput = z.strictObject({
  exercises: Exercises.optional(),
  training: Training.optional(),
  diet: Diet.optional(),
  recovery: Recovery.optional(),
});

// A red line names what it forbids in `value` when the post-check needs it:
// the exercise, the supplement, or the calorie floor. The other kinds carry
// no value; `custom` is text only.
const redLineText = { text: lineText(PLAYBOOK_ITEM_TEXT_MAX), ...evidence };
const namedValue = lineText(PLAYBOOK_RED_LINE_VALUE_MAX);

const RedLine = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no_exercise'), value: namedValue, ...redLineText }),
  z.strictObject({ kind: z.literal('no_supplement'), value: namedValue, ...redLineText }),
  z.strictObject({ kind: z.literal('no_train_through_pain'), ...redLineText }),
  z.strictObject({ kind: z.literal('no_failure_training'), ...redLineText }),
  z.strictObject({
    kind: z.literal('min_kcal'),
    value: z.number().int().min(1).max(10_000),
    ...redLineText,
  }),
  z.strictObject({ kind: z.literal('no_fasted_training'), ...redLineText }),
  z.strictObject({ kind: z.literal('custom'), ...redLineText }),
]);
const RedLines = z.array(RedLine).max(PLAYBOOK_LIST_MAX);

export type PlaybookItem = z.infer<typeof Item>;
export type PlaybookSubstitution = z.infer<typeof Substitution>;
export type CoachPlaybookRedLine = z.infer<typeof RedLine>;

type Filled<T> = { [K in keyof T]-?: NonNullable<T[K]> };
type SectionsShape = z.infer<typeof SectionsInput>;
/** Validated sections: every section and every list present (empty when unknown). */
export type CoachPlaybookSections = {
  [S in keyof SectionsShape]-?: Filled<NonNullable<SectionsShape[S]>>;
};

export interface CoachPlaybookContent {
  sections: CoachPlaybookSections;
  red_lines: CoachPlaybookRedLine[];
}

export type CoachPlaybookValidation =
  { ok: true; value: CoachPlaybookContent } | { ok: false; issues: string[] };

/** An empty, valid playbook (no section has an item, no red line). */
export function emptyCoachPlaybookSections(): CoachPlaybookSections {
  return fillSections({});
}

function fillLists<K extends string>(
  keys: readonly K[],
  given: Partial<Record<K, PlaybookItem[]>>,
): Record<K, PlaybookItem[]> {
  const out: Partial<Record<K, PlaybookItem[]>> = {};
  for (const key of keys) out[key] = given[key] ?? [];
  return out as Record<K, PlaybookItem[]>;
}

function fillSections(input: SectionsShape): CoachPlaybookSections {
  const exercises: NonNullable<SectionsShape['exercises']> = input.exercises ?? {};
  return {
    exercises: {
      go_to: exercises.go_to ?? [],
      avoid: exercises.avoid ?? [],
      substitutions: exercises.substitutions ?? [],
      cues: exercises.cues ?? [],
      warm_up: exercises.warm_up ?? [],
    },
    training: fillLists(PLAYBOOK_SECTION_KEYS.training, input.training ?? {}),
    diet: fillLists(PLAYBOOK_SECTION_KEYS.diet, input.diet ?? {}),
    recovery: fillLists(PLAYBOOK_SECTION_KEYS.recovery, input.recovery ?? {}),
  };
}

/** `sections.exercises.go_to.3.text:too_big` style; never the value itself. */
function issueCodes(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].join('.');
    return `${path}:${issue.code}`;
  });
}

/**
 * Validate and normalise the two JSON columns of a playbook. On success the
 * sections carry every list key (empty when the input left it out), text is
 * trimmed, and red lines are in the closed kinds. On failure nothing is
 * returned but the issue codes.
 */
export function validateCoachPlaybook(input: {
  sections: unknown;
  red_lines: unknown;
}): CoachPlaybookValidation {
  const sections = SectionsInput.safeParse(input.sections);
  const redLines = RedLines.safeParse(input.red_lines);
  const issues = [
    ...(sections.success ? [] : issueCodes('sections', sections.error)),
    ...(redLines.success ? [] : issueCodes('red_lines', redLines.error)),
  ];
  if (!sections.success || !redLines.success) return { ok: false, issues };
  return { ok: true, value: { sections: fillSections(sections.data), red_lines: redLines.data } };
}
