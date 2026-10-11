import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ageInYears, computeMacros, type MacroInputs } from '../src/macros/macro-calculator';
import { MacrosService } from '../src/macros/macros.service';
import { ProfileService } from '../src/profile/profile.service';
import type { PrismaService } from '../src/prisma.service';

// Owner decision 6: a readiness (PAR-Q) or pregnancy "yes" holds calories at
// maintenance, and there is no deficit under 18. Computed targets are held;
// a coach target below maintenance for such a client is rejected.

const NOW = new Date('2026-09-30T12:00:00Z');
const ADULT: MacroInputs = {
  weight_lbs: 150,
  height_cm: 165,
  age_years: 36,
  sex: 'female',
  activity_level: 'moderate',
  goal: 'fat_loss',
};
const MAINTENANCE = computeMacros({ ...ADULT, goal: 'maintenance' }).calories;
const DEFICIT = computeMacros(ADULT).calories;

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

describe('calculator', () => {
  it('a fat-loss adult with no readiness yes gets the deficit', () => {
    expect(DEFICIT).toBe(MAINTENANCE - 500);
    expect(computeMacros(ADULT).maintenance_hold).toBe(false);
  });

  it.each(['fat_loss', 'muscle_gain'] as const)(
    'a readiness yes holds %s at maintenance',
    (goal) => {
      const m = computeMacros({ ...ADULT, goal, screening_yes: true });
      expect(m.calories).toBe(MAINTENANCE);
      expect(m.maintenance_hold).toBe(true);
    },
  );

  it.each([
    [16, true],
    [17, true],
    [18, false],
  ])('age %i: held at maintenance = %s', (age_years, held) => {
    const m = computeMacros({ ...ADULT, age_years });
    const maintenance = computeMacros({ ...ADULT, age_years, goal: 'maintenance' }).calories;
    expect(m.maintenance_hold).toBe(held);
    expect(m.calories).toBe(held ? maintenance : maintenance - 500);
  });
});

const PROFILE = {
  user_id: 'client-1',
  sex: 'female',
  current_weight_lbs: 150,
  height_cm: 165,
  date_of_birth: new Date('1990-01-01'),
  activity_level: 'moderate',
  goal_type: 'fat_loss',
};

function world(intake: { screening_any_yes: boolean } | null, profile: object | null = PROFILE) {
  let row: Record<string, unknown> | null = profile ? { ...profile } : null;
  const create = jest.fn(async ({ data }: { data: object }) => ({ id: 'target-1', ...data }));
  const prisma: Record<string, unknown> = {
    user: { findFirst: jest.fn(async () => ({ id: 'client-1' })) },
    userProfile: {
      findUnique: jest.fn(async () => (row ? { ...row } : null)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...(row ?? {}), ...data };
        return { ...row };
      }),
    },
    clientOnboardingIntake: { findUnique: jest.fn(async () => intake) },
    macroTarget: { create, findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return {
    profiles: new ProfileService(asPrisma(prisma)),
    macros: new MacrosService(asPrisma(prisma)),
    create,
  };
}

describe('profile writers', () => {
  it.each([
    ['a readiness yes', { screening_any_yes: true }, MAINTENANCE],
    ['no readiness yes', { screening_any_yes: false }, DEFICIT],
    ['no consultation', null, DEFICIT],
  ])(
    '%s: PUT /profile and the recompute store the held or deficit target',
    async (_who, intake, expected) => {
      const w = world(intake);
      const put = (await w.profiles.updateProfile('client-1', {}, NOW)) as Record<string, unknown>;
      expect(put.macro_target_calories).toBe(expected);
      const again = await w.profiles.computeAndSaveMacros('client-1', NOW);
      expect(again?.macro_target_calories).toBe(expected);
    },
  );

  it('a 16-year-old on fat loss is stored at maintenance', async () => {
    const w = world(null, { ...PROFILE, date_of_birth: new Date('2010-01-01') });
    const put = (await w.profiles.updateProfile('client-1', {}, NOW)) as Record<string, unknown>;
    const maintenance = computeMacros({ ...ADULT, age_years: 16, goal: 'maintenance' }).calories;
    expect(put.macro_target_calories).toBe(maintenance);
  });
});

describe('coach-set targets (MacrosService.createForClient)', () => {
  const dto = (calories_kcal: number) => ({
    calories_kcal,
    protein_g: 120,
    carbs_g: 100,
    fats_g: 40,
  });
  // The profile's age moves with the real clock; compute maintenance the same way.
  const held = (): number =>
    computeMacros({
      ...ADULT,
      age_years: ageInYears(PROFILE.date_of_birth, new Date()),
      goal: 'maintenance',
    }).calories;

  it('rejects a target below maintenance for a client with a readiness yes', async () => {
    const w = world({ screening_any_yes: true });
    const kcal = held();
    const saving = w.macros.createForClient('coach-1', 'client-1', dto(kcal - 1));
    await expect(saving).rejects.toThrow(
      new BadRequestException(
        `Calorie targets can't go below ${kcal.toLocaleString('en-US')} for this client. Their readiness answers or age hold calories at maintenance.`,
      ),
    );
    expect(w.create).not.toHaveBeenCalled();
    await expect(w.macros.createForClient('coach-1', 'client-1', dto(kcal))).resolves.toMatchObject(
      { calories_kcal: kcal },
    );
  });

  it('rejects a deficit for a client under 18', async () => {
    const w = world(null, {
      ...PROFILE,
      date_of_birth: new Date(Date.now() - 16 * 365.25 * 864e5),
    });
    await expect(w.macros.createForClient('coach-1', 'client-1', dto(1300))).rejects.toThrow(
      /hold calories at maintenance/,
    );
  });

  it('still allows a deficit above the floor when nothing holds the client', async () => {
    const w = world({ screening_any_yes: false });
    await expect(w.macros.createForClient('coach-1', 'client-1', dto(1300))).resolves.toMatchObject(
      {
        calories_kcal: 1300,
      },
    );
  });
});
