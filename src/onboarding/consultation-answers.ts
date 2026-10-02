/**
 * Consultation answers (contract "consult-v1"), pure validation and mapping.
 *
 * Screen keys follow the approved prototype (W1 ... C1). Every key has a
 * strict validator; unknown keys are rejected so the intake record never
 * stores free-form junk. `null` in a PUT means "clear this answer".
 *
 * Exact value shapes are documented in docs/clinic-onboarding.md.
 */
import { ageInYears, LBS_PER_KG } from '../macros/macro-calculator';
import type { SelectionAnswers } from './program-rules';
import { Logger } from '@nestjs/common';
import {
  CONSULT_CONSENT_V3,
  consultConsentTextSha256,
  unknownConsultConsentVersions,
} from './consult-consent-copy';

export const CONSULTATION_VERSION = 'consult-v1';

/**
 * P0 consent copy versions the server accepts as "current". P0 is box 1 of
 * the D2 consent screen (operator ruling 2026-10-01): the training waiver
 * plus collection and use of the client's information by The Growth Project
 * and their coach for coaching. The mobile app (#310) sends
 * `{ agreed: true, copy_version: 'consult-consent-v3', agreed_at, text_sha256 }`
 * where `text_sha256` is the sha256 of the whole screen it showed
 * (consult-consent-copy.ts). A P0 counts only when BOTH match: an accepted
 * version and that version's pinned text digest (`isCurrentConsentAnswer`).
 *
 * v3 only (no live client ever recorded v2). CONSULT_CONSENT_COPY_VERSIONS
 * (comma-separated) may narrow or widen the accepted set, but only among the
 * versions whose exact text the server knows (CONSULT_CONSENT_COPIES): an
 * unknown name can never be verified, so it is ignored (logged once as a
 * warning), and a list with no known name falls back to the default.
 *
 * Box 2 (optional AI processing by Anthropic) is NOT part of P0: it is
 * recorded by the AI consent ledger (`POST /me/ai-consent/roman`), is never
 * stored on the intake, and is never required by this module.
 */
export const DEFAULT_CONSULT_CONSENT_COPY_VERSION = CONSULT_CONSENT_V3;

const warnedConsentVersionLists = new Set<string>();

export function acceptedConsentVersions(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CONSULT_CONSENT_COPY_VERSIONS;
  if (!raw) return [DEFAULT_CONSULT_CONSENT_COPY_VERSION];
  const unknown = unknownConsultConsentVersions(raw);
  if (unknown.length > 0 && !warnedConsentVersionLists.has(raw)) {
    warnedConsentVersionLists.add(raw);
    new Logger('Onboarding').warn(
      `CONSULT_CONSENT_COPY_VERSIONS lists ${unknown.join(', ')}, which the server has no consent text for; those names are ignored`,
    );
  }
  const list = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && consultConsentTextSha256(v) !== null);
  return list.length > 0 ? [...new Set(list)] : [DEFAULT_CONSULT_CONSENT_COPY_VERSION];
}

/**
 * The copy version a P0 acknowledgement proves the client agreed to, or null
 * when it proves nothing current: `agreed === true`, an accepted copy version,
 * and `text_sha256` equal to that version's pinned full-screen digest. A
 * missing or different digest means the server cannot tell what was shown,
 * so it is not consent.
 */
export function currentConsentVersionOf(
  p0: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (typeof p0 !== 'object' || p0 === null || Array.isArray(p0)) return null;
  const o = p0 as Record<string, unknown>;
  if (o.agreed !== true) return null;
  const version = consentCopyVersion(o);
  if (!version || !acceptedConsentVersions(env).includes(version)) return null;
  const pinned = consultConsentTextSha256(version);
  return pinned !== null && o.text_sha256 === pinned ? version : null;
}

export function isCurrentConsentAnswer(p0: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return currentConsentVersionOf(p0, env) !== null;
}

export type AnswerValue = string | number | boolean | string[] | Record<string, unknown>;
export type Answers = Record<string, AnswerValue>;

