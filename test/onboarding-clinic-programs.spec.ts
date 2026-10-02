// C07 — fixture validation + client-clone materialisation (pure).
// The draft's reference materialiser is re-implemented as an oracle and run
// against every supported (program, days, equipment, overlay) combination.
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FixtureError,
  materialiseClientPlans,
  parseFixture,
  type PlanContent,
} from '../src/onboarding/clinic-programs';
import type { ProgramKey } from '../src/onboarding/program-rules';

const RAW = readFileSync(join(__dirname, '..', 'seed', 'clinic-programs.v1.json'), 'utf8');
const fx = parseFixture(RAW);
type RawRow = Record<string, unknown> & {
  notes: string | null;
  reps_or_duration_seconds: number;
  exercise_external_id: string;
};
type RawPlan = { data: { type: string; week_index: number }; exercises: RawRow[] };
const J = JSON.parse(RAW) as {
  programs: Array<{
    fixture_key: string;
    plans: RawPlan[];
    frequency_variants: Array<{ days_per_week: number; additional_plans: RawPlan[] }>;
  }>;
  equipment_overrides: Record<
    string,
    Record<string, { by_week: Array<Record<string, Record<string, unknown>>> }>
  >;
  overlays: Record<
    string,
    {
      native_patch: Record<string, unknown>;
      max_reps: number;
      max_duration_seconds: number;
      notes_rpe_override: string;
      notes_suffix: string;
    }
  >;
};

function oracle(key: string, days: number, variantKey: string, overlayKey: string | null) {
  const master = J.programs.find((p) => p.fixture_key === key)!;
  const variant = master.frequency_variants.find((v) => v.days_per_week === days)!;
  const clone = JSON.parse(
    JSON.stringify(master.plans.concat(variant.additional_plans)),
  ) as RawPlan[];
  for (const plan of clone) {
    for (const row of plan.exercises) {
      const patch =
        plan.data.type === 'strength'
          ? J.equipment_overrides[key]?.[variantKey]?.by_week[plan.data.week_index]?.[
              row.exercise_external_id
            ]
          : null;
      if (patch) Object.assign(row, patch);
      const overlay = overlayKey ? J.overlays[overlayKey] : undefined;
      if (overlay && row.notes && /\bWORK\./.test(row.notes)) {
        Object.assign(row, overlay.native_patch);
        const time = row.notes.startsWith('SECONDS.');
        row.reps_or_duration_seconds = Math.min(
          row.reps_or_duration_seconds,
          time ? overlay.max_duration_seconds : overlay.max_reps,
        );
        row.notes =
          row.notes.replace(/RPE [\d-]+\./, `RPE ${overlay.notes_rpe_override}.`) +
          ` ${overlay.notes_suffix}`;
      }
    }
  }
  return clone;
}

function masterPlans(key: string): PlanContent[] {
  return fx.programs.find((p) => p.fixture_key === key)!.plans;
}

type LoosePlan = { data: Record<string, unknown>; exercises: Array<Record<string, unknown>> };
const shape = (input: unknown) =>
  (JSON.parse(JSON.stringify(input)) as LoosePlan[])
    .map((p) => ({
      name: p.data.name,
      type: p.data.type,
      week_index: p.data.week_index,
      day_index: p.data.day_index,
      exercises: p.exercises.map((e) => ({
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs ?? null,
        rest_seconds: e.rest_seconds ?? null,
        notes: e.notes ?? null,
      })),
    }))
    .sort(
      (a, b) =>
        Number(a.week_index) - Number(b.week_index) || Number(a.day_index) - Number(b.day_index),
    );

describe('parseFixture', () => {
  it('parses the checked-in draft fixture and records its hash', () => {
    expect(fx.fixture_version).toBe('clinic-programs.v1');
    expect(fx.sha256).toBe(createHash('sha256').update(RAW).digest('hex'));
    expect(fx.production_seed_authorized).toBe(false);
    expect(fx.programs.map((p) => p.fixture_key)).toEqual([
      'steady-foundations',
      'considered-strength',
      'strength-and-balance',
    ]);
    expect(fx.programs.map((p) => p.plans.length)).toEqual([8, 12, 16]);
    expect(fx.exercise_slugs.length).toBe(22);
  });

  it('rejects a fixture referencing an exercise outside the manifest', () => {
    const j = JSON.parse(RAW);
    j.programs[0].plans[0].exercises[0].exercise_external_id = 'not-a-slug';
    expect(() => parseFixture(JSON.stringify(j))).toThrow(FixtureError);
  });

  it('rejects a fixture with a missing program', () => {
    const j = JSON.parse(RAW);
    j.programs.pop();
    expect(() => parseFixture(JSON.stringify(j))).toThrow(/three programs/);
  });
});

