/**
 * C07 — clinic program fixture validation and client-clone materialisation.
 * Pure: no Prisma, no Nest.
 *
 * Contract (fixture backend_model.assignment): select a logical master, then
 * build a client-specific clone owned by the attached coach. Frequency
 * additions, home-equipment overrides and the extra-care overlay are applied
 * to the CLONE before assignProgramToClient, because that method fans out
 * every non-archived plan and freezes snapshots. The master is never mutated.
 */
import { createHash } from 'crypto';
import {
  PROGRAM_KEYS,
  PROGRAM_RULES,
  type ProgramKey,
  type ProgramSelection,
  type WhyTemplates,
} from './program-rules';

export interface ExerciseRow {
  exercise_external_id: string;
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs: number | null;
  rest_seconds: number | null;
  superset_group_id: string | null;
  notes: string | null;
}

export interface PlanData {
  name: string;
  type: 'strength' | 'cardio' | 'mobility';
  duration_estimate_minutes: number | null;
  week_index: number;
  day_index: number;
}

export interface PlanContent {
  data: PlanData;
  exercises: ExerciseRow[];
  /** Master plan id when read from the database (clone lineage). */
  source_plan_id?: string | null;
}

export interface FrequencyVariant {
  days_per_week: number;
  additional_plans: PlanContent[];
}

export interface ExtraCareOverlay {
  native_patch: { sets: number };
  max_reps: number;
  max_duration_seconds: number;
  notes_rpe_override: string;
  notes_suffix: string;
}

/** Stored on ClinicProgramSet.materialisation at seed time. */
export interface Materialisation {
  frequency_variants: Record<string, FrequencyVariant[]>;
  equipment_overrides: Record<
    string,
    Record<string, { by_week: Array<Record<string, Partial<ExerciseRow>>> }>
  >;
  overlays: Record<string, ExtraCareOverlay>;
  why_templates: WhyTemplates;
}

export interface FixtureProgram {
  fixture_key: string;
  data: {
    name: string;
    description: string | null;
    weeks: number;
    days_per_week: number;
    goal_tag: string | null;
  };
  plans: PlanContent[];
  frequency_variants: FrequencyVariant[];
}

export interface ParsedFixture {
  fixture_version: string;
  approval_status: string;
  production_seed_authorized: boolean;
  sha256: string;
  programs: FixtureProgram[];
  materialisation: Materialisation;
  exercise_slugs: string[];
}

export class FixtureError extends Error {}

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new FixtureError(msg);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseExercise(v: unknown, where: string): ExerciseRow {
  req(isObj(v), `${where}: exercise must be an object`);
  req(
    typeof v.exercise_external_id === 'string' && v.exercise_external_id.length > 0,
    `${where}: exercise_external_id`,
  );
  req(Number.isInteger(v.order) && (v.order as number) >= 1, `${where}: order`);
  req(
    Number.isInteger(v.sets) && (v.sets as number) >= 1 && (v.sets as number) <= 10,
    `${where}: sets`,
  );
  req(
    Number.isInteger(v.reps_or_duration_seconds) && (v.reps_or_duration_seconds as number) >= 1,
    `${where}: reps_or_duration_seconds`,
  );
  req(v.weight_lbs === null || typeof v.weight_lbs === 'number', `${where}: weight_lbs`);
  req(v.rest_seconds === null || Number.isInteger(v.rest_seconds), `${where}: rest_seconds`);
  req(
    v.notes === null || (typeof v.notes === 'string' && v.notes.length <= 500),
    `${where}: notes <= 500`,
  );
  return {
    exercise_external_id: v.exercise_external_id as string,
    order: v.order as number,
    sets: v.sets as number,
    reps_or_duration_seconds: v.reps_or_duration_seconds as number,
    weight_lbs: (v.weight_lbs as number | null) ?? null,
    rest_seconds: (v.rest_seconds as number | null) ?? null,
    superset_group_id: typeof v.superset_group_id === 'string' ? v.superset_group_id : null,
    notes: (v.notes as string | null) ?? null,
  };
}

function parsePlan(v: unknown, where: string): PlanContent {
  req(isObj(v) && isObj(v.data) && Array.isArray(v.exercises), `${where}: plan shape`);
  const d = v.data;
  req(typeof d.name === 'string' && d.name.length > 0, `${where}: name`);
  req(d.type === 'strength' || d.type === 'cardio' || d.type === 'mobility', `${where}: type`);
  req(
    Number.isInteger(d.week_index) &&
      (d.week_index as number) >= 0 &&
      (d.week_index as number) <= 3,
    `${where}: week_index 0-3`,
  );
  req(
    Number.isInteger(d.day_index) && (d.day_index as number) >= 0 && (d.day_index as number) <= 6,
    `${where}: day_index 0-6`,
  );
  const exercises = v.exercises.map((e, i) => parseExercise(e, `${where} exercise ${i}`));
  req(exercises.length > 0, `${where}: at least one exercise`);
  return {
    data: {
      name: d.name as string,
      type: d.type as PlanData['type'],
      duration_estimate_minutes:
        typeof d.duration_estimate_minutes === 'number' ? d.duration_estimate_minutes : null,
      week_index: d.week_index as number,
      day_index: d.day_index as number,
    },
    exercises,
  };
}