const YES_NO = ['yes', 'no'] as const;
const NOTE_MAX = 280;
const OTHER_MAX = 140;

type Validator = (v: unknown, now: Date) => string | null; // returns error or null

function oneOf(values: readonly string[]): Validator {
  return (v) =>
    typeof v === 'string' && values.includes(v) ? null : `must be one of ${values.join(', ')}`;
}

function listOf(
  values: readonly string[],
  opts: { min?: number; max?: number; exclusive?: string } = {},
): Validator {
  return (v) => {
    if (!Array.isArray(v)) return 'must be an array';
    if (v.some((x) => typeof x !== 'string' || !values.includes(x))) {
      return `items must be from ${values.join(', ')}`;
    }
    if (new Set(v).size !== v.length) return 'items must be unique';
    if (opts.min !== undefined && v.length < opts.min) return `needs at least ${opts.min}`;
    if (opts.max !== undefined && v.length > opts.max) return `at most ${opts.max}`;
    if (opts.exclusive && v.includes(opts.exclusive) && v.length > 1)
      return `${opts.exclusive} is exclusive`;
    return null;
  };
}

function text(max: number): Validator {
  return (v) =>
    typeof v === 'string' && v.length <= max ? null : `must be text up to ${max} characters`;
}

function isoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

function weightObject(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'must be an object';
  const o = v as Record<string, unknown>;
  const allowed = ['height_cm', 'weight_lbs', 'weight_kg', 'unit'];
  if (Object.keys(o).some((k) => !allowed.includes(k))) return `keys must be ${allowed.join(', ')}`;
  if (o.unit !== undefined && o.unit !== 'imperial' && o.unit !== 'metric')
    return 'unit must be imperial or metric';
  const h = o.height_cm;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 90 || h > 250)
    return 'height_cm must be 90-250';
  const hasLbs = o.weight_lbs !== undefined;
  const hasKg = o.weight_kg !== undefined;
  if (hasLbs === hasKg) return 'exactly one of weight_lbs or weight_kg';
  const lbs = hasLbs
    ? o.weight_lbs
    : typeof o.weight_kg === 'number'
      ? o.weight_kg * LBS_PER_KG
      : NaN;
  if (typeof lbs !== 'number' || !Number.isFinite(lbs) || lbs < 60 || lbs > 1000)
    return 'weight must be 60-1000 lb';
  return null;
}

const P0_KEYS = ['agreed', 'copy_version', 'version', 'agreed_at', 'text_sha256'];

/** The P0 copy version (mobile sends copy_version; version is accepted too). */
export function consentCopyVersion(o: Record<string, unknown>): string | null {
  const v =
    typeof o.copy_version === 'string'
      ? o.copy_version
      : typeof o.version === 'string'
        ? o.version
        : null;
  return v && v.length > 0 ? v : null;
}

export const SCREENING_KEYS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const;
export const HOME_EQUIPMENT = [
  'dumbbells',
  'kettlebells',
  'resistance_bands',
  'barbell',
  'pull_up_bar',
  'cardio_machine',
  'other',
] as const;
export const LOCATIONS = ['gym', 'home_some', 'none', 'mix', 'home', 'both'] as const;
export const EXPERIENCES = ['beginner', 'intermediate', 'advanced'] as const;
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

