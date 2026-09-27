import { Prisma } from '@prisma/client';
import { readField, type FieldRule } from '../mapping-spec';
import {
  CREATED_TAG,
  UNRESOLVED_CODE,
  WORKOUT_PLAN_TYPES,
  childSourceId,
  supersetGroupId,
  toPounds,
  unresolved,
  type WorkoutPlanTypeValue,
} from './native-contract';

/**
 * S8-C native field rules — the data-only grammar a source declares to feed the
 * typed native columns S8-A's label/link seam does not cover (§4.2-§4.4), and
 * the ONE pure/total interpreter over it. Core knows which native column is
 * required and which rule kinds may feed it; a source knows only where its
 * value lives and in which unit. No source name appears in this module.
 *
 * Every rule reads the first present path (like S8-A `readField`). Kinds:
 *  - `text`        string only, trimmed, empty → absent
 *  - `identifier`  string or finite number → string (source ids / catalog refs)
 *  - `integer`     integral number or integer string; optional ordinal `base`
 *                  (1-based sources become 0-based) and explicit `default`
 *  - `count`       the length of an array at the path (e.g. weeks = days.length)
 *  - `enum`        exact source value → canonical value via `map`; explicit `default`
 *  - `flag`        exact membership in `truthy` (source-archived markers)
 *  - `duration`    integer in the declared `unit`; converted exactly to the column unit
 *  - `weight`      finite number in `unit` lb|kg → pounds (exact factor)
 * A range or text prescription ("8-12", "AMRAP") in an Int prescription column is
 * `prescription_not_integral:<field>`; any other non-conforming present value is
 * `invalid_value:<field>`; a required column with neither a value nor an explicit
 * default is `missing_required_field:<field>`.
 */

export type Paths = readonly (readonly string[])[];
export type Scalar = string | number | boolean;

export type NativeRule =
  | { readonly kind: 'text'; readonly paths: Paths }
  | { readonly kind: 'identifier'; readonly paths: Paths }
  | {
      readonly kind: 'integer';
      readonly paths: Paths;
      readonly base?: 0 | 1;
      readonly default?: number;
    }
  | { readonly kind: 'count'; readonly paths: Paths }
  | {
      readonly kind: 'enum';
      readonly paths: Paths;
      readonly map: Readonly<Record<string, string>>;
      readonly default?: string;
    }
  | { readonly kind: 'flag'; readonly paths: Paths; readonly truthy: readonly Scalar[] }
  | { readonly kind: 'duration'; readonly paths: Paths; readonly unit: 'seconds' | 'minutes' }
  | { readonly kind: 'weight'; readonly paths: Paths; readonly unit: 'lb' | 'kg' };

export type RuleKind = NativeRule['kind'];

export interface ExerciseItemRules {
  readonly id?: NativeRule;
  readonly exerciseRef?: NativeRule;
  readonly order?: NativeRule;
  readonly sets?: NativeRule;
  readonly reps?: NativeRule;
  readonly durationSeconds?: NativeRule;
  readonly weight?: NativeRule;
  readonly restSeconds?: NativeRule;
  readonly groupKey?: NativeRule;
  readonly notes?: NativeRule;
}

export interface WorkoutNativeRules {
  readonly type?: NativeRule;
  readonly durationEstimateMinutes?: NativeRule;
  readonly programSourceId?: NativeRule;
  readonly weekIndex?: NativeRule;
  readonly dayIndex?: NativeRule;
  readonly archived?: NativeRule;
  readonly exercises?: { readonly paths: Paths; readonly item: ExerciseItemRules };
}

export interface ProgramNativeRules {
  readonly description?: NativeRule;
  readonly weeks?: NativeRule;
  readonly daysPerWeek?: NativeRule;
  readonly archived?: NativeRule;
}

/** One source platform's native rules. Absent family → that family is not natively declared. */
export interface NativeRuleSet {
  readonly specVersion: 1;
  readonly sourcePlatform: string;
  readonly families: {
    readonly programs?: ProgramNativeRules;
    readonly workouts?: WorkoutNativeRules;
  };
}

