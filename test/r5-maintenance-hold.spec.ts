import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ageInYears, computeMacros, type MacroInputs } from '../src/macros/macro-calculator';
import { MacrosService } from '../src/macros/macros.service';
import { ProfileService } from '../src/profile/profile.service';
import type { PrismaService } from '../src/prisma.service';

// Owner decision 6: a readiness (PAR-Q) or pregnancy "yes" holds calories at
// maintenance, and there is no deficit under 18 (a surplus still applies).
// A coach target below maintenance for either client is rejected.

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
  ])('age %i: no deficit under 18 = %s', (age_years, minor) => {
    const m = computeMacros({ ...ADULT, age_years });
    const maintenance = computeMacros({ ...ADULT, age_years, goal: 'maintenance' }).calories;
    expect(m.maintenance_hold).toBe(false);
    expect(m.no_deficit_under_18).toBe(minor);
    expect(m.calories).toBe(minor ? maintenance : maintenance - 500);
  });

  it('under 18, muscle gain keeps the +300 surplus', () => {
    const m = computeMacros({ ...ADULT, age_years: 16, goal: 'muscle_gain' });
    const maintenance = computeMacros({ ...ADULT, age_years: 16, goal: 'maintenance' }).calories;
    expect(m.calories).toBe(maintenance + 300);
    expect(m).toMatchObject({ maintenance_hold: false, no_deficit_under_18: false });
  });

  it('under 18 with a readiness yes: exactly maintenance, even on muscle gain', () => {
    const m = computeMacros({ ...ADULT, age_years: 16, goal: 'muscle_gain', screening_yes: true });
    const maintenance = computeMacros({ ...ADULT, age_years: 16, goal: 'maintenance' }).calories;
    expect(m.calories).toBe(maintenance);
    expect(m.maintenance_hold).toBe(true);
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
    prisma,
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

  it('a 16-year-old on muscle gain is stored at maintenance + 300', async () => {
    const w = world(null, {
      ...PROFILE,
      date_of_birth: new Date('2010-01-01'),
      goal_type: 'muscle_gain',
    });
    const put = (await w.profiles.updateProfile('client-1', {}, NOW)) as Record<string, unknown>;
    const maintenance = computeMacros({ ...ADULT, age_years: 16, goal: 'maintenance' }).calories;
    expect(put.macro_target_calories).toBe(maintenance + 300);
  });
});

describe('coach quick-set preset (MacrosService.computePreset)', () => {
  const svc = new MacrosService(asPrisma({}));
  const preset = (age_years: number, goal: 'cut' | 'maintain' | 'bulk') =>
    svc.computePreset({
      weight_kg: 70,
      height_cm: 165,
      age_years,
      sex: 'female',
      activity_level: 'moderate',
      goal,
    });

  it('under 18: a cut gives maintenance and says "no deficit under 18"', () => {
    const cut = preset(16, 'cut');
    expect(cut.calories_kcal).toBe(preset(16, 'maintain').calories_kcal);
    expect(cut.rationale).toContain('goal cut, no deficit under 18. ');
    expect(cut.rationale).not.toMatch(/held at maintenance/);
  });

  it('under 18: a bulk keeps the +300 surplus with no extra wording', () => {
    const bulk = preset(16, 'bulk');
    expect(bulk.calories_kcal).toBe(preset(16, 'maintain').calories_kcal + 300);
    expect(bulk.rationale).not.toMatch(/under 18/);
  });

  it('18: a cut keeps the deficit', () => {
    expect(preset(18, 'cut').calories_kcal).toBe(preset(18, 'maintain').calories_kcal - 500);
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
        `Calorie targets can't go below ${kcal.toLocaleString('en-US')} for this client. Their readiness answers or age rule out a deficit.`,
      ),
    );
    expect(w.create).not.toHaveBeenCalled();
    await expect(w.macros.createForClient('coach-1', 'client-1', dto(kcal))).resolves.toMatchObject(
      { calories_kcal: kcal },
    );
  });

  it.each(['fat_loss', 'muscle_gain'])(
    'under 18 (%s goal): rejects below maintenance, allows maintenance and above',
    async (goal_type) => {
      const dob = new Date(Date.now() - 16.5 * 365.25 * 864e5);
      const w = world(null, { ...PROFILE, date_of_birth: dob, goal_type });
      const kcal = computeMacros({
        ...ADULT,
        age_years: ageInYears(dob, new Date()),
        goal: 'maintenance',
      }).calories;
      await expect(w.macros.createForClient('coach-1', 'client-1', dto(kcal - 1))).rejects.toThrow(
        new BadRequestException(
          `Calorie targets can't go below ${kcal.toLocaleString('en-US')} for this client. Their readiness answers or age rule out a deficit.`,
        ),
      );
      expect(w.create).not.toHaveBeenCalled();
      await expect(
        w.macros.createForClient('coach-1', 'client-1', dto(kcal)),
      ).resolves.toMatchObject({ calories_kcal: kcal });
      await expect(
        w.macros.createForClient('coach-1', 'client-1', dto(kcal + 300)),
      ).resolves.toMatchObject({ calories_kcal: kcal + 300 });
    },
  );

  it('still allows a deficit above the floor when nothing holds the client', async () => {
    const w = world({ screening_any_yes: false });
    await expect(w.macros.createForClient('coach-1', 'client-1', dto(1300))).resolves.toMatchObject(
      {
        calories_kcal: 1300,
      },
    );
  });
});

