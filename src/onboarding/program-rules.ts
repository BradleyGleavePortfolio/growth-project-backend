/**
 * C07 — pure program selection rule table (first match wins).
 *
 * Ported from the draft fixture `seed/clinic-programs.v1.json`
 * (selection.rules). The seed loader refuses a fixture whose rules differ
 * from this table (`assertFixtureRulesMatch`), so code and content cannot
 * drift silently.
 *
 * Inputs: experience (T1) x days per week (S1) x where you train (S3) and
 * home equipment (S3b) x injury (T3/T3a) x readiness screening (P1-P7).
 * Goal, sex, age, sleep, session length, preferred time and enjoyment never
 * affect selection.
 */

export const PROGRAM_KEYS = [
  'steady-foundations',
  'considered-strength',
  'strength-and-balance',
] as const;
export type ProgramKey = (typeof PROGRAM_KEYS)[number];

export type EquipmentDomain = 'gym' | 'home-dumbbells' | 'limited' | 'mixed-unconfirmed';
export type EquipmentVariant = 'supported-unloaded' | 'gym' | 'home-dumbbells';

export interface SelectionAnswers {
  T1?: unknown;
  S1?: unknown;
  S3?: unknown;
  S3b?: unknown;
  T3?: unknown;
  T3a?: unknown;
  P1?: unknown;
  P2?: unknown;
  P3?: unknown;
  P4?: unknown;
  P5?: unknown;
  P6?: unknown;
  P7?: unknown;
}

export interface SelectionInputs {
  any_injury_or_readiness_yes: boolean;
  any_required_selection_input_unknown_or_invalid: boolean;
  days_per_week: number;
  experience: string;
  equipment_domain: EquipmentDomain;
}

type DaysRule = { constant: number } | { capped_at: number } | { use_requested: true };

export interface ProgramRule {
  priority: number;
  when: Partial<{
    any_injury_or_readiness_yes: true;
    any_required_selection_input_unknown_or_invalid: true;
    days_per_week: number[];
    experience: string[];
    equipment_domain: EquipmentDomain[];
    default: true;
  }>;
  program_key: ProgramKey;
  days: DaysRule;
  equipment_variant: EquipmentVariant | 'from_domain';
  review: boolean;
  overlay: 'extra-care' | null;
}

export const PROGRAM_RULES: readonly ProgramRule[] = Object.freeze([
  {
    priority: 1,
    when: { any_injury_or_readiness_yes: true },
    program_key: 'steady-foundations',
    days: { constant: 2 },
    equipment_variant: 'supported-unloaded',
    review: true,
    overlay: 'extra-care',
  },
  {
    priority: 2,
    when: { any_required_selection_input_unknown_or_invalid: true },
    program_key: 'steady-foundations',
    days: { constant: 2 },
    equipment_variant: 'supported-unloaded',
    review: true,
    overlay: 'extra-care',
  },
  {
    priority: 3,
    when: { days_per_week: [2] },
    program_key: 'steady-foundations',
    days: { constant: 2 },
    equipment_variant: 'supported-unloaded',
    review: false,
    overlay: null,
  },
  {
    priority: 4,
    when: { equipment_domain: ['limited', 'mixed-unconfirmed'] },
    program_key: 'steady-foundations',
    days: { capped_at: 3 },
    equipment_variant: 'supported-unloaded',
    review: false,
    overlay: null,
  },
  {
    priority: 5,
    when: {
      experience: ['intermediate', 'advanced'],
      days_per_week: [4, 5],
      equipment_domain: ['gym'],
    },
    program_key: 'strength-and-balance',
    days: { use_requested: true },
    equipment_variant: 'gym',
    review: false,
    overlay: null,
  },
  {
    priority: 6,
    when: { days_per_week: [3, 4, 5], equipment_domain: ['gym', 'home-dumbbells'] },
    program_key: 'considered-strength',
    days: { capped_at: 4 },
    equipment_variant: 'from_domain',
    review: false,
    overlay: null,
  },
  {
    priority: 7,
    when: { default: true },
    program_key: 'steady-foundations',
    days: { constant: 2 },
    equipment_variant: 'supported-unloaded',
    review: true,
    overlay: 'extra-care',
  },
]);

const isYes = (v: unknown) => v === 'yes' || v === true;
const isNo = (v: unknown) => v === 'no' || v === false;
const EXPERIENCES = ['beginner', 'intermediate', 'advanced'];
const LOCATIONS = ['gym', 'home', 'home_some', 'none', 'both', 'mix'];
const HOME_EQUIPMENT = [
  'dumbbells',
  'kettlebells',
  'resistance_bands',
  'barbell',
  'pull_up_bar',
  'cardio_machine',
  'other',
];