describe('materialiseClientPlans — matches the reference for every variant', () => {
  const combos: Array<
    [ProgramKey, number, 'supported-unloaded' | 'gym' | 'home-dumbbells', 'extra-care' | null]
  > = [
    ['steady-foundations', 2, 'supported-unloaded', 'extra-care'],
    ['steady-foundations', 2, 'supported-unloaded', null],
    ['steady-foundations', 3, 'supported-unloaded', null],
    ['considered-strength', 3, 'gym', null],
    ['considered-strength', 4, 'gym', null],
    ['considered-strength', 3, 'home-dumbbells', null],
    ['considered-strength', 4, 'home-dumbbells', null],
    ['strength-and-balance', 4, 'gym', null],
    ['strength-and-balance', 5, 'gym', null],
  ];
  it.each(combos)('%s %d days %s overlay=%s', (key, days, variant, overlay) => {
    const got = materialiseClientPlans(
      masterPlans(key),
      key,
      { selected_days: days, equipment_variant: variant, overlay },
      fx.materialisation,
    );
    expect(shape(got)).toEqual(shape(oracle(key, days, variant, overlay)));
    const weeks = new Set(got.map((p) => p.data.week_index));
    expect(weeks.size).toBe(4);
    for (const p of got)
      for (const e of p.exercises) expect(fx.exercise_slugs).toContain(e.exercise_external_id);
  });

  it('extra care: one working set, capped reps, RPE 2-3, no extra practice day', () => {
    const plans = materialiseClientPlans(
      masterPlans('steady-foundations'),
      'steady-foundations',
      { selected_days: 2, equipment_variant: 'supported-unloaded', overlay: 'extra-care' },
      fx.materialisation,
    );
    expect(plans).toHaveLength(8);
    const work = plans
      .flatMap((p) => p.exercises)
      .filter((e) => e.notes && /\bWORK\./.test(e.notes));
    expect(work.length).toBeGreaterThan(0);
    for (const e of work) {
      expect(e.sets).toBe(1);
      expect(e.notes).toContain('RPE 2-3.');
      expect(e.reps_or_duration_seconds).toBeLessThanOrEqual(
        e.notes!.startsWith('SECONDS.') ? 10 : 6,
      );
    }
  });

  it('frequency variants add the extra practice day plans', () => {
    const run = (key: ProgramKey, days: number, v: 'supported-unloaded' | 'gym') =>
      materialiseClientPlans(
        masterPlans(key),
        key,
        { selected_days: days, equipment_variant: v, overlay: null },
        fx.materialisation,
      ).length;
    expect(run('steady-foundations', 3, 'supported-unloaded')).toBe(12);
    expect(run('considered-strength', 4, 'gym')).toBe(16);
    expect(run('strength-and-balance', 5, 'gym')).toBe(20);
  });

  it('home dumbbells replace gym-only movements in strength sessions', () => {
    const gym = materialiseClientPlans(
      masterPlans('considered-strength'),
      'considered-strength',
      { selected_days: 3, equipment_variant: 'gym', overlay: null },
      fx.materialisation,
    );
    const home = materialiseClientPlans(
      masterPlans('considered-strength'),
      'considered-strength',
      { selected_days: 3, equipment_variant: 'home-dumbbells', overlay: null },
      fx.materialisation,
    );
    expect(JSON.stringify(home)).not.toEqual(JSON.stringify(gym));
    const ids = new Set(home.flatMap((p) => p.exercises.map((e) => e.exercise_external_id)));
    expect(ids.has('back-squat')).toBe(false);
  });

  it('never mutates the master plans', () => {
    const master = masterPlans('steady-foundations');
    const before = JSON.stringify(master);
    materialiseClientPlans(
      master,
      'steady-foundations',
      { selected_days: 2, equipment_variant: 'supported-unloaded', overlay: 'extra-care' },
      fx.materialisation,
    );
    expect(JSON.stringify(master)).toBe(before);
  });

  it('refuses an unsupported frequency', () => {
    expect(() =>
      materialiseClientPlans(
        masterPlans('strength-and-balance'),
        'strength-and-balance',
        { selected_days: 2, equipment_variant: 'gym', overlay: null },
        fx.materialisation,
      ),
    ).toThrow(FixtureError);
  });
});
