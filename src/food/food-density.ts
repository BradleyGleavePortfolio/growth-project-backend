// Volume <-> grams conversion for food logging.
//
// The mobile picker exposes cup / tbsp / tsp chips, but the macros on FoodItem
// are stored per-100g (see NutrientBasis docs). Converting "1 cup oats" to a
// real gram value requires either a per-food density (Cronometer's approach)
// or a category-level fallback (this file). Per-food density is a separate,
// bigger piece of work; this lookup is the "Trainerize-grade floor" that
// stops the picker from silently treating `1 cup` as `1 serving`.
//
// Densities are average g/ml values sourced from public USDA FDC food-group
// summaries, rounded to two sig figs. They're heuristics — a literal "1 cup"
// of granola vs. flour vs. fresh berries will differ by ±20%. Per-food
// density is the right long-term answer; this table is good enough to keep
// macro math within MFP's quoted accuracy band for the common cases.
//
// Anything not in the table returns null and the caller MUST surface this to
// the user (mobile disables the cup/tbsp/tsp chips via FoodResult
// `supports_volume_units`). Returning a wrong number silently is worse than
// failing soft.

export type VolumeUnit = 'cup' | 'tbsp' | 'tsp';

// Volume constants — USA standard kitchen units.
//   1 cup  = 240 ml
//   1 tbsp = 15  ml
//   1 tsp  = 5   ml
const VOLUME_ML: Record<VolumeUnit, number> = {
  cup: 240,
  tbsp: 15,
  tsp: 5,
};

// Category names use the USDA FDC `foodCategory` strings verbatim where
// possible (so the lookup hits without any mapping layer).
//
// Keys are matched case-insensitively against a normalized version of the
// supplied category. Multiple synonyms point at the same density to handle
// the long tail of USDA category labels.
//
// FR-1198 (LO-1198 B2 + C3): a category value stands in for a food's own cup
// weight only where every food of that category shares one density: liquids,
// pourable fats and liquid sweeteners. Mixed solid families are not listed.
// "Cereal Grains and Pasta" gave rolled oats 156 g a cup (real 80 g, about
// 596 kcal for 300), "Oatmeal" gave 96 g, "Nut and Seed Products" gave peanut
// butter 8.25 g a tbsp (real 16 g), "Dairy and Egg Products" gave shredded
// cheddar 264 g a cup (real 113 g) and whey powder 15.5 g a tbsp, "Fruits and
// Fruit Juices" gave orange juice 144 g a cup (real 248 g). Such a food offers
// a volume only from its own household measure (volumeWeightsFor below);
// without one the picker offers grams and ounces (R1).
const DENSITY_G_PER_ML: Record<string, number> = {
  // Beverages and juices — water-equivalent, slightly higher for juice.
  beverages: 1.00,
  beverage: 1.00,
  'non-alcoholic beverages': 1.00,
  juice: 1.05,
  juices: 1.05,

  // Yogurt alone (not the whole dairy family): plain and Greek sit near 1.03.
  yogurt: 1.03,

  // Liquid egg (beaten whole egg, whites, yolks) sits near 1.03.
  eggs: 1.03,
  egg: 1.03,

  // Fats & oils — packed liquid fats, all near 0.92.
  oil: 0.92,
  oils: 0.92,
  'fats and oils': 0.92,
  butter: 0.91,
  margarine: 0.91,
  mayonnaise: 0.91,
  shortening: 0.90,

  // Sugar and liquid sweeteners, each its own density ("sweeteners" and
  // "syrups and toppings" mix granules, honey and whipped toppings: not listed).
  sugars: 0.85,
  sugar: 0.85,
  honey: 1.42,
  syrup: 1.32,
  syrups: 1.32,

  // Soups & sauces — water-equivalent (or slightly above).
  soup: 1.00,
  soups: 1.00,
  'soups, sauces, and gravies': 1.05,
  sauce: 1.05,
  sauces: 1.05,
  condiments: 1.05,

  // FOOD-1-BE (owner ruling R1, LO-FOOD B3, LS-FOOD B1): no `generic` entry.
  // 'generic' is the catch-all every Open Food Facts row, USDA import, seeded
  // row and custom food gets, so a water density there gave a cup of dry oats
  // 240 g. The FoodCategory values fast_food and restaurant are not listed
  // either: they say where a food comes from, not what it weighs.
};