/** Parse and validate the fixture JSON text. Throws FixtureError. */
export function parseFixture(raw: string): ParsedFixture {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const j: unknown = JSON.parse(raw);
  req(isObj(j), 'fixture must be an object');
  req(typeof j.fixture_version === 'string', 'fixture_version');
  req(typeof j.approval_status === 'string', 'approval_status');
  req(typeof j.production_seed_authorized === 'boolean', 'production_seed_authorized');
  req(Array.isArray(j.programs) && j.programs.length === 3, 'exactly three programs');
  req(Array.isArray(j.exercise_manifest), 'exercise_manifest');
  const slugs = (j.exercise_manifest as unknown[]).map((e) => (isObj(e) ? e.slug : undefined));
  req(
    slugs.every((s) => typeof s === 'string'),
    'exercise_manifest slugs',
  );
  const slugSet = new Set(slugs as string[]);

  const programs: FixtureProgram[] = (j.programs as unknown[]).map((p, pi) => {
    req(
      isObj(p) && isObj(p.data) && Array.isArray(p.plans) && Array.isArray(p.frequency_variants),
      `program ${pi}`,
    );
    req(typeof p.fixture_key === 'string', `program ${pi}: fixture_key`);
    const key = p.fixture_key as string;
    req((PROGRAM_KEYS as readonly string[]).includes(key), `program ${key}: unknown key`);
    const d = p.data;
    req(d.weeks === 4, `${key}: weeks must be 4`);
    req(Number.isInteger(d.days_per_week), `${key}: days_per_week`);
    const plans = p.plans.map((pl, i) => parsePlan(pl, `${key} plan ${i}`));
    const weeksCovered = new Set(plans.map((pl) => pl.data.week_index));
    req(weeksCovered.size === 4, `${key}: plans must cover four weeks`);
    const variants: FrequencyVariant[] = p.frequency_variants.map((fv, vi) => {
      req(
        isObj(fv) && Number.isInteger(fv.days_per_week) && Array.isArray(fv.additional_plans),
        `${key} variant ${vi}`,
      );
      return {
        days_per_week: fv.days_per_week as number,
        additional_plans: fv.additional_plans.map((pl, i) =>
          parsePlan(pl, `${key} variant ${vi} plan ${i}`),
        ),
      };
    });
    req(
      variants.some((v) => v.days_per_week === d.days_per_week && v.additional_plans.length === 0),
      `${key}: default frequency variant`,
    );
    for (const pl of [...plans, ...variants.flatMap((v) => v.additional_plans)]) {
      for (const e of pl.exercises)
        req(
          slugSet.has(e.exercise_external_id),
          `${key}: slug ${e.exercise_external_id} not in manifest`,
        );
    }
    return {
      fixture_key: key,
      data: {
        name: String(d.name),
        description: typeof d.description === 'string' ? d.description : null,
        weeks: 4,
        days_per_week: d.days_per_week as number,
        goal_tag: typeof d.goal_tag === 'string' ? d.goal_tag : null,
      },
      plans,
      frequency_variants: variants,
    };
  });
  req(new Set(programs.map((p) => p.fixture_key)).size === 3, 'program keys must be unique');

  req(isObj(j.selection) && Array.isArray(j.selection.rules), 'selection.rules');
  assertFixtureRulesMatch(j.selection.rules);
  req(isObj(j.selection.why_template_contract), 'why_template_contract');
  const why: WhyTemplates = {};
  for (const [k, v] of Object.entries(j.selection.why_template_contract)) {
    if (k.startsWith('rule_')) {
      req(Array.isArray(v) && v.length === 3 && v.every((s) => typeof s === 'string'), `why ${k}`);
      why[k] = v as string[];
    }
  }
  for (const k of ['rule_1', 'rule_2_or_7', 'rule_3', 'rule_4', 'rule_5', 'rule_6'])
    req(why[k], `why ${k} missing`);

  req(isObj(j.overlays) && isObj(j.overlays['extra-care']), 'overlays.extra-care');
  const oc = j.overlays['extra-care'] as Record<string, unknown>;
  req(
    isObj(oc.native_patch) && Number.isInteger(oc.native_patch.sets),
    'extra-care native_patch.sets',
  );
  req(
    Number.isInteger(oc.max_reps) && Number.isInteger(oc.max_duration_seconds),
    'extra-care caps',
  );
  req(
    typeof oc.notes_rpe_override === 'string' && typeof oc.notes_suffix === 'string',
    'extra-care notes',
  );
  const overlays: Record<string, ExtraCareOverlay> = {
    'extra-care': {
      native_patch: { sets: oc.native_patch.sets as number },
      max_reps: oc.max_reps as number,
      max_duration_seconds: oc.max_duration_seconds as number,
      notes_rpe_override: oc.notes_rpe_override as string,
      notes_suffix: oc.notes_suffix as string,
    },
  };

  req(isObj(j.equipment_overrides), 'equipment_overrides');
  const eo = j.equipment_overrides as Materialisation['equipment_overrides'];
  for (const [pk, variants] of Object.entries(eo)) {
    req(
      (PROGRAM_KEYS as readonly string[]).includes(pk),
      `equipment_overrides: unknown program ${pk}`,
    );
    for (const [vk, v] of Object.entries(variants)) {
      req(
        isObj(v) && Array.isArray(v.by_week) && v.by_week.length === 4,
        `equipment_overrides ${pk}/${vk}`,
      );
      for (const week of v.by_week) {
        for (const patch of Object.values(week)) {
          if (patch.exercise_external_id !== undefined) {
            req(
              slugSet.has(patch.exercise_external_id),
              `override slug ${patch.exercise_external_id}`,
            );
          }
        }
      }
    }
  }

  return {
    fixture_version: j.fixture_version as string,
    approval_status: j.approval_status as string,
    production_seed_authorized: j.production_seed_authorized as boolean,
    sha256,
    programs,
    exercise_slugs: [...slugSet],
    materialisation: {
      frequency_variants: Object.fromEntries(
        programs.map((p) => [p.fixture_key, p.frequency_variants]),
      ),
      equipment_overrides: eo,
      overlays,
      why_templates: why,
    },
  };
}

