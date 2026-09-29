import { createHash } from 'crypto';
import { canonicalJson } from '../induction/digest';
import {
  CANONICAL_FAMILIES,
  FIELD_COERCIONS,
  PERSON_FAMILY,
  type CanonicalFamily,
  type EntityFieldRules,
  type PersonFieldRules,
} from '../reconstruct/mapping-spec';
import {
  NATIVE_RULE_FIELDS,
  type ExerciseItemRules,
  type ProgramNativeRules,
  type RuleKind,
  type WorkoutNativeRules,
} from '../reconstruct/native/native-rules';
import { WORKOUT_PLAN_TYPES } from '../reconstruct/native/native-contract';
import { COMPLETENESS_BASIS_KINDS, NATIVE_RULES_DECLARATIONS } from '../induction/contract';
import { ID_CLASSES, STRING_CLASSES } from './digest-contract';
import { PAGINATION_PARAM_WORDS, admissionRules, type AdmissionRulesV1 } from './admission';
import {
  FAMILY_LABELS,
  MORE_PAGES_SIGNALS,
  PAGINATION_SIGNAL_DESCRIPTIONS,
  contractVocabulary,
  type ContractVocabularyV1,
  type FamilyLabel,
} from './contract-vocabulary';

/**
 * L1 (D-L0-7.1 part 2) — the canonical TGP target structure as ONE runtime object: families,
 * fields, coercions, native-rule targets, identity rules and relationships, each with a
 * `description`. The validators (V-L4/V-L6 in `proposal.ts`) iterate THESE tables and the prompt
 * renders THEM (`prompt.ts`), so a change here moves `contractHash` and the prompt together and
 * nothing is hand-written twice.
 *
 * Divergence from r3, stated: r3 puts `description` on the canonical definitions in
 * `mapping-spec.ts`; that file is outside this slice's owned paths, so the descriptions live here
 * and are bound to the validators' interfaces by `satisfies` (a field added to
 * `PersonFieldRules`/`EntityFieldRules`/native rule interfaces without a description is a compile
 * error; a description for a field that no longer exists is one too).
 */

export const CANONICAL_CONTRACT_VERSION = 2 as const;

/**
 * Divergence from r3 D-L0-4 (`idField` is a string of an id class): a `number` item key of class
 * `int` is also accepted as `idField` — integer ids are the common JSON form and a positional
 * fallback is refused either way. Flip to `false` to hold r3 verbatim; the identity text below,
 * the validator (`proposal.ts`) and the output schema all derive from this one constant
 * (R591-B-C2), so no prose can drift from it.
 */
export const ACCEPT_INTEGER_NUMBER_ID_FIELD = true as const;

export interface FieldDescription {
  readonly description: string;
  readonly coercions: readonly string[];
  /** Digest string classes the field may target; `null` = any non-contact class. */
  readonly acceptsClasses: readonly string[] | null;
}

export const PERSON_FIELD_DESCRIPTIONS = {
  displayName: {
    description:
      'the name the coach sees for this person; one path per source, first present value wins',
    coercions: FIELD_COERCIONS,
    acceptsClasses: null,
  },
} as const satisfies Record<keyof PersonFieldRules, FieldDescription>;

export const ENTITY_FIELD_DESCRIPTIONS = {
  clientSourceId: {
    description:
      'the source id of the client this record belongs to (a soft provenance link, never an email)',
    coercions: FIELD_COERCIONS,
    acceptsClasses: ID_CLASSES,
  },
  label: {
    description: 'a short display title for the record',
    coercions: FIELD_COERCIONS,
    acceptsClasses: null,
  },
} as const satisfies Record<keyof EntityFieldRules, FieldDescription>;

/**
 * One FAM-0 family label (D-FAM-1; r2 direction 2). The model CLASSIFIES a collection into a
 * label; it never proposes a destination — native | preserve is derived later from the native
 * writer registry. `mapped` = a `mappingSpec.steps` entry (canonical mapping family) is required
 * for steps of this label; the other labels are classification only in this slice.
 */
export interface FamilyDescription {
  readonly family: FamilyLabel;
  readonly description: string;
  readonly mapped: boolean;
  readonly fields: Readonly<Record<string, FieldDescription>>;
  readonly nativeRules: boolean;
}