// ---------------------------------------------------------------------------
// Canonical mapped values (the writers' typed inputs).

export interface MappedProgram {
  /** Staged `source_platform` — the provenance namespace at persist. */
  readonly sourcePlatform: string;
  readonly name: string;
  readonly description: string | null;
  readonly weeks: number;
  readonly daysPerWeek: number;
  /** Created-record annotation tags (`defaulted:<field>`). */
  readonly tags: readonly string[];
}

export interface MappedExerciseFields {
  /** Source-provided catalog identifier candidate; verified exactly against the catalog at persist. */
  readonly exerciseRef: string;
  readonly order: number;
  readonly sets: number;
  readonly repsOrDurationSeconds: number;
  readonly weightLbs: number | null;
  readonly restSeconds: number | null;
  readonly supersetGroupId: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
}

export type MappedExerciseChild = {
  /** §3.3 encoded child identity. */
  readonly childSourceId: string;
  readonly ordinal: number;
} & (
  | { readonly ok: true; readonly fields: MappedExerciseFields }
  | { readonly ok: false; readonly reason: string }
);

export interface MappedWorkoutTemplate {
  /** Staged `source_platform` — the provenance namespace at persist. */
  readonly sourcePlatform: string;
  readonly name: string;
  readonly type: WorkoutPlanTypeValue;
  readonly durationEstimateMinutes: number | null;
  /** Parent program's source id (same platform/namespace) or null for a standalone plan. */
  readonly programSourceId: string | null;
  readonly weekIndex: number | null;
  readonly dayIndex: number | null;
  readonly exercises: readonly MappedExerciseChild[];
  readonly tags: readonly string[];
}

export type Interpretation<M> =
  { readonly ok: true; readonly mapped: M } | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Reading + coercion (pure, total).

function readRaw(payload: Prisma.JsonValue, paths: Paths): unknown {
  for (const path of paths) {
    let cursor: unknown = payload;
    for (const key of path) {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = Object.prototype.hasOwnProperty.call(cursor, key)
        ? (cursor as Record<string, unknown>)[key]
        : undefined;
    }
    if (cursor !== null && cursor !== undefined) return cursor;
  }
  return undefined;
}

type Coerced<T> =
  | { readonly state: 'absent' }
  | { readonly state: 'value'; readonly value: T }
  | { readonly state: 'invalid' }
  | { readonly state: 'not_integral' };

function coerceInteger(raw: unknown): Coerced<number> {
  if (raw === undefined) return { state: 'absent' };
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? { state: 'value', value: raw } : { state: 'not_integral' };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { state: 'absent' };
    if (/^-?\d+$/.test(trimmed)) return { state: 'value', value: Number(trimmed) };
    // A finite decimal is a non-integral prescription; anything else is invalid.
    return /^-?\d*\.\d+$/.test(trimmed) || /^\d+\s*-\s*\d+$/.test(trimmed)
      ? { state: 'not_integral' }
      : { state: 'invalid' };
  }
  return { state: 'invalid' };
}

function coerceNumber(raw: unknown): Coerced<number> {
  if (raw === undefined) return { state: 'absent' };
  if (typeof raw === 'number')
    return Number.isFinite(raw) ? { state: 'value', value: raw } : { state: 'invalid' };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { state: 'absent' };
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { state: 'invalid' };
    return { state: 'value', value: Number(trimmed) };
  }
  return { state: 'invalid' };
}

function asFieldRule(paths: Paths, coerce: FieldRule['coerce']): FieldRule {
  return { paths, coerce };
}

/** Text/identifier fields reuse S8-A's exact coercion so labels and ids agree byte-for-byte. */
function readString(payload: Prisma.JsonValue, rule: NativeRule): string | null {
  return readField(
    payload,
    asFieldRule(rule.paths, rule.kind === 'identifier' ? 'string_or_finite_number' : 'string'),
  );
}

