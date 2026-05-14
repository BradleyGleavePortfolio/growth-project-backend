import { getGramsForVolume, supportsVolumeUnits } from '../src/food/food-density';

describe('getGramsForVolume', () => {
  it('converts 1 cup dairy to ~247g (density ~1.03)', () => {
    const grams = getGramsForVolume('Dairy and Egg Products', 'cup', 1);
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

  it('scales linearly with quantity', () => {
    const oneCup = getGramsForVolume('Cereal Grains and Pasta', 'cup', 1)!;
    const twoCups = getGramsForVolume('Cereal Grains and Pasta', 'cup', 2)!;
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
    expect(getGramsForVolume('Dairy', 'cup', 0)).toBeNull();
    expect(getGramsForVolume('Dairy', 'cup', -1)).toBeNull();
    expect(getGramsForVolume('Dairy', 'cup', NaN)).toBeNull();
  });

  it('is case-insensitive on category names', () => {
    const lower = getGramsForVolume('dairy', 'cup', 1);
    const upper = getGramsForVolume('DAIRY', 'cup', 1);
    expect(lower).not.toBeNull();
    expect(lower).toBe(upper);
  });
});

describe('supportsVolumeUnits', () => {
  it('returns true for a known category', () => {
    expect(supportsVolumeUnits('Dairy')).toBe(true);
    expect(supportsVolumeUnits('Fats and Oils')).toBe(true);
    expect(supportsVolumeUnits('generic')).toBe(true);
  });

  it('returns false for an unknown category', () => {
    expect(supportsVolumeUnits('Alien Space Goo')).toBe(false);
  });

  it('returns false for null/empty', () => {
    expect(supportsVolumeUnits(null)).toBe(false);
    expect(supportsVolumeUnits(undefined)).toBe(false);
    expect(supportsVolumeUnits('')).toBe(false);
  });
});