/** The fixture's rules must equal the code rule table (no silent drift). */
export function assertFixtureRulesMatch(rules: unknown[]): void {
  const norm = (r: Record<string, unknown>) =>
    JSON.stringify({
      priority: r.priority,
      when: r.when,
      program_key: r.program_key,
      days: r.days,
      equipment_variant: r.equipment_variant,
      review: r.review,
      overlay: r.overlay,
    });
  const fixtureRules = rules.map((r) => {
    req(isObj(r), 'rule must be an object');
    return norm(r);
  });
  const codeRules = PROGRAM_RULES.map((r) => norm({ ...r, when: r.when }));
  req(
    fixtureRules.length === codeRules.length && fixtureRules.every((r, i) => r === codeRules[i]),
    'fixture selection.rules differ from src/onboarding/program-rules.ts; update both together',
  );
}

const WORK_RE = /\bWORK\./;
const RPE_RE = /RPE [\d-]+\./;

/**
 * Build the client clone's plan list from the master's plans (as read from
 * the database) plus the stored materialisation inputs. Pure and
 * deterministic; never mutates its inputs.
 */
export function materialiseClientPlans(
  masterPlans: PlanContent[],
  programKey: ProgramKey,
  sel: Pick<ProgramSelection, 'selected_days' | 'equipment_variant' | 'overlay'>,
  m: Materialisation,
): PlanContent[] {
  const variants = m.frequency_variants[programKey] ?? [];
  const variant = variants.find((v) => v.days_per_week === sel.selected_days);
  if (!variant) throw new FixtureError(`unsupported frequency ${programKey}/${sel.selected_days}`);
  if (sel.overlay === 'extra-care' && variant.additional_plans.length > 0) {
    throw new FixtureError('extra-care never adds practice days');
  }
  const overrides = m.equipment_overrides[programKey]?.[sel.equipment_variant]?.by_week;
  const overlay = sel.overlay ? m.overlays[sel.overlay] : undefined;
  if (sel.overlay && !overlay) throw new FixtureError(`unknown overlay ${sel.overlay}`);

  const all: PlanContent[] = [...masterPlans, ...variant.additional_plans].map((p) => ({
    source_plan_id: p.source_plan_id ?? null,
    data: { ...p.data },
    exercises: p.exercises.map((e) => ({ ...e })),
  }));
  for (const plan of all) {
    for (const row of plan.exercises) {
      const patch =
        plan.data.type === 'strength'
          ? overrides?.[plan.data.week_index]?.[row.exercise_external_id]
          : undefined;
      if (patch) Object.assign(row, patch);
      if (overlay && row.notes && WORK_RE.test(row.notes)) {
        row.sets = overlay.native_patch.sets;
        const timed = row.notes.startsWith('SECONDS.');
        row.reps_or_duration_seconds = Math.min(
          row.reps_or_duration_seconds,
          timed ? overlay.max_duration_seconds : overlay.max_reps,
        );
        row.notes = `${row.notes.replace(RPE_RE, `RPE ${overlay.notes_rpe_override}.`)} ${overlay.notes_suffix}`;
      }
    }
  }
  all.sort((a, b) => a.data.week_index - b.data.week_index || a.data.day_index - b.data.day_index);
  return all;
}