/** Per-field interpretation outcome: a value (possibly defaulted), absent, or an unresolved reason. */
type FieldOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly defaulted: boolean }
  | { readonly ok: true; readonly value: null; readonly defaulted: false }
  | { readonly ok: false; readonly reason: string };

const present = <T>(value: T, defaulted = false): FieldOutcome<T> => ({
  ok: true,
  value,
  defaulted,
});
const absent = <T>(): FieldOutcome<T> => ({ ok: true, value: null, defaulted: false });
const invalid = <T>(field: string): FieldOutcome<T> => ({
  ok: false,
  reason: unresolved(UNRESOLVED_CODE.invalid_value, field),
});

interface IntegerOptions {
  readonly min: number;
  /** `prescription_not_integral` instead of `invalid_value` for non-integral present values. */
  readonly prescription: boolean;
}

function integerField(
  payload: Prisma.JsonValue,
  rule: NativeRule | undefined,
  field: string,
  options: IntegerOptions,
): FieldOutcome<number> {
  if (rule === undefined) return absent();
  if (rule.kind === 'count') {
    const raw = readRaw(payload, rule.paths);
    if (raw === undefined) return absent();
    if (!Array.isArray(raw)) return invalid(field);
    return raw.length >= options.min ? present(raw.length) : invalid(field);
  }
  if (rule.kind !== 'integer' && rule.kind !== 'duration') return invalid(field);
  const coerced = coerceInteger(readRaw(payload, rule.paths));
  if (coerced.state === 'absent') {
    if (rule.kind === 'integer' && rule.default !== undefined) return present(rule.default, true);
    return absent();
  }
  if (coerced.state === 'not_integral') {
    return options.prescription
      ? { ok: false, reason: unresolved(UNRESOLVED_CODE.prescription_not_integral, field) }
      : invalid(field);
  }
  if (coerced.state === 'invalid') return invalid(field);
  const value =
    rule.kind === 'integer' && rule.base !== undefined ? coerced.value - rule.base : coerced.value;
  return value >= options.min ? present(value) : invalid(field);
}

/** Duration in the COLUMN unit; the rule declares the SOURCE unit. Conversion is exact or invalid. */
function durationField(
  payload: Prisma.JsonValue,
  rule: NativeRule | undefined,
  field: string,
  column: 'seconds' | 'minutes',
  min: number,
): FieldOutcome<number> {
  if (rule === undefined) return absent();
  if (rule.kind === 'integer')
    return integerField(payload, rule, field, { min, prescription: false });
  if (rule.kind !== 'duration') return invalid(field);
  const base = integerField(payload, rule, field, { min: 0, prescription: false });
  if (!base.ok || base.value === null) return base;
  let value = base.value;
  if (rule.unit !== column) {
    if (rule.unit === 'minutes') value = value * 60;
    else if (value % 60 !== 0) return invalid(field);
    else value = value / 60;
  }
  return value >= min ? present(value) : invalid(field);
}

function weightField(
  payload: Prisma.JsonValue,
  rule: NativeRule | undefined,
  field: string,
): FieldOutcome<number> {
  if (rule === undefined) return absent();
  if (rule.kind !== 'weight') return invalid(field);
  const coerced = coerceNumber(readRaw(payload, rule.paths));
  if (coerced.state === 'absent') return absent();
  if (coerced.state !== 'value' || coerced.value < 0) return invalid(field);
  return present(toPounds(coerced.value, rule.unit));
}

