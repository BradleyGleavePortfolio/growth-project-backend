import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateProfileDto } from '../src/profile/profile.dto';
import {
  ProfileService,
  legacyWeightUnit,
  mapLegacyProfileFields,
} from '../src/profile/profile.service';
import type { PrismaService } from '../src/prisma.service';

// C06 regression: the mobile lean-onboarding save (growth-project-mobile
// src/lib/finalizeLeanOnboarding.ts) sends legacy field names. Before C06
// the DTO allow-list did not contain them and the global ValidationPipe
// (whitelist + forbidNonWhitelisted) rejected the whole PUT /profile with a
// 400, so no lean answer ever reached the server.

// Narrowing from `object` keeps the R75 banned-cast gate clean.
function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function validate(value: unknown): Promise<UpdateProfileDto> {
  return pipe.transform(value, {
    type: 'body',
    metatype: UpdateProfileDto as new () => UpdateProfileDto,
  });
}

// Exact shape asserted by the mobile test
// src/lib/__tests__/finalizeLeanOnboarding.test.ts plus the computed targets.
const LEAN_PAYLOAD = {
  onboarding_completed: true,
  sex: 'female',
  dob: '1992-04-15',
  current_weight: 72,
  height_cm: 168,
  primary_goal: 'lose_moderate',
  fitness_level: 'intermediate',
  lean_intent: 'workout',
  activity_level: 'moderate',
  tdee: 2231,
  calorie_target: 1731,
  protein_target: 140,
  carbs_target: 170,
  fat_target: 48,
};

// Legacy results screen (OnboardingResults.handleStart): nulls for skipped
// answers, lbs weights.
const LEGACY_RESULTS_PAYLOAD = {
  sex: null,
  dob: null,
  current_weight: 180,
  target_weight: null,
  height_cm: null,
  activity_level: 'light',
  primary_goal: 'gain',
  diet_type: null,
  meals_per_day: null,
  tdee: 2500,
  calorie_target: 2800,
  protein_target: 180,
  carbs_target: 300,
  fat_target: 80,
  onboarding_completed: true,
};

// EditProfile (lib/profileCompletion.buildProfileUpdatePayload).
const EDIT_PROFILE_PAYLOAD = {
  sex: 'male',
  dob: '1985-01-02',
  target_weight: 175,
  diet_type: 'omnivore',
  workout_days_per_week: 4,
  gym_membership: 'yes_regular',
  current_weight: 190,
  height_cm: 180,
  activity_level: 'active',
  primary_goal: 'lose_fast',
  diet_restrictions: ['dairy'],
};

describe('PUT /profile DTO — mobile legacy payloads no longer 400', () => {
  it('reproduces the pre-C06 failure mode: an unknown key is still a 400', async () => {
    await expect(validate({ ...LEAN_PAYLOAD, not_a_field: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['lean onboarding', LEAN_PAYLOAD],
    ['legacy results screen', LEGACY_RESULTS_PAYLOAD],
    ['EditProfile', EDIT_PROFILE_PAYLOAD],
  ])('accepts the %s payload', async (_name, payload) => {
    await expect(validate(payload)).resolves.toBeInstanceOf(UpdateProfileDto);
  });

  it('still rejects out-of-vocabulary legacy values', async () => {
    await expect(validate({ primary_goal: 'get_huge' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(validate({ fitness_level: 'elite' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still never accepts user_id or macro_target_* (audit C4)', async () => {
    await expect(validate({ user_id: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ macro_target_calories: 900 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('legacy field mapping', () => {
  it('maps the lean payload (kg) onto canonical columns', async () => {
    const dto = await validate(LEAN_PAYLOAD);
    expect(legacyWeightUnit(dto)).toBe('kg');
    expect(mapLegacyProfileFields(dto)).toEqual({
      date_of_birth: new Date('1992-04-15'),
      current_weight_lbs: 158.7,
      goal_type: 'fat_loss',
      workout_experience: 'intermediate',
      onboardingCompleted: true,
    });
  });

  it('honours an explicit weight_unit over the lean signature', async () => {
    const dto = await validate({ ...LEAN_PAYLOAD, weight_unit: 'lbs' });
    expect(mapLegacyProfileFields(dto).current_weight_lbs).toBe(72);
  });

  it('maps EditProfile (lbs) and gym_membership onto the boolean only', async () => {
    const dto = await validate(EDIT_PROFILE_PAYLOAD);
    expect(legacyWeightUnit(dto)).toBe('lbs');
    expect(mapLegacyProfileFields(dto)).toEqual({
      date_of_birth: new Date('1985-01-02'),
      current_weight_lbs: 190,
      target_weight_lbs: 175,
      goal_type: 'fat_loss',
      dietary_pattern: 'none',
      dietary_restrictions: ['dairy'],
      has_gym_membership: true,
    });
  });
});

describe('ProfileService.updateProfile + computeAndSaveMacros', () => {
  function makePrisma(existing: Record<string, unknown> | null) {
    let row: Record<string, unknown> | null = existing;
    const prisma: Record<string, unknown> & {
      userProfile: Record<string, jest.Mock>;
    } = {
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
      // B606-3 row lock (SELECT ... FOR UPDATE); no contention in this suite.
      $queryRaw: jest.fn(async () => []),
      userProfile: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          row = { ...(row ?? {}), ...data };
          return row;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          row = { ...data };
          return row;
        }),
      },
    };
    return {
      prisma,
      get row() {
        return row;
      },
    };
  }

  it('never writes null for skipped answers and never trusts client-computed targets', async () => {
    const h = makePrisma({
      user_id: 'u1',
      sex: 'male',
      activity_level: 'moderate',
      height_cm: 180,
      date_of_birth: new Date('1990-01-01'),
    });
    const svc = new ProfileService(asPrisma(h.prisma));
    const dto = await validate(LEGACY_RESULTS_PAYLOAD);
    await svc.updateProfile('u1', dto);
    const written = h.prisma.userProfile.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(written).not.toHaveProperty('sex');
    expect(written).not.toHaveProperty('height_cm');
    // Targets are server-computed by the single calculator, never the
    // client-sent `tdee` / `calorie_target`.
    expect(written.macro_target_calories).not.toBe(LEGACY_RESULTS_PAYLOAD.calorie_target);
    expect(written).not.toHaveProperty('tdee');
    expect(written).not.toHaveProperty('calorie_target');
    expect(written).toMatchObject({
      current_weight_lbs: 180,
      goal_type: 'muscle_gain',
      onboardingCompleted: true,
    });
  });

  it('computes targets with the single calculator when inputs are complete', async () => {
    const h = makePrisma(null);
    const svc = new ProfileService(asPrisma(h.prisma));
    await svc.updateProfile('u1', await validate(LEAN_PAYLOAD), new Date('2026-09-30T12:00:00Z'));
    expect(h.row).toMatchObject({ macro_target_calories: expect.any(Number) });
    expect((h.row as Record<string, number>).macro_target_calories).toBeGreaterThanOrEqual(1200);
  });

  it('writes no targets (no 180 lb / 175 cm / age 30 defaults) when inputs are missing', async () => {
    const h = makePrisma({
      user_id: 'u1',
      sex: 'male',
      activity_level: 'moderate',
      goal_type: 'fat_loss',
    });
    const svc = new ProfileService(asPrisma(h.prisma));
    await svc.computeAndSaveMacros('u1');
    expect(h.prisma.userProfile.update).not.toHaveBeenCalled();
  });
});
