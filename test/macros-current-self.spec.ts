import { MacrosService } from '../src/macros/macros.service';
import type { PrismaService } from '../src/prisma.service';

// C06: GET /me/macros/current falls back to the profile's server-computed
// targets so Home, Log and Macros read the same numbers.

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

function make(target: Record<string, unknown> | null, profile: Record<string, unknown> | null) {
  return new MacrosService(
    asPrisma({
      macroTarget: { findFirst: jest.fn(async () => target) },
      userProfile: { findUnique: jest.fn(async () => profile) },
    }),
  );
}

describe('MacrosService.getCurrentForSelf', () => {
  const eff = new Date('2026-09-01T00:00:00Z');

  it('returns the coach target with source=coach_target', async () => {
    const svc = make(
      {
        id: 't1',
        client_id: 'c1',
        coach_id: 'k1',
        calories_kcal: 2000,
        protein_g: 160,
        carbs_g: 200,
        fats_g: 60,
        fiber_g: null,
        notes: null,
        effective_from: eff,
      },
      null,
    );
    await expect(svc.getCurrentForSelf('c1')).resolves.toMatchObject({
      id: 't1',
      source: 'coach_target',
    });
  });

  it('falls back to profile targets in the same field names', async () => {
    const svc = make(null, {
      macro_target_calories: 1789,
      macro_target_protein_g: 150,
      macro_target_carbs_g: 185,
      macro_target_fat_g: 50,
      updated_at: eff,
    });
    await expect(svc.getCurrentForSelf('c1')).resolves.toEqual({
      id: null,
      client_id: 'c1',
      coach_id: null,
      calories_kcal: 1789,
      protein_g: 150,
      carbs_g: 185,
      fats_g: 50,
      fiber_g: null,
      notes: null,
      effective_from: eff,
      source: 'profile',
    });
  });

  it('returns null when nothing is set (no invented numbers)', async () => {
    const svc = make(null, {
      macro_target_calories: null,
      macro_target_protein_g: null,
      macro_target_carbs_g: null,
      macro_target_fat_g: null,
      updated_at: eff,
    });
    await expect(svc.getCurrentForSelf('c1')).resolves.toBeNull();
  });
});