function enumField(
  payload: Prisma.JsonValue,
  rule: NativeRule | undefined,
  field: string,
  allowed: readonly string[],
): FieldOutcome<string> {
  if (rule === undefined) return absent();
  if (rule.kind !== 'enum') return invalid(field);
  const raw = readRaw(payload, rule.paths);
  if (raw === undefined || (typeof raw === 'string' && raw.trim().length === 0)) {
    if (rule.default !== undefined && allowed.includes(rule.default))
      return present(rule.default, true);
    return absent();
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return invalid(field);
  const key = String(raw).trim();
  const mapped = Object.prototype.hasOwnProperty.call(rule.map, key) ? rule.map[key] : undefined;
  // A present key absent from the explicit map is `enum_unmapped` (§3.7): the spec needs an
  // entry, the data is not invalid. A mapped destination outside the native enum stays invalid.
  if (mapped === undefined)
    return { ok: false, reason: unresolved(UNRESOLVED_CODE.enum_unmapped, field) };
  return allowed.includes(mapped) ? present(mapped) : invalid(field);
}

function flagField(payload: Prisma.JsonValue, rule: NativeRule | undefined): boolean {
  if (rule === undefined || rule.kind !== 'flag') return false;
  const raw = readRaw(payload, rule.paths);
  if (raw === undefined) return false;
  return rule.truthy.some((candidate) => candidate === raw);
}

function textField(
  payload: Prisma.JsonValue,
  rule: NativeRule | undefined,
  field: string,
): FieldOutcome<string> {
  if (rule === undefined) return absent();
  if (rule.kind !== 'text' && rule.kind !== 'identifier') return invalid(field);
  const value = readString(payload, rule);
  return value === null ? absent() : present(value);
}

const missing = (field: string): string =>
  unresolved(UNRESOLVED_CODE.missing_required_field, field);

// ---------------------------------------------------------------------------
// Row interpreters.

/** Inputs S8-A already resolved for the row (label + client link), plus the raw payload. */
export interface SeamInputs {
  readonly sourcePlatform: string;
  readonly label: string | null;
  readonly clientSourceId: string | null;
  readonly payload: Prisma.JsonValue;
  readonly sourceId: string;
}

/** Program → WorkoutProgram template fields (§4.2). */
export function interpretProgram(
  rules: ProgramNativeRules | undefined,
  seam: SeamInputs,
): Interpretation<MappedProgram> {
  const r = rules ?? {};
  if (seam.clientSourceId !== null) {
    return { ok: false, reason: unresolved(UNRESOLVED_CODE.no_native_client_principal) };
  }
  if (flagField(seam.payload, r.archived))
    return { ok: false, reason: unresolved(UNRESOLVED_CODE.source_archived) };
  if (seam.label === null) return { ok: false, reason: missing('name') };
  const description = textField(seam.payload, r.description, 'description');
  if (!description.ok) return description;
  const weeks = integerField(seam.payload, r.weeks, 'weeks', { min: 1, prescription: false });
  if (!weeks.ok) return weeks;
  if (weeks.value === null) return { ok: false, reason: missing('weeks') };
  const days = integerField(seam.payload, r.daysPerWeek, 'days_per_week', {
    min: 1,
    prescription: false,
  });
  if (!days.ok) return days;
  if (days.value === null) return { ok: false, reason: missing('days_per_week') };
  const tags: string[] = [];
  if (weeks.defaulted) tags.push(CREATED_TAG.defaulted('weeks'));
  if (days.defaulted) tags.push(CREATED_TAG.defaulted('days_per_week'));
  return {
    ok: true,
    mapped: {
      sourcePlatform: seam.sourcePlatform,
      name: seam.label,
      description: description.value,
      weeks: weeks.value,
      daysPerWeek: days.value,
      tags,
    },
  };
}

/**
 * Unlinked workout → WorkoutPlan template + ordered exercise children (§4.3,
 * §4.4). Client-linked rows are decided by the caller (evidence path); this
 * interpreter is only reached for coach-owned templates.
 */
export function interpretWorkout(
  rules: WorkoutNativeRules | undefined,
  seam: SeamInputs,
): Interpretation<MappedWorkoutTemplate> {
  const r = rules ?? {};
  if (seam.clientSourceId !== null) {
    return { ok: false, reason: unresolved(UNRESOLVED_CODE.no_native_client_principal) };
  }
  if (flagField(seam.payload, r.archived))
    return { ok: false, reason: unresolved(UNRESOLVED_CODE.source_archived) };
  if (seam.label === null) return { ok: false, reason: missing('name') };
  const type = enumField(seam.payload, r.type, 'type', WORKOUT_PLAN_TYPES);
  if (!type.ok) return type;
  if (type.value === null) return { ok: false, reason: missing('type') };
  const duration = durationField(
    seam.payload,
    r.durationEstimateMinutes,
    'duration_estimate_minutes',
    'minutes',
    1,
  );
  if (!duration.ok) return duration;
  const program = textField(seam.payload, r.programSourceId, 'program_id');
  if (!program.ok) return program;
  let weekIndex: number | null = null;
  let dayIndex: number | null = null;
  if (program.value !== null) {
    const week = integerField(seam.payload, r.weekIndex, 'week_index', {
      min: 0,
      prescription: false,
    });
    if (!week.ok) return week;
    if (week.value === null) return { ok: false, reason: missing('week_index') };
    const day = integerField(seam.payload, r.dayIndex, 'day_index', {
      min: 0,
      prescription: false,
    });
    if (!day.ok) return day;
    if (day.value === null) return { ok: false, reason: missing('day_index') };
    weekIndex = week.value;
    dayIndex = day.value;
  }
  const tags: string[] = [];
  if (type.defaulted) tags.push(CREATED_TAG.defaulted('type'));

  let items: unknown[] = [];
  if (r.exercises !== undefined) {
    const raw = readRaw(seam.payload, r.exercises.paths);
    if (raw !== undefined) {
      if (!Array.isArray(raw))
        return { ok: false, reason: unresolved(UNRESOLVED_CODE.invalid_value, 'exercises') };
      items = raw;
    }
  }
  const exercises = items.map((item, ordinal) =>
    interpretExercise(r.exercises?.item ?? {}, item, ordinal, seam.sourceId),
  );
  // Stable ordering (§4.4): `order` is unique per plan; a duplicate is the later child's fault.
  const seen = new Set<number>();
  const deduped = exercises.map((child): MappedExerciseChild => {
    if (!child.ok) return child;
    if (seen.has(child.fields.order)) {
      return {
        childSourceId: child.childSourceId,
        ordinal: child.ordinal,
        ok: false,
        reason: unresolved(UNRESOLVED_CODE.invalid_value, 'order'),
      };
    }
    seen.add(child.fields.order);
    return child;
  });
  return {
    ok: true,
    mapped: {
      sourcePlatform: seam.sourcePlatform,
      name: seam.label,
      type: type.value as WorkoutPlanTypeValue,
      durationEstimateMinutes: duration.value,
      programSourceId: program.value,
      weekIndex,
      dayIndex,
      exercises: deduped,
      tags,
    },
  };
}

function interpretExercise(
  rules: ExerciseItemRules,
  item: unknown,
  ordinal: number,
  parentSourceId: string,
): MappedExerciseChild {
  const payload = (
    item === null || typeof item !== 'object' || Array.isArray(item) ? {} : item
  ) as Prisma.JsonValue;
  const id = textField(payload, rules.id, 'id');
  const identity = childSourceId(
    parentSourceId,
    id.ok && id.value !== null ? { id: id.value } : { ordinal },
  );
  const fail = (reason: string): MappedExerciseChild => ({
    childSourceId: identity,
    ordinal,
    ok: false,
    reason,
  });
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return fail(unresolved(UNRESOLVED_CODE.invalid_value, 'exercises'));
  }
  const ref = textField(payload, rules.exerciseRef, 'exercise_external_id');
  if (!ref.ok || ref.value === null) return fail(unresolved(UNRESOLVED_CODE.exercise_reference));
  const order = integerField(payload, rules.order, 'order', { min: 0, prescription: false });
  if (!order.ok) return fail(order.reason);
  const sets = integerField(payload, rules.sets, 'sets', { min: 1, prescription: true });
  if (!sets.ok) return fail(sets.reason);
  if (sets.value === null) return fail(missing('sets'));
  const tags: string[] = [];
  if (sets.defaulted) tags.push(CREATED_TAG.defaulted('sets'));
  const reps = integerField(payload, rules.reps, 'reps_or_duration_seconds', {
    min: 1,
    prescription: true,
  });
  if (!reps.ok) return fail(reps.reason);
  let prescription: number;
  if (reps.value !== null) {
    prescription = reps.value;
    if (reps.defaulted) tags.push(CREATED_TAG.defaulted('reps_or_duration_seconds'));
  } else {
    const seconds = durationField(
      payload,
      rules.durationSeconds,
      'reps_or_duration_seconds',
      'seconds',
      1,
    );
    if (!seconds.ok) return fail(seconds.reason);
    if (seconds.value === null) return fail(missing('reps_or_duration_seconds'));
    prescription = seconds.value;
    tags.push(CREATED_TAG.prescription_time);
  }
  const weight = weightField(payload, rules.weight, 'weight_lbs');
  if (!weight.ok) return fail(weight.reason);
  const rest = durationField(payload, rules.restSeconds, 'rest_seconds', 'seconds', 0);
  if (!rest.ok) return fail(rest.reason);
  const group = textField(payload, rules.groupKey, 'superset_group_id');
  if (!group.ok) return fail(group.reason);
  const notes = textField(payload, rules.notes, 'notes');
  if (!notes.ok) return fail(notes.reason);
  return {
    childSourceId: identity,
    ordinal,
    ok: true,
    fields: {
      exerciseRef: ref.value,
      order: order.value ?? ordinal,
      sets: sets.value,
      repsOrDurationSeconds: prescription,
      weightLbs: weight.value,
      restSeconds: rest.value,
      supersetGroupId: group.value === null ? null : supersetGroupId(parentSourceId, group.value),
      notes: notes.value,
      tags,
    },
  };
}

