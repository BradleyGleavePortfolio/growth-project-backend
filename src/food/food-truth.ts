/**
 * FOOD-TRUE-BE (owner #191-E3 "either way, v1 fix", #197-S1; LO-FOOD C8): numbers a food can really have. Every
 * path that hands a food to the phone (search, barcode, the stored import on log) leaves out a food that fails.
 */

/** No food holds more than 900 kcal per 100 g (pure fat is about 884). */
export const MAX_KCAL_PER_100G = 900;
/** No food holds more than 100 g of protein, carbs or fat per 100 g. */
export const MAX_MACRO_G_PER_100G = 100;
/** Calories may be off from 4/4/9 of the macros by up to 30% or up to 40 kcal (fibre, rounding, label slack). */
export const ENERGY_GAP_SHARE = 0.3;
export const ENERGY_GAP_KCAL = 40;

type Num = number | string | { toString(): string } | null | undefined;

export interface FoodNumbers {
  calories: Num;
  protein_g: Num;
  carbs_g: Num;
  fat_g: Num;
  serving_size_grams?: Num;
  nutrient_basis?: 'PER_100G' | 'PER_SERVING' | null;
}

/**
 * True when the food's numbers can be true, read per 100 g (a PER_SERVING row is scaled by its serving grams):
 * every number a real, non-negative number, at most 900 kcal and 100 g of each macro, and calories within 30% or
 * 40 kcal of 4 x protein + 4 x carbs + 9 x fat. `alcoholG` (grams per 100 g, when the source lists it) counts at
 * 7 kcal a gram, so wine and spirits, whose calories are mostly alcohol, are not taken for wrong numbers.
 */
export function numbersCanBeTrue(food: FoodNumbers, alcoholG = 0): boolean {
  const grams = Number(food.serving_size_grams);
  const scale = food.nutrient_basis === 'PER_SERVING' && grams > 0 ? 100 / grams : 1;
  const [kcal, protein, carbs, fat] = [food.calories, food.protein_g, food.carbs_g, food.fat_g].map(
    (v) => Number(v) * scale,
  );
  const alcohol = Number(alcoholG) || 0;
  if (![kcal, protein, carbs, fat].every((v) => Number.isFinite(v) && v >= 0)) return false;
  if (kcal > MAX_KCAL_PER_100G) return false;
  if ([protein, carbs, fat].some((g) => g > MAX_MACRO_G_PER_100G)) return false;
  const fromMacros = 4 * protein + 4 * carbs + 9 * fat + 7 * alcohol;
  const gap = Math.abs(kcal - fromMacros);
  return gap <= ENERGY_GAP_KCAL || gap <= ENERGY_GAP_SHARE * fromMacros;
}