// B-929-1 (Sol's scenario): every reader prefers the live MacroTarget, so a
// held client's recompute re-checks it.
describe('held client: the live MacroTarget follows the refreshed maintenance', () => {
  type Act = MacroInputs['activity_level'];
  const TEEN = { ...PROFILE, date_of_birth: new Date('2010-01-01') };
  const keep = (activity_level: Act, age_years = 16) =>
    computeMacros({ ...ADULT, age_years, activity_level, goal: 'maintenance' }).calories;
  const NOTE = 'Initial target from the consultation (mifflin_st_jeor, no deficit under 18).';
  const YES = { screening_any_yes: true };

  async function run(intake: object | null, profile: object, live: object, act: Act = 'moderate') {
    const w = world(intake as typeof YES | null, profile);
    const rows: object[] = [{ coach_id: 'coach-1', notes: 'Coach plan', ...live }];
    w.create.mockImplementation(async ({ data }) => ({ id: `t${rows.push(data)}`, ...data }));
    Object.assign(w.prisma.macroTarget as object, { findFirst: async () => rows[rows.length - 1] });
    await w.profiles.updateProfile('client-1', { activity_level: act }, NOW);
    await w.profiles.computeAndSaveMacros('client-1', NOW);
    return { rows, current: await w.macros.getCurrentForSelf('client-1', NOW) };
  }

  it('under 18: raising activity replaces the onboarding target with the new maintenance', async () => {
    const teen = { ...TEEN, activity_level: 'sedentary' };
    const { rows, current } = await run(null, teen, {
      calories_kcal: keep('sedentary'),
      notes: NOTE,
    });
    expect(rows).toHaveLength(2);
    expect(current).toMatchObject({ calories_kcal: keep('moderate'), coach_id: 'coach-1' });
    expect(current?.notes).toBe('Updated after a profile change (no deficit under 18).');
  });

  it.each([
    ['a coach deficit target', { calories_kcal: DEFICIT }, 'moderate', MAINTENANCE],
    [
      'an onboarding target',
      { calories_kcal: MAINTENANCE, notes: NOTE },
      'light',
      keep('light', 36),
    ],
  ] as const)('readiness yes: %s becomes exactly maintenance', async (_t, live, act, want) => {
    expect((await run(YES, PROFILE, live, act)).current?.calories_kcal).toBe(want);
  });

  it.each([
    ['readiness yes, coach above maintenance', YES, PROFILE, MAINTENANCE + 200],
    ['under 18, coach at maintenance', null, TEEN, keep('moderate')],
    ['adult, no readiness yes, deficit', { screening_any_yes: false }, PROFILE, DEFICIT],
  ])('%s: kept', async (_who, intake, profile, calories_kcal) => {
    expect((await run(intake, profile, { calories_kcal })).rows).toHaveLength(1);
  });
});