// ---------------------------------------------------------------------------
// Strict rule-set validation (load-time, fail closed; mirrors S8-A's parser posture).

const RULE_KINDS: readonly RuleKind[] = [
  'text',
  'identifier',
  'integer',
  'count',
  'enum',
  'flag',
  'duration',
  'weight',
];
const PROGRAM_FIELDS: Readonly<Record<keyof ProgramNativeRules, readonly RuleKind[]>> = {
  description: ['text'],
  weeks: ['integer', 'count'],
  daysPerWeek: ['integer', 'count'],
  archived: ['flag'],
};
const WORKOUT_FIELDS: Readonly<
  Record<Exclude<keyof WorkoutNativeRules, 'exercises'>, readonly RuleKind[]>
> = {
  type: ['enum'],
  durationEstimateMinutes: ['duration', 'integer'],
  programSourceId: ['identifier'],
  weekIndex: ['integer'],
  dayIndex: ['integer'],
  archived: ['flag'],
};
const EXERCISE_FIELDS: Readonly<Record<keyof ExerciseItemRules, readonly RuleKind[]>> = {
  id: ['identifier'],
  exerciseRef: ['identifier'],
  order: ['integer'],
  sets: ['integer'],
  reps: ['integer'],
  durationSeconds: ['duration', 'integer'],
  weight: ['weight'],
  restSeconds: ['duration', 'integer'],
  groupKey: ['identifier'],
  notes: ['text'],
};