export const VALIDATORS: Readonly<Record<string, Validator>> = {
  G1: oneOf(['fat_loss', 'muscle_gain', 'maintenance', 'performance']),
  G2: listOf(['energy', 'strength', 'confidence', 'family', 'event', 'longevity', 'other'], {
    max: 3,
  }),
  G2_other: text(OTHER_MAX),
  B1: oneOf(['male', 'female', 'prefer_not_to_say']),
  B2: (v, now) => {
    const d = isoDate(v);
    if (!d) return 'must be YYYY-MM-DD';
    const age = ageInYears(d, now);
    return age >= 16 && age <= 100 ? null : 'age must be 16-100';
  },
  // { height_cm, weight_lbs, unit } (mobile always sends lbs; unit is the
  // display preference). weight_kg is accepted instead of weight_lbs.
  B3: (v) => weightObject(v),
  // Goal weight in lbs (optional screen; null clears it).
  B4: (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 60 && v <= 1000
      ? null
      : 'must be 60-1000 lb',
  L1: oneOf(['sedentary', 'light', 'moderate', 'active', 'very_active']),
  L2: oneOf(['lt_6', '6_7', '7_8', 'gt_8']),
  T1: oneOf(EXPERIENCES),
  T2: listOf(
    ['weights', 'classes', 'running', 'sports', 'yoga_pilates', 'home', 'swim_cycle', 'none'],
    {
      exclusive: 'none',
    },
  ),
  T3: oneOf(YES_NO),
  T3_areas: listOf(INJURY_AREAS),
  T3_note: text(NOTE_MAX),
  T4: oneOf(['20_30', '30_45', '45_60', '60_plus']),
  S1: (v) =>
    (typeof v === 'number' && [2, 3, 4, 5].includes(v)) ||
    (typeof v === 'string' && ['2', '3', '4', '5'].includes(v))
      ? null
      : 'must be 2, 3, 4 or 5 (2 means "1 to 2", 5 means "5 or more")',
  S2: oneOf(['morning', 'midday', 'evening', 'varies']),
  S3: oneOf(LOCATIONS),
  S3b: listOf(HOME_EQUIPMENT),
  N1: oneOf(['none', 'vegetarian', 'vegan', 'pescatarian', 'keto', 'paleo', 'other']),
  N2: listOf(
    [
      'nothing',
      'dairy',
      'gluten',
      'nuts',
      'shellfish',
      'eggs',
      'soy',
      'pork',
      'halal',
      'kosher',
      'other',
    ],
    { min: 1, exclusive: 'nothing' },
  ),
  N2_other: text(OTHER_MAX),
  N3: (v) =>
    (typeof v === 'number' && [2, 3, 4, 5].includes(v)) ||
    (typeof v === 'string' && ['2', '3', '4', '5'].includes(v))
      ? null
      : 'must be 2, 3, 4 or 5',
  N4: oneOf(['never', 'some', 'regular']),
  N5: listOf(['time', 'cravings', 'eating_out', 'late_nights', 'not_sure', 'other'], { max: 3 }),
  P0: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      return 'must be { agreed: true, copy_version }';
    const o = v as Record<string, unknown>;
    if (Object.keys(o).some((k) => !P0_KEYS.includes(k)))
      return `keys must be ${P0_KEYS.join(', ')}`;
    if (o.agreed !== true) return 'agreed must be true';
    const ver = consentCopyVersion(o);
    if (!ver || ver.length > 40) return 'copy_version is required';
    if (
      o.agreed_at !== undefined &&
      (typeof o.agreed_at !== 'string' || Number.isNaN(Date.parse(o.agreed_at)))
    ) {
      return 'agreed_at must be an ISO timestamp';
    }
    if (
      o.text_sha256 !== undefined &&
      (typeof o.text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.text_sha256))
    ) {
      return 'text_sha256 must be a lowercase hex sha256';
    }
    return null;
  },
  ...Object.fromEntries(SCREENING_KEYS.map((k) => [k, oneOf(YES_NO)])),
  ...Object.fromEntries(SCREENING_KEYS.map((k) => [`${k}_note`, text(NOTE_MAX)])),
  C1: (v, now) => {
    const d = isoDate(v);
    if (!d) return 'must be YYYY-MM-DD';
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const diffDays = Math.round((d.getTime() - today) / 86_400_000);
    // One day of slack either side for time zones; at most two weeks ahead.
    return diffDays >= -1 && diffDays <= 14
      ? null
      : 'first session must be within the next 14 days';
  },
};

/** True only for answer ids this version defines (own keys, never prototype keys). */
export function isAnswerKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, key);
}

export interface AnswerError {
  key: string;
  message: string;
}