const FAMILY_TEXT: Readonly<Record<FamilyLabel, string>> = {
  billing_history: 'invoices, payments and subscriptions of the coaching business',
  body_measurements: 'client body measurements other than weight (girths, skinfolds, body fat)',
  body_weights: 'client body weight entries over time',
  checkins: 'periodic client check-in submissions (questions, answers, photos, ratings)',
  client_history: 'a logged, completed workout or performance record of one client (legacy label)',
  client_profile: 'per-client profile facts beyond the roster row (birthday, goals text, tags)',
  clients: 'a person the coach trains (active or archived); identity is the source id',
  coaching_sessions: 'scheduled or completed appointments between coach and client',
  exercises: 'the coach exercise library (definitions, not prescriptions)',
  food_logs: 'client food diary entries',
  form_responses: 'submitted answers to a coach form or questionnaire',
  forms: 'coach-authored forms and questionnaires (definitions)',
  goals: 'client goals and targets',
  habits: 'habit definitions and their logs',
  meal_plans: 'meal plans and meal templates',
  media: 'photos, videos and files attached to another record',
  messages: 'coach-client messages and conversations',
  notes: 'coach notes about a client',
  nutrition_targets: 'macro and calorie targets assigned to a client',
  programs: 'a training program: an ordered plan of weeks and days of workouts',
  unclassified: 'a reachable coaching collection none of the other labels names (catch-all)',
  water_logs: 'client water intake entries',
  workout_assignments: 'a workout scheduled for a client on a date',
  workout_logs: 'completed workout sessions with performed sets',
  workouts:
    'a workout template or assigned workout, with its exercise items when native rules apply',
};

const MAPPED_FAMILY_SET: ReadonlySet<string> = new Set(CANONICAL_FAMILIES);
export function isMappedFamily(label: FamilyLabel): label is CanonicalFamily {
  return MAPPED_FAMILY_SET.has(label);
}

export const CANONICAL_FAMILY_DESCRIPTIONS: readonly FamilyDescription[] = Object.freeze(
  FAMILY_LABELS.map((family) =>
    Object.freeze({
      family,
      description: FAMILY_TEXT[family],
      mapped: isMappedFamily(family),
      fields: !isMappedFamily(family)
        ? {}
        : family === PERSON_FAMILY
          ? PERSON_FIELD_DESCRIPTIONS
          : ENTITY_FIELD_DESCRIPTIONS,
      nativeRules: family === 'programs' || family === 'workouts',
    }),
  ),
);

export interface NativeFieldDescription {
  readonly description: string;
  readonly kinds: readonly RuleKind[];
}

export const PROGRAM_NATIVE_FIELDS = {
  description: { description: 'program description text', kinds: ['text'] },
  weeks: {
    description: 'number of weeks (an integer, or the length of an array)',
    kinds: ['integer', 'count'],
  },
  daysPerWeek: { description: 'training days per week', kinds: ['integer', 'count'] },
  archived: { description: 'source archived flag', kinds: ['flag'] },
} as const satisfies Record<keyof ProgramNativeRules, NativeFieldDescription>;

export const WORKOUT_NATIVE_FIELDS = {
  type: {
    description: `workout type onto ${WORKOUT_PLAN_TYPES.join('|')}: not proposable (an enum map needs observed source values, which the digest never carries; R591-A-02)`,
    kinds: [],
  },
  durationEstimateMinutes: { description: 'estimated duration', kinds: ['duration', 'integer'] },
  programSourceId: { description: 'source id of the owning program', kinds: ['identifier'] },
  weekIndex: { description: 'week ordinal within the program', kinds: ['integer'] },
  dayIndex: { description: 'day ordinal within the week', kinds: ['integer'] },
  archived: { description: 'source archived flag', kinds: ['flag'] },
} as const satisfies Record<Exclude<keyof WorkoutNativeRules, 'exercises'>, NativeFieldDescription>;