/**
 * S9-C (Addendum C-6): the closed set of native rule field keys a source may declare — every
 * `<field>` qualifier the rule interpreters emit (`missing_required_field:<field>`,
 * `invalid_value:<field>`, `enum_unmapped:<field>`, `prescription_not_integral:<field>`) is either
 * one of these keys or a native column name. Derived from the grammar tables above; additive
 * export, nothing else here changes.
 */
const WORKOUT_EXERCISES_KEY: keyof WorkoutNativeRules = 'exercises';
export const NATIVE_RULE_FIELDS: readonly string[] = Array.from(
  new Set<string>([
    ...Object.keys(PROGRAM_FIELDS),
    ...Object.keys(WORKOUT_FIELDS),
    WORKOUT_EXERCISES_KEY,
    ...Object.keys(EXERCISE_FIELDS),
  ]),
);

class InvalidNativeRuleSet extends Error {
  constructor(origin: string, detail: string) {
    super(`invalid native rule set ${origin}: ${detail}`);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  origin: string,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      throw new InvalidNativeRuleSet(origin, `${where}.${key} is not a known key`);
  }
}

function parsePaths(raw: unknown, origin: string, where: string): Paths {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new InvalidNativeRuleSet(origin, `${where}.paths must be a non-empty array`);
  return raw.map((path, i) => {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.some((k) => typeof k !== 'string' || k.length === 0)
    ) {
      throw new InvalidNativeRuleSet(
        origin,
        `${where}.paths[${i}] must be a non-empty array of non-empty strings`,
      );
    }
    return Object.freeze([...(path as string[])]);
  });
}

