import { findSeedById, searchSeed, SEED_EXERCISES } from '../src/exercise-library/seed-catalog';

describe('seed-catalog', () => {
  it('exposes >= 50 curated exercises', () => {
    expect(SEED_EXERCISES.length).toBeGreaterThanOrEqual(50);
  });

  it('namespaces every id with `seed:` so callers can disambiguate', () => {
    expect(SEED_EXERCISES.every((e) => e.id.startsWith('seed:'))).toBe(true);
  });

  it('has at least one entry per major category', () => {
    const targets = new Set(SEED_EXERCISES.map((e) => e.bodyPart));
    expect(targets.has('chest')).toBe(true);
    expect(targets.has('back')).toBe(true);
    expect(targets.has('upper legs')).toBe(true);
    expect(targets.has('cardio')).toBe(true);
    expect(targets.has('mobility')).toBe(true);
  });

  it('searchSeed filters by free-text query', () => {
    const out = searchSeed({ q: 'squat', limit: 100 });
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items.every((e) => /squat/i.test(e.name) || /squat/i.test(e.target))).toBe(true);
  });

  it('searchSeed paginates', () => {
    const page1 = searchSeed({ limit: 5, offset: 0 });
    const page2 = searchSeed({ limit: 5, offset: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    expect(page1.items.map((e) => e.id)).not.toEqual(page2.items.map((e) => e.id));
  });

  it('findSeedById returns the matching row', () => {
    const first = SEED_EXERCISES[0];
    expect(findSeedById(first.id)?.id).toBe(first.id);
  });

  it('findSeedById returns null for unknown id', () => {
    expect(findSeedById('seed:does-not-exist')).toBeNull();
  });
});
