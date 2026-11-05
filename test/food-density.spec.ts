import { getGramsForVolume, supportsVolumeUnits } from '../src/food/food-density';

describe('getGramsForVolume', () => {
  // FR-1198 (LO-1198 B2): the mixed "Dairy and Egg Products" family is no
  // longer a density (shredded cheese is 113 g a cup); yogurt alone is.
  it('converts 1 cup yogurt to ~247g (density ~1.03)', () => {
    const grams = getGramsForVolume('Yogurt', 'cup', 1);
    // 240ml * 1.03 = 247.2
    expect(grams).not.toBeNull();
    expect(grams!).toBeCloseTo(247.2, 0);
  });

  it('converts 1 tbsp olive oil to ~12.4g (density ~0.92)', () => {
    const grams = getGramsForVolume('Fats and Oils', 'tbsp', 1);
    // 15ml * 0.92 = 13.8
    expect(grams).not.toBeNull();
    expect(grams!).toBeCloseTo(13.8, 1);
  });

  it('converts 1 tsp sugar to ~4.3g (density ~0.85)', () => {
    const grams = getGramsForVolume('Sugars', 'tsp', 1);
    // 5ml * 0.85 = 4.25
    expect(grams!).toBeCloseTo(4.3, 1);
  });

  // FR-1198 (LO-1198 B2): 'Cereal Grains and Pasta' is no longer a density
  // (rolled oats 80 g a cup, rice 185 g), so a kept liquid category is used.
  it('scales linearly with quantity', () => {
    const oneCup = getGramsForVolume('Beverages', 'cup', 1)!;
    const twoCups = getGramsForVolume('Beverages', 'cup', 2)!;
    expect(twoCups).toBeCloseTo(oneCup * 2, 1);
  });

  it('returns null for an unknown category', () => {
    expect(getGramsForVolume('Alien Space Goo', 'cup', 1)).toBeNull();
  });

  it('returns null for null/empty category', () => {
    expect(getGramsForVolume(null, 'cup', 1)).toBeNull();
    expect(getGramsForVolume(undefined, 'cup', 1)).toBeNull();
    expect(getGramsForVolume('', 'cup', 1)).toBeNull();
  });

  it('returns null for non-positive quantity', () => {
    expect(getGramsForVolume('Beverages', 'cup', 0)).toBeNull();
    expect(getGramsForVolume('Beverages', 'cup', -1)).toBeNull();
    expect(getGramsForVolume('Beverages', 'cup', NaN)).toBeNull();
  });

  it('is case-insensitive on category names', () => {
    const lower = getGramsForVolume('beverages', 'cup', 1);
    const upper = getGramsForVolume('BEVERAGES', 'cup', 1);
    expect(lower).not.toBeNull();
    expect(lower).toBe(upper);
  });
});

describe('supportsVolumeUnits', () => {
  it('returns true for a known category', () => {
    expect(supportsVolumeUnits('Beverages')).toBe(true);
    expect(supportsVolumeUnits('Fats and Oils')).toBe(true);
  });

  it('returns false for an unknown category', () => {
    expect(supportsVolumeUnits('Alien Space Goo')).toBe(false);
  });

  // FOOD-1-BE (R1, LO-FOOD B3, LS-FOOD B1): 'generic' is the catch-all, not a
  // density; it used to give every such food the weight of water (240 g a cup).
  it("returns false for the catch-all 'generic'", () => {
    expect(supportsVolumeUnits('generic')).toBe(false);
    expect(getGramsForVolume('generic', 'cup', 1)).toBeNull();
  });

  it('returns false for null/empty', () => {
    expect(supportsVolumeUnits(null)).toBe(false);
    expect(supportsVolumeUnits(undefined)).toBe(false);
    expect(supportsVolumeUnits('')).toBe(false);
  });
});
