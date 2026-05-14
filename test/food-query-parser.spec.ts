import { parseFoodQuery } from '../src/food/food-query-parser';

describe('parseFoodQuery', () => {
  it('parses "6oz chicken breast"', () => {
    expect(parseFoodQuery('6oz chicken breast')).toEqual({
      quantity: 6,
      unit: 'oz',
      foodName: 'chicken breast',
    });
  });

  it('parses "6 oz chicken breast" (space between qty and unit)', () => {
    expect(parseFoodQuery('6 oz chicken breast')).toEqual({
      quantity: 6,
      unit: 'oz',
      foodName: 'chicken breast',
    });
  });

  it('parses fractions: "1/2 cup oats"', () => {
    expect(parseFoodQuery('1/2 cup oats')).toEqual({
      quantity: 0.5,
      unit: 'cup',
      foodName: 'oats',
    });
  });

  it('parses decimals: "1.5 cups rice"', () => {
    expect(parseFoodQuery('1.5 cups rice')).toEqual({
      quantity: 1.5,
      unit: 'cup',
      foodName: 'rice',
    });
  });

  it('normalizes plural units (cups -> cup, tablespoons -> tbsp)', () => {
    expect(parseFoodQuery('2 cups milk').unit).toBe('cup');
    expect(parseFoodQuery('3 tablespoons honey').unit).toBe('tbsp');
    expect(parseFoodQuery('2 teaspoons salt').unit).toBe('tsp');
    expect(parseFoodQuery('1 slice bread').unit).toBe('slice');
    expect(parseFoodQuery('5 pieces sushi').unit).toBe('piece');
  });

  it('normalizes "grams" -> "g"', () => {
    expect(parseFoodQuery('100 grams rice')).toEqual({
      quantity: 100,
      unit: 'g',
      foodName: 'rice',
    });
    expect(parseFoodQuery('100g rice').unit).toBe('g');
  });

  it('returns just the food name when no quantity is present', () => {
    expect(parseFoodQuery('chicken breast')).toEqual({ foodName: 'chicken breast' });
  });

  it('returns just the food name for "12 almonds" (no recognized unit)', () => {
    // No unit token between the number and the food, so the whole string is
    // treated as a food name (caller still hands it to upstream search).
    expect(parseFoodQuery('12 almonds')).toEqual({ foodName: '12 almonds' });
  });

  it('parses "1 cup whole milk"', () => {
    expect(parseFoodQuery('1 cup whole milk')).toEqual({
      quantity: 1,
      unit: 'cup',
      foodName: 'whole milk',
    });
  });

  it('parses "2 slices bread"', () => {
    expect(parseFoodQuery('2 slices bread')).toEqual({
      quantity: 2,
      unit: 'slice',
      foodName: 'bread',
    });
  });

  it('handles brand strings in the food name', () => {
    expect(parseFoodQuery('1 cup Chobani plain greek yogurt')).toEqual({
      quantity: 1,
      unit: 'cup',
      foodName: 'Chobani plain greek yogurt',
    });
  });

  it('is case-insensitive on units', () => {
    expect(parseFoodQuery('6 OZ chicken').unit).toBe('oz');
    expect(parseFoodQuery('1 CUP rice').unit).toBe('cup');
  });

  it('returns empty foodName for empty input', () => {
    expect(parseFoodQuery('')).toEqual({ foodName: '' });
    expect(parseFoodQuery('   ')).toEqual({ foodName: '' });
  });

  it('rejects malformed fractions (denominator 0)', () => {
    // "1/0 cup oats" — fractions parse but denom 0 short-circuits to "no parse".
    expect(parseFoodQuery('1/0 cup oats').quantity).toBeUndefined();
  });

  it('does not parse when there is no food name after the unit', () => {
    expect(parseFoodQuery('6 oz')).toEqual({ foodName: '6 oz' });
  });

  it('trims whitespace around the food name', () => {
    expect(parseFoodQuery('  6 oz  chicken breast  ').foodName).toBe('chicken breast');
  });
});