function parseRule(
  raw: unknown,
  allowedKinds: readonly RuleKind[],
  origin: string,
  where: string,
): NativeRule {
  const obj = asObject(raw);
  if (obj === null) throw new InvalidNativeRuleSet(origin, `${where} must be an object`);
  const kind = obj.kind;
  if (typeof kind !== 'string' || !RULE_KINDS.includes(kind as RuleKind)) {
    throw new InvalidNativeRuleSet(origin, `${where}.kind must be one of ${RULE_KINDS.join('|')}`);
  }
  if (!allowedKinds.includes(kind as RuleKind)) {
    throw new InvalidNativeRuleSet(origin, `${where}.kind ${kind} is not allowed for this field`);
  }
  const paths = parsePaths(obj.paths, origin, where);
  switch (kind as RuleKind) {
    case 'text':
    case 'identifier':
    case 'count':
      exactKeys(obj, ['kind', 'paths'], origin, where);
      return Object.freeze({ kind: kind as 'text' | 'identifier' | 'count', paths });
    case 'integer': {
      exactKeys(obj, ['kind', 'paths', 'base', 'default'], origin, where);
      if (obj.base !== undefined && obj.base !== 0 && obj.base !== 1)
        throw new InvalidNativeRuleSet(origin, `${where}.base must be 0 or 1`);
      if (obj.default !== undefined && !Number.isInteger(obj.default))
        throw new InvalidNativeRuleSet(origin, `${where}.default must be an integer`);
      return Object.freeze({
        kind: 'integer',
        paths,
        ...(obj.base === undefined ? {} : { base: obj.base as 0 | 1 }),
        ...(obj.default === undefined ? {} : { default: obj.default as number }),
      });
    }
    case 'enum': {
      exactKeys(obj, ['kind', 'paths', 'map', 'default'], origin, where);
      const map = asObject(obj.map);
      if (map === null || Object.keys(map).length === 0)
        throw new InvalidNativeRuleSet(origin, `${where}.map must be a non-empty object`);
      for (const [k, v] of Object.entries(map)) {
        if (k.length === 0 || typeof v !== 'string' || v.length === 0)
          throw new InvalidNativeRuleSet(origin, `${where}.map values must be non-empty strings`);
      }
      if (
        obj.default !== undefined &&
        (typeof obj.default !== 'string' || !Object.values(map).includes(obj.default))
      ) {
        throw new InvalidNativeRuleSet(
          origin,
          `${where}.default must be one of the mapped canonical values`,
        );
      }
      return Object.freeze({
        kind: 'enum',
        paths,
        map: Object.freeze({ ...(map as Record<string, string>) }),
        ...(obj.default === undefined ? {} : { default: obj.default as string }),
      });
    }
    case 'flag': {
      exactKeys(obj, ['kind', 'paths', 'truthy'], origin, where);
      if (
        !Array.isArray(obj.truthy) ||
        obj.truthy.length === 0 ||
        obj.truthy.some((v) => !['string', 'number', 'boolean'].includes(typeof v))
      ) {
        throw new InvalidNativeRuleSet(
          origin,
          `${where}.truthy must be a non-empty array of scalars`,
        );
      }
      return Object.freeze({
        kind: 'flag',
        paths,
        truthy: Object.freeze([...(obj.truthy as Scalar[])]),
      });
    }
    case 'duration': {
      exactKeys(obj, ['kind', 'paths', 'unit'], origin, where);
      if (obj.unit !== 'seconds' && obj.unit !== 'minutes')
        throw new InvalidNativeRuleSet(origin, `${where}.unit must be seconds|minutes`);
      return Object.freeze({ kind: 'duration', paths, unit: obj.unit });
    }
    case 'weight': {
      exactKeys(obj, ['kind', 'paths', 'unit'], origin, where);
      if (obj.unit !== 'lb' && obj.unit !== 'kg')
        throw new InvalidNativeRuleSet(origin, `${where}.unit must be lb|kg`);
      return Object.freeze({ kind: 'weight', paths, unit: obj.unit });
    }
  }
}

