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
import { admissionRules, type AdmissionRulesV1 } from './admission';
import { contractVocabulary, type ContractVocabularyV1 } from './contract-vocabulary';

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

export const CANONICAL_CONTRACT_VERSION = 1 as const;

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

export interface FamilyDescription {
  readonly family: CanonicalFamily;
  readonly description: string;
  /** The TGP record the family lands in (names only; the writers are untouched, D-L0-6). */
  readonly destination: string;
  readonly fields: Readonly<Record<string, FieldDescription>>;
  readonly nativeRules: boolean;
}

const FAMILY_TEXT: Readonly<Record<CanonicalFamily, { description: string; destination: string }>> =
  {
    clients: {
      description: 'a person the coach trains (active or archived); identity is the source id',
      destination: 'Person (invite-pending roster), linked by (platform, source id)',
    },
    workouts: {
      description:
        'a workout template or assigned workout, with its exercise items when native rules apply',
      destination: 'WorkoutPlan template when native rules hold, else ScoutReconstructedEntity',
    },
    programs: {
      description: 'a training program: an ordered plan of weeks and days of workouts',
      destination: 'WorkoutProgram template when native rules hold, else ScoutReconstructedEntity',
    },
    client_history: {
      description: 'a logged, completed workout or performance record of one client',
      destination: 'ScoutReconstructedEntity (evidence; native writer pending)',
    },
  };

export const CANONICAL_FAMILY_DESCRIPTIONS: readonly FamilyDescription[] = Object.freeze(
  CANONICAL_FAMILIES.map((family) =>
    Object.freeze({
      family,
      ...FAMILY_TEXT[family],
      fields: family === PERSON_FAMILY ? PERSON_FIELD_DESCRIPTIONS : ENTITY_FIELD_DESCRIPTIONS,
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
    description: `workout type mapped onto ${WORKOUT_PLAN_TYPES.join('|')}`,
    kinds: ['enum'],
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

export const NATIVE_RULE_KINDS: readonly RuleKind[] = [
  'text',
  'identifier',
  'integer',
  'count',
  'enum',
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

export const IDENTITY_RULES: readonly string[] = Object.freeze([
  'Identity is (platform, family, source_id); source_id is the value of the step idField on each item.',
  `idField must be a key of the item shape with class ${ID_CLASSES.join('|')} (or an integer number).`,
  'Two steps feeding one family must draw ids from one id space (sharedIdSpaces) or are refused.',
  'Email and phone are never identity and never mapped: the grammar has no field for them.',
]);

export const RELATIONSHIP_RULES: readonly string[] = Object.freeze([
  'workouts.clientSourceId and client_history.clientSourceId link a record to a clients source id.',
  'workouts.programSourceId (native) links a workout to a programs source id.',
  'forEach fans a step out over an earlier step collectAs ids through the template :p1 parameter.',
]);

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
    vocabulary: contractVocabulary(),
    admission: admissionRules(),
  });
}

/** Sanity: the native tables cover exactly the interpreter's field set (asserted in tests too). */
export function nativeFieldTablesMatchInterpreter(): boolean {
  const expected = [...NATIVE_RULE_FIELDS].sort();
  return (
    expected.length === CONTRACT_NATIVE_FIELDS.length &&
    expected.every((f, i) => f === CONTRACT_NATIVE_FIELDS[i])
  );
}