/** Validate a partial answer patch. `null` values are allowed (clear). */
export function validateAnswerPatch(patch: Record<string, unknown>, now: Date): AnswerError[] {
  const errors: AnswerError[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const validator = isAnswerKey(key) ? VALIDATORS[key] : undefined;
    if (!validator) {
      errors.push({ key, message: 'unknown answer key' });
      continue;
    }
    if (value === null) continue;
    const err = validator(value, now);
    if (err) errors.push({ key, message: err });
  }
  return errors;
}

/** Merge a validated patch onto stored answers; null clears a key. */
export function mergeAnswers(stored: Answers, patch: Record<string, unknown>): Answers {
  // Built through a Map keyed only by known answer ids, so a client-chosen
  // key (e.g. "__proto__") can never become a property write.
  const merged = new Map<string, AnswerValue>();
  for (const [k, v] of Object.entries(stored)) if (isAnswerKey(k)) merged.set(k, v);
  for (const [k, v] of Object.entries(patch)) {
    if (!isAnswerKey(k)) continue;
    if (v === null) merged.delete(k);
    else merged.set(k, v as AnswerValue);
  }
  const out: Answers = Object.fromEntries(merged);
  // Dependent answers that no longer apply are dropped so they cannot
  // influence selection or the coach flag.
  if (out.T3 !== 'yes') {
    delete out.T3_areas;
    delete out.T3_note;
  }
  if (out.S3 !== 'home_some' && out.S3 !== 'home') delete out.S3b;
  for (const k of SCREENING_KEYS) if (out[k] !== 'yes') delete out[`${k}_note`];
  return out;
}

export const CHAPTERS: ReadonlyArray<{ key: string; required: (a: Answers) => string[] }> = [
  { key: 'goals', required: () => ['G1'] },
  { key: 'body', required: () => ['B1', 'B2', 'B3'] },
  { key: 'lifestyle', required: () => ['L1'] },
  { key: 'training', required: (a) => (a.T3 === 'yes' ? ['T1', 'T3', 'T3_areas'] : ['T1', 'T3']) },
  {
    key: 'schedule',
    required: (a) => (a.S3 === 'home_some' || a.S3 === 'home' ? ['S1', 'S3', 'S3b'] : ['S1', 'S3']),
  },
  { key: 'nutrition', required: () => ['N1', 'N2'] },
  { key: 'safety', required: () => ['P0', ...SCREENING_KEYS] },
  { key: 'commitment', required: () => ['C1'] },
];

function present(a: Answers, key: string): boolean {
  const v = a[key];
  if (v === undefined || v === null) return false;
  if (key === 'T3_areas' && Array.isArray(v)) return v.length > 0;
  if (key === 'S3b' && Array.isArray(v)) return a.S3 === 'home' || v.length > 0;
  return true;
}

export function completedChapters(a: Answers): string[] {
  return CHAPTERS.filter((c) => c.required(a).every((k) => present(a, k))).map((c) => c.key);
}

/** Every required key that is missing, P0 excluded (it has its own 409 code). */
export function missingRequired(a: Answers): string[] {
  const out: string[] = [];
  for (const c of CHAPTERS)
    for (const k of c.required(a)) if (k !== 'P0' && !present(a, k)) out.push(k);
  return out;
}

export function screeningAnyYes(a: Answers): boolean {
  return SCREENING_KEYS.some((k) => a[k] === 'yes');
}

export function injuryFlag(a: Answers): boolean {
  return a.T3 === 'yes' || (Array.isArray(a.T3_areas) && a.T3_areas.length > 0);
}

function weightLbs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 10) / 10;
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.weight_lbs === 'number') return Math.round(o.weight_lbs * 10) / 10;
  if (typeof o.weight_kg === 'number') return Math.round(o.weight_kg * LBS_PER_KG * 10) / 10;
  return undefined;
}

/**
 * Map answers onto existing UserProfile columns (contract §1). Screening
 * answers are NEVER mapped onto the profile; they live only in the intake.
 */
