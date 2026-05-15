import { SEED_EXERCISES } from '../src/exercise-library/seed-catalog';

// Verifies the slug derivation in scripts/seed-exercise-catalog.ts
// produces unique slugs across the full SEED_EXERCISES list. The seeder
// has its own deriveSlug() but the rule is small enough to redefine
// here — keeping the test independent of the script's internals while
// catching collisions if a future seed entry happens to slug-collide.
function deriveSlug(name: string, seedId: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (fromName) return fromName;
  return seedId.replace(/^seed:/, '');
}

describe('seed slug derivation', () => {
  it('every SEED_EXERCISE produces a non-empty slug', () => {
    for (const ex of SEED_EXERCISES) {
      expect(deriveSlug(ex.name, ex.id)).not.toBe('');
    }
  });

  it('derived slugs are unique across the entire seed catalog', () => {
    const slugs = SEED_EXERCISES.map((ex) => deriveSlug(ex.name, ex.id));
    const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(dupes).toEqual([]);
  });
});
