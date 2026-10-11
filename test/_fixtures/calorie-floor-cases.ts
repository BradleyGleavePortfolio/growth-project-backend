import { calorieFloorKcal } from '../../src/macros/calorie-floor';
import { ACTIVITY_FACTORS, KG_PER_LB, type MacroSex } from '../../src/macros/macro-calculator';

// A 50 kg, 38-year-old, sedentary client on maintenance. Height is solved from
// Mifflin-St Jeor so the unfloored target lands 100 kcal below, exactly at, or
// 100 kcal above that client's floor. `expected` is what a computed writer
// must store.
export const FLOOR_CASE_AGE = 38;
export const FLOOR_CASE_WEIGHT_KG = 50;
export const FLOOR_CASE_WEIGHT_LBS = FLOOR_CASE_WEIGHT_KG / KG_PER_LB;

const SEXES: readonly MacroSex[] = ['female', 'male', 'prefer_not_to_say'];
const OFFSETS = [
  ['below', -100],
  ['at', 0],
  ['above', 100],
] as const;

export const FLOOR_CASES = SEXES.flatMap((sex) =>
  OFFSETS.map(([where, offset]) => {
    const floor = calorieFloorKcal(sex);
    const bmr = (floor + offset) / ACTIVITY_FACTORS.sedentary;
    const sexTerm = sex === 'female' ? -161 : 5;
    const height_cm = (bmr - 10 * FLOOR_CASE_WEIGHT_KG + 5 * FLOOR_CASE_AGE - sexTerm) / 6.25;
    return { sex, where, floor, height_cm, expected: Math.max(floor, floor + offset) };
  }),
);
