/**
 * FOOD-TRUE-BE (owner #191-E3 "either way, v1 fix", #197-S1; LO-FOOD C8): numbers a food can really have. Every
 * path that hands a food to the phone (search, barcode, the stored import on log) leaves out a food that fails.
 */

/** No food holds more than 900 kcal per 100 g (pure fat is about 884; lard, tallow and fish oil list 902). */
export const MAX_KCAL_PER_100G = 900;
/** No food holds more than 100 g of protein, carbs or fat per 100 g. */
export const MAX_MACRO_G_PER_100G = 100;
/** Calories may sit outside what the macros allow by up to 30% or up to 40 kcal (rounding, label slack). */
export const ENERGY_GAP_SHARE = 0.3;
export const ENERGY_GAP_KCAL = 40;
/** 21 CFR 101.9(c)(1)(i): fibre counts at most 2 kcal a gram (soluble; insoluble is 0). */
export const FIBRE_KCAL_PER_G = 2;
/** 21 CFR 101.9(c)(1)(i): sugar alcohols count at most 3 kcal a gram (erythritol is 0). */
export const POLYOL_KCAL_PER_G = 3;
/** FIX-1222: the tags a shared import stores as evidence of its check (never search words, never shown). */
export const TRUTH_TAG_PREFIX = 'truth:';
/** A stored shared row that passed this check, its source listing every macro, when it was imported. */
export const CHECKED_TAG = `${TRUTH_TAG_PREFIX}checked`;
/** The alcohol the source listed for a stored row, in grams per 100 g: `truth:alcohol_g=10.3`. */
export const ALCOHOL_TAG = `${TRUTH_TAG_PREFIX}alcohol_g=`;

type Num = number | string | { toString(): string } | null | undefined;

export interface FoodNumbers {
  calories: Num;
  protein_g: Num;
  carbs_g: Num;
  fat_g: Num;
  fiber_g?: Num;
  serving_size_grams?: Num;
  nutrient_basis?: 'PER_100G' | 'PER_SERVING' | null;
}

/**
 * True when the food's numbers can be true, read per 100 g (a PER_SERVING row is scaled by its serving grams):
 * every number a real, non-negative number, at most 900 kcal (plus the 40 kcal margin) and 100 g of each macro,
 * and calories within 30% or 40 kcal of what the macros allow. Protein and fat count 4 and 9 kcal a gram and
 * `alcoholG` (grams per 100 g, when the source lists it) 7. Carbohydrate counts 0 to 4 kcal a gram, because a
 * label's carbohydrate may hold fibre or sugar alcohols it does not list (stevia, Truvia, cocoa); fibre the food
 * lists (`fiber_g`) counts at most 2 and sugar alcohols the source lists (`polyolsG`) at most 3.
 */
export function numbersCanBeTrue(food: FoodNumbers, alcoholG = 0, polyolsG = 0): boolean {
  if (!withinHardCaps(food)) return false;
  const scale = per100g(food);
  const [kcal, protein, carbs, fat] = [food.calories, food.protein_g, food.carbs_g, food.fat_g].map(
    (v) => Number(v) * scale,
  );
  const alcohol = Math.max(0, Number(alcoholG) || 0);
  const fibre = Math.min(carbs, Math.max(0, Number(food.fiber_g) * scale || 0));
  const polyols = Math.min(carbs - fibre, Math.max(0, Number(polyolsG) || 0));
  const low = 4 * protein + 9 * fat + 7 * alcohol;
  const high = low + 4 * (carbs - fibre - polyols) + FIBRE_KCAL_PER_G * fibre + POLYOL_KCAL_PER_G * polyols;
  const near = (gap: number, bound: number) => gap <= ENERGY_GAP_KCAL || gap <= ENERGY_GAP_SHARE * bound;
  if (kcal < low) return near(low - kcal, low);
  if (kcal > high) return near(kcal - high, high);
  return true;
}

/** The factor that reads a row per 100 g (a PER_SERVING row is scaled by its serving grams). */
function per100g(food: FoodNumbers): number {
  const grams = Number(food.serving_size_grams);
  return food.nutrient_basis === 'PER_SERVING' && grams > 0 ? 100 / grams : 1;
}

/** Every number a real, non-negative number, at most 900 kcal (plus the 40 kcal margin) and 100 g of each macro. */
export function withinHardCaps(food: FoodNumbers): boolean {
  const scale = per100g(food);
  const [kcal, protein, carbs, fat] = [food.calories, food.protein_g, food.carbs_g, food.fat_g].map(
    (v) => Number(v) * scale,
  );
  if (![kcal, protein, carbs, fat].every((v) => Number.isFinite(v) && v >= 0)) return false;
  if (kcal > MAX_KCAL_PER_100G + ENERGY_GAP_KCAL) return false;
  return [protein, carbs, fat].every((g) => g <= MAX_MACRO_G_PER_100G);
}

/** The evidence tags a shared import stores with its row: checked, and the alcohol the source listed. */
export function evidenceTags(alcoholG: number): string[] {
  const alcohol = Math.round((Number(alcoholG) || 0) * 10) / 10;
  return alcohol > 0 ? [CHECKED_TAG, `${ALCOHOL_TAG}${alcohol}`] : [CHECKED_TAG];
}

/** The alcohol a stored row's tags hold (0 when none). */
export function storedAlcoholG(tags: readonly string[] | null | undefined): number {
  const tag = (tags ?? []).find((t) => t.startsWith(ALCOHOL_TAG));
  return tag ? Number(tag.slice(ALCOHOL_TAG.length)) || 0 : 0;
}

/** A stored row read with the evidence its tags hold: the same check a new import of it passed. */
export function storedNumbersCanBeTrue(row: FoodNumbers & { tags?: readonly string[] | null }): boolean {
  return numbersCanBeTrue(row, storedAlcoholG(row.tags));
}

/**
 * A shared packaged row stored before FIX-1222 with a 0 g macro: the 0 may be a macro its source left out (the
 * old import wrote a missing macro as 0), so it is not logged until its source is read again. Packaged means
 * an Open Food Facts row (its code tag or a barcode) or a USDA row that is not a basic food (Branded, or FNDDS).
 */
export function legacyPackagedZero(row: FoodNumbers & {
  tags?: readonly string[] | null; barcode?: string | null; created_by_user_id?: string | null;
}, basicTag: string): boolean {
  if (row.created_by_user_id) return false;
  const tags = row.tags ?? [];
  if (tags.includes(CHECKED_TAG)) return false;
  const packaged = Boolean(row.barcode) || tags.some((t) => t.startsWith('off:'))
    || (tags.some((t) => t.startsWith('usda:')) && !tags.includes(basicTag));
  return packaged && [row.protein_g, row.carbs_g, row.fat_g].some((v) => Number(v) === 0);
}