// FR-1198: a dry form inside a liquid category ("Beverages, coffee, instant,
// powder", "Soup, chicken noodle, dry, mix") does not weigh what the liquid
// weighs, so its name keeps the category value away.
const DRY_FORM = /\b(powder|powdered|dry|dried|dehydrated|mix|mixes|flakes|granules|crystals|freeze-dried)\b/i;

function normalizeCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  return category.trim().toLowerCase();
}

/**
 * Convert a volume (cup/tbsp/tsp) to grams using a category-level density.
 *
 * Returns null when the category is unknown — the caller MUST surface this
 * to the user (e.g. by disabling the cup/tbsp/tsp chips in the picker) rather
 * than fall back to a wrong default.
 */
export function getGramsForVolume(
  foodCategory: string | null | undefined,
  unit: VolumeUnit,
  qty: number,
): number | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const key = normalizeCategory(foodCategory);
  if (!key) return null;

  const density = DENSITY_G_PER_ML[key];
  if (density == null) return null;

  const ml = VOLUME_ML[unit];
  if (ml == null) return null;

  return Math.round(qty * ml * density * 10) / 10;
}

/**
 * Whether a given category has a density entry — used by the API to set the
 * `supports_volume_units` flag on FoodResult so mobile can disable
 * cup/tbsp/tsp chips for unknown categories instead of silently mis-logging.
 */
export function supportsVolumeUnits(foodCategory: string | null | undefined): boolean {
  const key = normalizeCategory(foodCategory);
  if (!key) return false;
  return DENSITY_G_PER_ML[key] != null;
}

/** Grams for one cup, tablespoon and teaspoon of a food. */
export interface VolumeWeights {
  cup_grams: number;
  tbsp_grams: number;
  tsp_grams: number;
}

// "1/2 cup dry (40g)", "1 cup cooked (158g)", "2 tbsp", "1 1/2 cups", "0.25 cup".
const MEASURE_RE = /(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(cups?|tablespoons?|tbsps?|tbs|teaspoons?|tsps?)\b/i;
// A weight in grams written in the same text: "(40g)", "40 g". Not "mg".
const GRAMS_RE = /(\d+(?:\.\d+)?)\s*g(?![a-z])/i;

function parseQty(raw: string): number {
  const [whole, frac] = raw.trim().includes(' ') ? raw.trim().split(/\s+/) : ['0', raw.trim()];
  const part = (t: string) => (t.includes('/') ? Number(t.split('/')[0]) / Number(t.split('/')[1]) : Number(t));
  return Number(whole) + part(frac);
}

function unitOf(word: string): VolumeUnit {
  const w = word.toLowerCase();
  if (w.startsWith('c')) return 'cup';
  return w.startsWith('tb') || w.startsWith('tablespoon') ? 'tbsp' : 'tsp';
}

function weightsAt(gramsPerMl: number): VolumeWeights {
  const at = (u: VolumeUnit) => Math.round(VOLUME_ML[u] * gramsPerMl * 10) / 10;
  return { cup_grams: at('cup'), tbsp_grams: at('tbsp'), tsp_grams: at('tsp') };
}

/**
 * R1 (no guessed portions): cup/tbsp/tsp weights only when they come from the
 * food's own household measure (a cup, tbsp or tsp in `measure` with a gram
 * weight, written in the text or given as `grams`) or else from this file's
 * density table for `category`, unless `name` says a dry form. Otherwise null:
 * the picker offers grams and ounces. An implausible own measure (outside
 * 0.02-2.5 g/ml) also gives null.
 */
export function volumeWeightsFor(
  measure: string | null | undefined,
  grams: number | null | undefined,
  category: string | null | undefined,
  name?: string | null,
): VolumeWeights | null {
  const text = measure ?? '';
  const m = MEASURE_RE.exec(text);
  if (m) {
    const ml = parseQty(m[1]) * VOLUME_ML[unitOf(m[2])];
    const written = GRAMS_RE.exec(text.slice(m.index + m[0].length)) ?? GRAMS_RE.exec(text);
    const perMl = (written ? Number(written[1]) : Number(grams)) / ml;
    return Number.isFinite(perMl) && perMl >= 0.02 && perMl <= 2.5 ? weightsAt(perMl) : null;
  }
  if (name && DRY_FORM.test(name)) return null;
  const key = normalizeCategory(category);
  const density = key ? DENSITY_G_PER_ML[key] : undefined;
  return density == null ? null : weightsAt(density);
}