export const EXERCISE_NATIVE_FIELDS = {
  id: { description: 'source id of the exercise item', kinds: ['identifier'] },
  exerciseRef: {
    description: 'source reference to the exercise definition',
    kinds: ['identifier'],
  },
  order: { description: 'position within the workout', kinds: ['integer'] },
  sets: { description: 'prescribed sets', kinds: ['integer'] },
  reps: { description: 'prescribed reps (integral only)', kinds: ['integer'] },
  durationSeconds: { description: 'prescribed duration', kinds: ['duration', 'integer'] },
  weight: { description: 'prescribed weight in lb or kg', kinds: ['weight'] },
  restSeconds: { description: 'rest between sets', kinds: ['duration', 'integer'] },
  groupKey: { description: 'superset/group marker', kinds: ['identifier'] },
  notes: { description: 'coach notes on the item', kinds: ['text'] },
} as const satisfies Record<keyof ExerciseItemRules, NativeFieldDescription>;

/**
 * The rule kinds the model may propose (R591-A-02, r2 direction 5): `enum` is EXCLUDED — an enum
 * `map` keys source VALUES the digest never carries, so every such key would be model-invented.
 * `flag` may list boolean/integer truthy markers only (no string literal), see `proposal.ts`.
 */
export const NATIVE_RULE_KINDS: readonly RuleKind[] = [
  'text',
  'identifier',
  'integer',
  'count',
  'flag',
  'duration',
  'weight',
];

/** Every native field name the tables above know; must equal `NATIVE_RULE_FIELDS` (tested). */
export const CONTRACT_NATIVE_FIELDS: readonly string[] = Object.freeze(
  [
    ...new Set<string>([
      ...Object.keys(PROGRAM_NATIVE_FIELDS),
      ...Object.keys(WORKOUT_NATIVE_FIELDS),
      'exercises',
      ...Object.keys(EXERCISE_NATIVE_FIELDS),
    ]),
  ].sort(),
);

/** The one sentence about integer ids, generated from the constant (R591-B-C2). */
export const ID_FIELD_CLASS_TEXT: string = `idField must be a key of the item shape with string class ${ID_CLASSES.join('|')}${
  ACCEPT_INTEGER_NUMBER_ID_FIELD ? ' or number class int' : ''
}; never positional.`;

export const IDENTITY_RULES: readonly string[] = Object.freeze([
  'Identity is (platform, family, source_id); source_id is the value of the step idField on each item.',
  ID_FIELD_CLASS_TEXT,
  'idScope global: ids are unique across the whole collection. idScope parent: ids are unique only within one parent (the forEach :p1 value); identity is then parentId:id and per-parent namespaces never collapse. A forEach step must state idScope.',
  'parentEdge names the item key holding the parent source id and the earlier step (by entityType) it points to; a child step without parentEdge links to nothing.',
  'Two steps feeding one family must draw ids from one id space (sharedIdSpaces) or are refused.',
  'Email and phone are never identity and never mapped: the grammar has no field for them.',
]);

export const RELATIONSHIP_RULES: readonly string[] = Object.freeze([
  'workouts.clientSourceId and client_history.clientSourceId link a record to a clients source id.',
  'workouts.programSourceId (native) links a workout to a programs source id.',
  'forEach fans a step out over an earlier step collectAs ids through the template :p1 parameter.',
  'family is a classification from the closed label list; the destination (native or preserve) is derived by the server, never proposed.',
]);

/**
 * Reset directive 4 + r2 direction 4 (EXEC_RESET_2026-09-29 §1; R591-B-A2): `page`, `cursor`,
 * `next_url` and `none`. Pagination evidence is the template's device-computed
 * `paginationSignals` (a closed presence list, never a key the site chose, never a value). `none`
 * is a CLAIM that needs positive proof: `single_response` present, no more-pages signal, and
 * either no total-count key or `total_equals_count`. Exhaustion itself is never certified here —
 * that is L3's replay evidence. `next_url` links are confined on the device to the run's
 * authorized/contacted origins (admission rules, device obligations).
 */