export function profileFieldsFromAnswers(a: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof a.B1 === 'string') out.sex = a.B1;
  if (typeof a.B2 === 'string') out.date_of_birth = new Date(`${a.B2}T00:00:00.000Z`);
  if (a.B3 && typeof a.B3 === 'object' && !Array.isArray(a.B3)) {
    const b3 = a.B3 as Record<string, unknown>;
    if (typeof b3.height_cm === 'number') out.height_cm = b3.height_cm;
    const w = weightLbs(b3);
    if (w !== undefined) out.current_weight_lbs = w;
  }
  const goalW = weightLbs(a.B4);
  if (goalW !== undefined) out.target_weight_lbs = goalW;
  if (typeof a.L1 === 'string') out.activity_level = a.L1;
  if (typeof a.G1 === 'string') out.goal_type = a.G1;
  if (typeof a.T1 === 'string') out.workout_experience = a.T1;
  if (typeof a.N1 === 'string') out.dietary_pattern = a.N1;
  if (Array.isArray(a.N2)) out.dietary_restrictions = a.N2.filter((x) => x !== 'nothing');
  if (a.S1 !== undefined) out.workout_days_per_week = Number(a.S1);
  if (a.N3 !== undefined) out.meals_per_day = Number(a.N3);
  if (typeof a.S2 === 'string') out.preferred_training_time = a.S2;
  if (a.T3 === 'no') out.injuries = [];
  else if (Array.isArray(a.T3_areas)) out.injuries = a.T3_areas;
  if (typeof a.S3 === 'string') {
    out.has_gym_membership = a.S3 === 'gym' || a.S3 === 'mix' || a.S3 === 'both';
    if (a.S3 === 'gym') out.equipment_access = ['full_gym'];
    else if (a.S3 === 'none') out.equipment_access = ['bodyweight_only'];
    else if (a.S3 === 'mix' || a.S3 === 'both') {
      out.equipment_access = ['full_gym', ...(Array.isArray(a.S3b) ? a.S3b : [])];
    } else if (Array.isArray(a.S3b)) {
      out.equipment_access = a.S3b.length > 0 ? ['home_gym', ...a.S3b] : ['home_gym'];
    }
  }
  return out;
}

/** Macro inputs straight from the answers (single calculator input). */
export function macroRawFromAnswers(a: Answers) {
  const p = profileFieldsFromAnswers(a);
  return {
    current_weight_lbs: typeof p.current_weight_lbs === 'number' ? p.current_weight_lbs : null,
    target_weight_lbs: typeof p.target_weight_lbs === 'number' ? p.target_weight_lbs : null,
    height_cm: typeof p.height_cm === 'number' ? p.height_cm : null,
    date_of_birth: p.date_of_birth instanceof Date ? p.date_of_birth : null,
    sex: typeof p.sex === 'string' ? p.sex : null,
    activity_level: typeof p.activity_level === 'string' ? p.activity_level : null,
    goal_type: typeof p.goal_type === 'string' ? p.goal_type : null,
  };
}

/** Adapter to the rule table's input vocabulary (fixture uses T3a). */
export function selectionAnswersFrom(a: Answers): SelectionAnswers {
  return {
    T1: a.T1,
    S1: a.S1,
    S3: a.S3,
    S3b: a.S3b,
    T3: a.T3,
    T3a: a.T3_areas,
    P1: a.P1,
    P2: a.P2,
    P3: a.P3,
    P4: a.P4,
    P5: a.P5,
    P6: a.P6,
    P7: a.P7,
  };
}

/** C05 item 8: never-trackers see calories + protein only for 7 days. */
export const SIMPLE_MACRO_DAYS = 7;
export function macroDisplayFor(
  a: Answers,
  completedAt: Date | null,
  now: Date,
): { macro_display_mode: 'simple' | 'full'; simple_until: string | null } {
  if (a.N4 !== 'never' || !completedAt) return { macro_display_mode: 'full', simple_until: null };
  const until = new Date(completedAt.getTime() + SIMPLE_MACRO_DAYS * 86_400_000);
  return { macro_display_mode: now < until ? 'simple' : 'full', simple_until: until.toISOString() };
}
