import { calorieFloorKcal } from '../src/macros/calorie-floor';
import {
  KG_PER_LB,
  ageInYears,
  bmrMifflinStJeor,
  computeMacros,
  resolveDisplayedTargets,
  resolveMacroInputs,
  type MacroInputs,
} from '../src/macros/macro-calculator';

// C06 — the one macro calculator. Floors, prefer-not-to-say (male equation), protein cap and
// "no silent defaults" are the acceptance criteria.

const NOW = new Date('2026-09-30T12:00:00.000Z');

const maya: MacroInputs = {
  // Prototype sample client: 38, female, 5 ft 6 in, 172 lb, goal 150 lb,
  // moderately active, fat loss. Prototype targets: 1,789 kcal, 150 g
  // protein, 185 g carbs, 50 g fat.
  weight_lbs: 172,
  height_cm: 66 * 2.54,
  age_years: 38,
  sex: 'female',
  activity_level: 'moderate',
  goal: 'fat_loss',
  target_weight_lbs: 150,
};

describe('computeMacros', () => {
  it('reproduces the approved prototype example exactly', () => {
    const m = computeMacros(maya);
    expect(m).toMatchObject({
      calories: 1789,
      protein_g: 150,
      carbs_g: 185,
      fat_g: 50,
      bmr: 1477,
      tdee: 2289,
      method: 'mifflin_st_jeor',
      floor_applied: false,
      floor_kcal: 1200,
    });
  });

  it('uses the male equation (+5) for male', () => {
    expect(bmrMifflinStJeor(80, 180, 30, 'male')).toBeCloseTo(10 * 80 + 6.25 * 180 - 150 + 5, 6);
  });

  it('uses the MALE equation for prefer_not_to_say (approved method) with the 1,500 floor', () => {
    const male = bmrMifflinStJeor(80, 180, 30, 'male');
    expect(bmrMifflinStJeor(80, 180, 30, 'prefer_not_to_say')).toBeCloseTo(male, 6);
    const m = computeMacros({ ...maya, sex: 'prefer_not_to_say' });
    expect(m.method).toBe('mifflin_st_jeor');
    expect(m.bmr).toBe(Math.round(bmrMifflinStJeor(172 * KG_PER_LB, 66 * 2.54, 38, 'male')));
    expect(m.floor_kcal).toBe(1500);
  });

  it('caps protein at 35% of calories', () => {
    // Heavy goal weight on the female floor: 1 g/lb would be 300 g (1,200 kcal
    // of protein); the cap is 35% of 1,200 kcal = 105 g.
    const m = computeMacros({
      weight_lbs: 320,
      height_cm: 150,
      age_years: 80,
      sex: 'female',
      activity_level: 'sedentary',
      goal: 'fat_loss',
      target_weight_lbs: 300,
    });
    expect(m.protein_g).toBeLessThanOrEqual(Math.round((m.calories * 0.35) / 4));
    expect(m.protein_g * 4).toBeLessThanOrEqual(m.calories * 0.35 + 2);
    expect(m.carbs_g).toBeGreaterThanOrEqual(0);
    expect(m.protein_g * 4 + m.carbs_g * 4 + m.fat_g * 9).toBeLessThanOrEqual(m.calories + 6);
  });

  it.each([
    ['female', 1200],
    ['male', 1500],
    ['prefer_not_to_say', 1500],
  ] as const)('applies the %s floor of %i kcal and reports it', (sex, floor) => {
    expect(calorieFloorKcal(sex)).toBe(floor);
    const m = computeMacros({
      weight_lbs: 95,
      height_cm: 150,
      age_years: 80,
      sex,
      activity_level: 'sedentary',
      goal: 'fat_loss',
    });
    expect(m.calories).toBe(floor);
    expect(m.floor_applied).toBe(true);
    expect(m.carbs_g).toBeGreaterThanOrEqual(0);
  });

  it('does not report the floor when the target is exactly at or above it', () => {
    const m = computeMacros({ ...maya, goal: 'maintenance' });
    expect(m.floor_applied).toBe(false);
    expect(m.calories).toBeGreaterThan(1200);
  });

  it('applies the goal adjustments -500 / +300 / 0 / 0', () => {
    const base = computeMacros({ ...maya, goal: 'maintenance' }).calories;
    expect(computeMacros({ ...maya, goal: 'fat_loss' }).calories).toBe(base - 500);
    expect(computeMacros({ ...maya, goal: 'muscle_gain' }).calories).toBe(base + 300);
    expect(computeMacros({ ...maya, goal: 'performance' }).calories).toBe(base);
  });

  it('sets protein from goal weight, else current weight', () => {
    expect(computeMacros(maya).protein_g).toBe(150);
    // No goal weight: 1 g/lb of current weight (172 g), capped at 35% of
    // 1,789 kcal = 156.5 g -> 157 g.
    expect(computeMacros({ ...maya, target_weight_lbs: null }).protein_g).toBe(157);
    expect(computeMacros({ ...maya, goal: 'maintenance', target_weight_lbs: null }).protein_g).toBe(
      172,
    );
  });

  it('never returns negative carbs at the floor with heavy protein', () => {
    const m = computeMacros({
      weight_lbs: 400,
      height_cm: 150,
      age_years: 90,
      sex: 'female',
      activity_level: 'sedentary',
      goal: 'fat_loss',
      target_weight_lbs: 400,
    });
    expect(m.carbs_g).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveMacroInputs — no silent defaults', () => {
  const full = {
    current_weight_lbs: 172,
    height_cm: 167.6,
    date_of_birth: '1988-03-14',
    sex: 'female',
    activity_level: 'moderate',
    goal_type: 'fat_loss',
  };

  it('resolves a complete set', () => {
    const r = resolveMacroInputs(full, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.inputs.age_years).toBe(38);
  });

  it('reports every missing input instead of using 180 lb / 175 cm / age 30', () => {
    const r = resolveMacroInputs({}, NOW);
    expect(r).toEqual({
      ok: false,
      missing: ['weight', 'height_cm', 'date_of_birth', 'sex', 'activity_level', 'goal'],
    });
  });

  it.each([
    ['weight', { current_weight_lbs: null }],
    ['weight', { current_weight_lbs: 10 }],
    ['height_cm', { height_cm: 0 }],
    ['date_of_birth', { date_of_birth: 'not-a-date' }],
    ['date_of_birth', { date_of_birth: '2020-01-01' }],
    ['sex', { sex: 'unknown' }],
    ['activity_level', { activity_level: 'workout' }],
    ['goal', { goal_type: null }],
  ])('flags %s when %j', (field, patch) => {
    const r = resolveMacroInputs({ ...full, ...patch }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual([field]);
  });

  it('computes whole-year age on the birthday boundary', () => {
    expect(ageInYears(new Date('1988-09-30'), NOW)).toBe(38);
    expect(ageInYears(new Date('1988-10-01'), NOW)).toBe(37);
  });
});

describe('resolveDisplayedTargets — one read-side rule', () => {
  const profile = {
    macro_target_calories: 1789,
    macro_target_protein_g: 150,
    macro_target_carbs_g: 185,
    macro_target_fat_g: 50,
  };
  const coach = { calories_kcal: 2000, protein_g: 160, carbs_g: 200, fats_g: 60, fiber_g: 28 };

  it('prefers the live coach MacroTarget', () => {
    expect(resolveDisplayedTargets(coach, profile)).toEqual({
      source: 'coach_target',
      calories: 2000,
      protein_g: 160,
      carbs_g: 200,
      fat_g: 60,
      fiber_g: 28,
    });
  });

  it('falls back to the profile targets', () => {
    expect(resolveDisplayedTargets(null, profile)).toMatchObject({
      source: 'profile',
      calories: 1789,
    });
  });

  it('reports unset rather than inventing numbers', () => {
    expect(
      resolveDisplayedTargets(null, {
        macro_target_calories: null,
        macro_target_protein_g: null,
        macro_target_carbs_g: null,
        macro_target_fat_g: null,
      }),
    ).toEqual({
      source: 'unset',
      calories: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
    });
  });
});