export const PAGINATION_STYLES = ['page', 'cursor', 'next_url', 'none'] as const;
export type PaginationStyle = (typeof PAGINATION_STYLES)[number];
export const NONE_PROOF_TEXT: string = `only when paginationSignals contains single_response, contains none of ${MORE_PAGES_SIGNALS.join(
  '|',
)}, and either lacks total_count_key or contains total_equals_count`;
export const PAGINATION_STYLE_DESCRIPTIONS = {
  page: 'param is the page-number query key (a queryKey of the template, or a pagination word when the template signals page_param); start 0 or 1',
  cursor:
    'param is the cursor query key (a queryKey, or a pagination word when the template signals cursor_key); nextPath is the next cursor string in the response',
  next_url:
    'nextPath is the response own next link (url class); no param; the device follows it only to an authorized or contacted origin of this run (origins[])',
  none: `a claim that a single response holds the whole collection; ${NONE_PROOF_TEXT}`,
} as const satisfies Record<PaginationStyle, string>;
/** Query parameter words a pagination `param` may use beside the template's own query keys. */
export const PAGINATION_PARAM_VOCABULARY: readonly string[] = PAGINATION_PARAM_WORDS;

/** The rendered structure (D-L0-7.1 part 2) — `contractHash` is over its canonical JSON. */
export interface CanonicalContractV1 {
  readonly contractVersion: typeof CANONICAL_CONTRACT_VERSION;
  readonly families: readonly FamilyDescription[];
  readonly fieldCoercions: readonly string[];
  readonly stringClasses: readonly string[];
  readonly idClasses: readonly string[];
  readonly nativeRuleKinds: readonly RuleKind[];
  readonly nativeRules: {
    readonly programs: Readonly<Record<string, NativeFieldDescription>>;
    readonly workouts: Readonly<Record<string, NativeFieldDescription>>;
    readonly exercises: Readonly<Record<string, NativeFieldDescription>>;
    readonly workoutTypes: readonly string[];
  };
  readonly completenessBasisKinds: readonly string[];
  readonly nativeRulesDeclarations: readonly string[];
  readonly identityRules: readonly string[];
  readonly relationshipRules: readonly string[];
  readonly pagination: {
    readonly styles: Readonly<Record<PaginationStyle, string>>;
    readonly paramWords: readonly string[];
    readonly signals: Readonly<Record<string, string>>;
    readonly morePagesSignals: readonly string[];
    readonly noneProof: string;
  };
  readonly acceptIntegerNumberIdField: boolean;
  readonly vocabulary: ContractVocabularyV1;
  readonly admission: AdmissionRulesV1;
}

export function canonicalContract(): CanonicalContractV1 {
  return Object.freeze({
    contractVersion: CANONICAL_CONTRACT_VERSION,
    families: CANONICAL_FAMILY_DESCRIPTIONS,
    fieldCoercions: FIELD_COERCIONS,
    stringClasses: STRING_CLASSES,
    idClasses: ID_CLASSES,
    nativeRuleKinds: NATIVE_RULE_KINDS,
    nativeRules: {
      programs: PROGRAM_NATIVE_FIELDS,
      workouts: WORKOUT_NATIVE_FIELDS,
      exercises: EXERCISE_NATIVE_FIELDS,
      workoutTypes: WORKOUT_PLAN_TYPES,
    },
    completenessBasisKinds: COMPLETENESS_BASIS_KINDS,
    nativeRulesDeclarations: NATIVE_RULES_DECLARATIONS,
    identityRules: IDENTITY_RULES,
    relationshipRules: RELATIONSHIP_RULES,
    pagination: {
      styles: PAGINATION_STYLE_DESCRIPTIONS,
      paramWords: PAGINATION_PARAM_VOCABULARY,
      signals: PAGINATION_SIGNAL_DESCRIPTIONS,
      morePagesSignals: MORE_PAGES_SIGNALS,
      noneProof: NONE_PROOF_TEXT,
    },
    acceptIntegerNumberIdField: ACCEPT_INTEGER_NUMBER_ID_FIELD,
    vocabulary: contractVocabulary(),
    admission: admissionRules(),
  });
}

/** `contractHash` (D-L0-7.1): sha256 over the canonical JSON of the rendered contract. */
export function contractHash(contract: CanonicalContractV1 = canonicalContract()): string {
  const text = canonicalJson(contract);
  if (text === null) throw new Error('canonical contract is not canonical JSON');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Sanity: the native tables cover exactly the interpreter's field set (asserted in tests too). */
export function nativeFieldTablesMatchInterpreter(): boolean {
  const expected = [...NATIVE_RULE_FIELDS].sort();
  return (
    expected.length === CONTRACT_NATIVE_FIELDS.length &&
    expected.every((f, i) => f === CONTRACT_NATIVE_FIELDS[i])
  );
}