function parseFieldRules<K extends string>(
  raw: unknown,
  fields: Readonly<Record<K, readonly RuleKind[]>>,
  origin: string,
  where: string,
): Partial<Record<K, NativeRule>> {
  const obj = asObject(raw);
  if (obj === null) throw new InvalidNativeRuleSet(origin, `${where} must be an object`);
  const out: Partial<Record<K, NativeRule>> = {};
  for (const [field, rule] of Object.entries(obj)) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) {
      throw new InvalidNativeRuleSet(origin, `${where}.${field} is not a native field`);
    }
    out[field as K] = parseRule(rule, fields[field as K], origin, `${where}.${field}`);
  }
  return out;
}

/** Parse + freeze one rule set. Malformed data is a loud load-time error, never a row-time guess. */
export function parseNativeRuleSet(raw: unknown, origin: string): NativeRuleSet {
  const obj = asObject(raw);
  if (obj === null) throw new InvalidNativeRuleSet(origin, 'rule set must be an object');
  exactKeys(obj, ['specVersion', 'sourcePlatform', 'families'], origin, 'ruleSet');
  if (obj.specVersion !== 1) throw new InvalidNativeRuleSet(origin, 'specVersion must be 1');
  if (typeof obj.sourcePlatform !== 'string' || obj.sourcePlatform.length === 0) {
    throw new InvalidNativeRuleSet(origin, 'sourcePlatform must be a non-empty string');
  }
  const families = asObject(obj.families);
  if (families === null) throw new InvalidNativeRuleSet(origin, 'families must be an object');
  exactKeys(families, ['programs', 'workouts'], origin, 'families');
  const out: { programs?: ProgramNativeRules; workouts?: WorkoutNativeRules } = {};
  if (families.programs !== undefined) {
    out.programs = Object.freeze(
      parseFieldRules(families.programs, PROGRAM_FIELDS, origin, 'families.programs'),
    );
  }
  if (families.workouts !== undefined) {
    const w = asObject(families.workouts);
    if (w === null) throw new InvalidNativeRuleSet(origin, 'families.workouts must be an object');
    const { exercises, ...scalar } = w;
    const parsed: { -readonly [K in keyof WorkoutNativeRules]?: WorkoutNativeRules[K] } =
      parseFieldRules(scalar, WORKOUT_FIELDS, origin, 'families.workouts');
    if (exercises !== undefined) {
      const ex = asObject(exercises);
      if (ex === null)
        throw new InvalidNativeRuleSet(origin, 'families.workouts.exercises must be an object');
      exactKeys(ex, ['paths', 'item'], origin, 'families.workouts.exercises');
      parsed.exercises = Object.freeze({
        paths: parsePaths(ex.paths, origin, 'families.workouts.exercises'),
        item: Object.freeze(
          parseFieldRules(ex.item, EXERCISE_FIELDS, origin, 'families.workouts.exercises.item'),
        ),
      });
    }
    out.workouts = Object.freeze(parsed);
  }
  return Object.freeze({
    specVersion: 1,
    sourcePlatform: obj.sourcePlatform,
    families: Object.freeze(out),
  });
}
