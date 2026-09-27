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
// possible (so the lookup hits without any mapping layer) plus the FoodItem
// `FoodCategory` enum values for hand-curated rows.
//
// Keys are matched case-insensitively against a normalized version of the
// supplied category. Multiple synonyms point at the same density to handle
// the long tail of USDA category labels.
const DENSITY_G_PER_ML: Record<string, number> = {
  // Dairy & dairy alternatives — milk, yogurt, kefir cluster around water.
  dairy: 1.03,
  'dairy and egg products': 1.03,
  'milk products': 1.03,
  yogurt: 1.03,
  cheese: 1.10,
  cheeses: 1.10,

  // Beverages — water-equivalent for unsweetened, slightly higher for soda/juice.
  beverages: 1.00,
  beverage: 1.00,
  juice: 1.05,
  juices: 1.05,
  'non-alcoholic beverages': 1.00,

  // Fats & oils — packed liquid fats, all near 0.92.
  oil: 0.92,
  oils: 0.92,
  'fats and oils': 0.92,
  butter: 0.91,
  margarine: 0.91,
  mayonnaise: 0.91,
  shortening: 0.90,

  // Sweeteners — sugar, honey, syrup. Granular sugar packs lighter than honey.
  sweeteners: 1.20,
  sugars: 0.85,
  sugar: 0.85,
  honey: 1.42,
  syrup: 1.32,
  syrups: 1.32,
  'syrups and toppings': 1.32,

  // Flours, grains, cereals — dry, loose-packed.
  flour: 0.55,
  flours: 0.55,
  cereals: 0.45,
  cereal: 0.45,
  'breakfast cereals': 0.40,
  oats: 0.40,
  oatmeal: 0.40,
  rice: 0.80, // dry rice, raw; cooked is closer to 1.0 but we key on the catalog basis.
  pasta: 0.65,
  'pasta and noodles': 0.65,
  grains: 0.70,
  'cereal grains and pasta': 0.65,

  // Legumes & seeds — dry beans, lentils, peanuts.
  legumes: 0.80,
  'legumes and legume products': 0.80,
  nuts: 0.55,
  'nuts and seeds': 0.55,
  'nut and seed products': 0.55,

  // Vegetables — wide range, this is a chopped-fresh average.
  vegetables: 0.55,
  'vegetables and vegetable products': 0.55,

  // Fruits — fresh, chopped average.
  fruits: 0.60,
  'fruits and fruit juices': 0.60,
  fruit: 0.60,

  // Meats — diced/ground packed weight (cooked or raw both close to ~0.85).
  meat: 0.85,
  meats: 0.85,
  poultry: 0.85,
  'poultry products': 0.85,
  beef: 0.85,
  'beef products': 0.85,
  pork: 0.85,
  'pork products': 0.85,
  'finfish and shellfish products': 0.90,
  fish: 0.90,
  seafood: 0.90,

  // Eggs — large/diced.
  eggs: 1.03,
  egg: 1.03,

  // Sweets — average for cookies/candies (light + dense balance).
  sweets: 0.75,
  'sweets and snacks': 0.75,
  candy: 0.90,

  // Baked / breads — sliced/cubed, very airy.
  baked: 0.30,
  bread: 0.30,
  breads: 0.30,
  'baked products': 0.30,

  // Soups & sauces — water-equivalent (or slightly above).
  soup: 1.00,
  soups: 1.00,
  'soups, sauces, and gravies': 1.05,
  sauce: 1.05,
  sauces: 1.05,
  condiments: 1.05,

  // Fast food / restaurant / mixed dishes — averaged density across components.
  'fast foods': 0.80,
  fast_food: 0.80,
  restaurant: 0.80,
  'restaurant foods': 0.80,
  'mixed dishes': 0.80,

  // Generic catch-all used by hand-curated rows. NOT a synonym for "unknown" —
  // we still want a sensible cup-to-g for water-based foods the user adds by
  // hand. ~1.0 is the safe-ish average and is the same number MFP uses when
  // no per-food density is recorded.
  generic: 1.00,
};

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
