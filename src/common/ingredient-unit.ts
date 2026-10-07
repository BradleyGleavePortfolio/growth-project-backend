// Shared by recipe aggregation and manual-list additions; no weight/volume conversion.
const UNIT_ALIASES: Record<string, string> = {
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  piece: 'piece', pieces: 'piece', clove: 'clove', cloves: 'clove',
  can: 'can', cans: 'can', slice: 'slice', slices: 'slice', stalk: 'stalk', stalks: 'stalk',
};

export function canonicalIngredientUnit(raw: string | null | undefined): string {
  const normalized = (raw ?? '').trim().toLowerCase();
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === '.') end--;
  const unit = normalized.slice(0, end);
  return UNIT_ALIASES[unit] ?? unit;
}
