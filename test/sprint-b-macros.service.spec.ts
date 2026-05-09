import { MacrosService } from '../src/macros/macros.service';

// MacrosService.computePreset is a pure function so we exercise it
// without a Prisma stub. The Prisma-dependent paths are covered by
// the integration test suite.

describe('MacrosService.computePreset', () => {
  const service = new MacrosService(
    // @ts-expect-error — preset is pure; Prisma is unused for this path.
    null,
  );

  it('produces a positive deficit for a cut goal', () => {
    const out = service.computePreset({
      weight_kg: 90,
      height_cm: 180,
      age_years: 30,
      sex: 'male',
      activity_level: 'moderate',
      goal: 'cut',
    });
    expect(out.calories_kcal).toBeGreaterThan(800);
    // BMR ~1900, TDEE 1.55 ~2945, cut 500 → ~2445
    expect(out.calories_kcal).toBeGreaterThan(2000);
    expect(out.calories_kcal).toBeLessThan(2700);
  });

  it('produces a higher kcal target for a bulk goal', () => {
    const cut = service.computePreset({
      weight_kg: 75,
      height_cm: 175,
      age_years: 28,
      sex: 'female',
      activity_level: 'active',
      goal: 'cut',
    });
    const bulk = service.computePreset({
      weight_kg: 75,
      height_cm: 175,
      age_years: 28,
      sex: 'female',
      activity_level: 'active',
      goal: 'bulk',
    });
    expect(bulk.calories_kcal).toBeGreaterThan(cut.calories_kcal);
  });

  it('respects the 800 kcal floor', () => {
    const out = service.computePreset({
      weight_kg: 40,
      height_cm: 150,
      age_years: 80,
      sex: 'female',
      activity_level: 'sedentary',
      goal: 'cut',
    });
    expect(out.calories_kcal).toBeGreaterThanOrEqual(800);
  });

  it('sets protein at ~1.8 g/kg of body weight', () => {
    const out = service.computePreset({
      weight_kg: 80,
      height_cm: 180,
      age_years: 30,
      sex: 'male',
      activity_level: 'moderate',
      goal: 'maintain',
    });
    expect(out.protein_g).toBe(Math.round(80 * 1.8));
  });

  it('returns a non-empty rationale string for audit logs', () => {
    const out = service.computePreset({
      weight_kg: 75,
      height_cm: 170,
      age_years: 30,
      sex: 'male',
      activity_level: 'moderate',
      goal: 'maintain',
    });
    expect(out.rationale.length).toBeGreaterThan(20);
  });
});
