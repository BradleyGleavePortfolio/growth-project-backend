/**
 * FOOD-TRUE-BE: fixture numbers a food can really have. Search, barcode and the stored import leave out a food
 * whose calories are far from 4/4/9 of its protein, carbs and fat, and a packaged food missing a macro; these give
 * a fixture's calories the protein (0 g), carbs and fat whose 4/4/9 is those calories (half from carbs, half from fat).
 */
export const carbsFor = (kcal: number) => kcal / 8;
export const fatFor = (kcal: number) => kcal / 18;

/** USDA nutrients (search shape) for `kcal` per 100 g, Energy first. */
export const usdaNutrientsFor = (kcal: number) => [
  { nutrientName: 'Energy', unitName: 'KCAL', value: kcal },
  { nutrientName: 'Protein', unitName: 'G', value: 0 },
  { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: carbsFor(kcal) },
  { nutrientName: 'Total lipid (fat)', unitName: 'G', value: fatFor(kcal) },
];

/** Open Food Facts nutriments for `kcal` per 100 g. */
export const offNutrimentsFor = (kcal: number) => ({
  'energy-kcal_100g': kcal, proteins_100g: 0, carbohydrates_100g: carbsFor(kcal), fat_100g: fatFor(kcal),
});