export function equipmentDomain(a: SelectionAnswers): EquipmentDomain {
  if (a.S3 === 'gym') return 'gym';
  if (a.S3 === 'both' || a.S3 === 'mix') return 'mixed-unconfirmed';
  if (
    (a.S3 === 'home' || a.S3 === 'home_some') &&
    Array.isArray(a.S3b) &&
    a.S3b.includes('dumbbells')
  ) {
    return 'home-dumbbells';
  }
  return 'limited';
}

export function selectionInputs(a: SelectionAnswers): SelectionInputs {
  const screening = [a.P1, a.P2, a.P3, a.P4, a.P5, a.P6, a.P7];
  const injury = isYes(a.T3) || (Array.isArray(a.T3a) && a.T3a.length > 0);
  const needsEquipment = a.S3 === 'home' || a.S3 === 'home_some';
  const days = Number(a.S1);
  const unknown =
    typeof a.T1 !== 'string' ||
    !EXPERIENCES.includes(a.T1) ||
    ![2, 3, 4, 5].includes(days) ||
    (typeof a.S1 !== 'number' && typeof a.S1 !== 'string') ||
    typeof a.S3 !== 'string' ||
    !LOCATIONS.includes(a.S3) ||
    !(isYes(a.T3) || isNo(a.T3)) ||
    screening.some((v) => !(isYes(v) || isNo(v))) ||
    (needsEquipment &&
      (!Array.isArray(a.S3b) ||
        a.S3b.some((v) => typeof v !== 'string' || !HOME_EQUIPMENT.includes(v)) ||
        (a.S3 === 'home_some' && a.S3b.length === 0))) ||
    (a.T3a !== undefined && !Array.isArray(a.T3a));
  return {
    any_injury_or_readiness_yes: injury || screening.some(isYes),
    any_required_selection_input_unknown_or_invalid: unknown,
    days_per_week: days,
    experience: typeof a.T1 === 'string' ? a.T1 : '',
    equipment_domain: equipmentDomain(a),
  };
}

function matches(rule: ProgramRule, i: SelectionInputs): boolean {
  return Object.entries(rule.when).every(([key, value]) => {
    if (key === 'default') return value === true;
    const actual = i[key as keyof SelectionInputs];
    return Array.isArray(value) ? (value as unknown[]).includes(actual) : actual === value;
  });
}

export interface ProgramSelection {
  program_key: ProgramKey;
  rule_priority: number;
  requested_days: number;
  selected_days: number;
  equipment_variant: EquipmentVariant;
  overlay: 'extra-care' | null;
  coach_review_required: boolean;
  inputs: SelectionInputs;
}

export function selectProgram(a: SelectionAnswers): ProgramSelection {
  const inputs = selectionInputs(a);
  const rule = PROGRAM_RULES.find((r) => matches(r, inputs));
  if (!rule) throw new Error('program rule table is not exhaustive');
  const d = rule.days;
  const selected =
    'constant' in d
      ? d.constant
      : 'capped_at' in d
        ? Math.min(inputs.days_per_week, d.capped_at)
        : inputs.days_per_week;
  const variant: EquipmentVariant =
    rule.equipment_variant === 'from_domain'
      ? inputs.equipment_domain === 'home-dumbbells'
        ? 'home-dumbbells'
        : 'gym'
      : rule.equipment_variant;
  return {
    program_key: rule.program_key,
    rule_priority: rule.priority,
    requested_days: inputs.days_per_week,
    selected_days: selected,
    equipment_variant: variant,
    overlay: rule.overlay,
    coach_review_required: rule.review,
    inputs,
  };
}

/** Why templates keyed as in the fixture's why_template_contract. */
export type WhyTemplates = Record<string, string[]>;

export function whyReasons(sel: ProgramSelection, templates: WhyTemplates): string[] {
  const p = sel.rule_priority;
  const key = p === 2 || p === 7 ? 'rule_2_or_7' : `rule_${p}`;
  const t = templates[key];
  if (!Array.isArray(t) || t.length !== 3) throw new Error(`missing why templates for ${key}`);
  const equipmentLabel =
    sel.equipment_variant === 'home-dumbbells' ? 'home dumbbells' : 'gym facilities';
  return t.map((s) =>
    s
      .replace(/\{selected_days\}/g, String(sel.selected_days))
      .replace(/\{requested_days\}/g, String(sel.requested_days))
      .replace(/\{experience\}/g, sel.inputs.experience)
      .replace(/\{equipment_label\}/g, equipmentLabel),
  );
}
