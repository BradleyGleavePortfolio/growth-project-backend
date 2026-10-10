import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { ProfileController } from '../src/profile/profile.controller';
import { ProfileService } from '../src/profile/profile.service';
import { MacrosService } from '../src/macros/macros.service';
import type { PrismaService } from '../src/prisma.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { UpdateProfileDto } from '../src/profile/profile.dto';
import { FLOOR_CASES, FLOOR_CASE_WEIGHT_LBS } from './_fixtures/calorie-floor-cases';

// Fix-round regressions for the independent audit of PR #606:
//   B606-1: PUT /profile with incomplete calculator inputs must return the
//           contract's 409 { code: 'consultation_incomplete', missing } and
//           write nothing (no silent defaults, no half-applied profile).
//   B606-2: PUT /profile must return the newly computed, floor-respecting
//           targets; PUT, GET /profile and GET /me/macros/current agree.
// Both are the audit's own reproductions (evidence/sol-profile.spec.ts)
// inverted into permanent acceptance tests through the real controller.

function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

function req(id: string): AuthedRequest {
  const r: object = { user: { id } };
  return r as AuthedRequest;
}

function dto(v: object): UpdateProfileDto {
  return v as UpdateProfileDto;
}

function harness(initial: Record<string, unknown> | null) {
  let row: Record<string, unknown> | null = initial ? { ...initial } : null;
  const writes: Array<Record<string, unknown>> = [];
  const userProfile = {
    findUnique: jest.fn(async () =>
      row ? { ...row, updated_at: new Date('2026-09-30T00:00:00Z') } : null,
    ),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      row = { ...(row ?? {}), ...data };
      return { ...row };
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      row = { ...data };
      return { ...row };
    }),
  };
  const prisma: Record<string, unknown> = {
    userProfile,
    macroTarget: { findFirst: jest.fn(async () => null) },
    // Read by the stacked onboarding display-mode lookup (#607); no intake here.
    clientOnboardingIntake: { findUnique: jest.fn(async () => null) },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  // B606-3 row lock (SELECT ... FOR UPDATE); concurrency is covered in
  // test/profile-put-concurrency.spec.ts.
  prisma.$queryRaw = jest.fn(async () => []);
  const svc = new ProfileService(asPrisma(prisma));
  const macros = new MacrosService(asPrisma(prisma));
  return {
    svc,
    macros,
    controller: new ProfileController(svc),
    writes,
    row: () => row,
  };
}

async function conflictBody(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    const ex = e as ConflictException;
    expect(ex.getStatus()).toBe(409);
    return ex.getResponse() as Record<string, unknown>;
  }
  throw new Error('expected 409');
}

describe('B606-1: PUT /profile with incomplete inputs returns 409 consultation_incomplete', () => {
  it('audit reproduction: weight, height and DOB absent -> 409 with missing list, nothing written', async () => {
    const h = harness({
      user_id: 'audit-client',
      sex: 'female',
      activity_level: 'moderate',
      goal_type: 'fat_loss',
    });
    const body = await conflictBody(h.controller.updateProfile(req('audit-client'), dto({})));
    expect(body.code).toBe('consultation_incomplete');
    expect(body.missing).toEqual(['weight', 'height_cm', 'date_of_birth']);
    expect(h.writes).toHaveLength(0);
  });

  it('first PUT for a new user without a profile and partial inputs -> 409, no row created', async () => {
    const h = harness(null);
    const body = await conflictBody(
      h.controller.updateProfile(req('u-new'), dto({ sex: 'male', bio: 'hello' })),
    );
    expect(body.code).toBe('consultation_incomplete');
    expect(h.row()).toBeNull();
  });

  it('does not invent 180 lb / 175 cm / age 30 when only weight is missing', async () => {
    const h = harness({
      user_id: 'u1',
      sex: 'male',
      activity_level: 'moderate',
      goal_type: 'fat_loss',
      height_cm: 180,
      date_of_birth: new Date('1990-01-01'),
    });
    const body = await conflictBody(h.controller.updateProfile(req('u1'), dto({ bio: 'x' })));
    expect(body.missing).toEqual(['weight']);
    expect(h.writes).toHaveLength(0);
  });
});

describe('B606-2: PUT /profile returns the recomputed, floor-respecting targets', () => {
  const now = new Date('2026-09-30T12:00:00Z');

  it('audit reproduction: stored 800 kcal -> PUT response, GET /profile and /me/macros/current all show the 1,200 floor', async () => {
    const h = harness({
      user_id: 'audit-client',
      sex: 'female',
      activity_level: 'sedentary',
      goal_type: 'fat_loss',
      current_weight_lbs: 95,
      height_cm: 150,
      date_of_birth: new Date('1946-01-01'),
      macro_target_calories: 800,
      macro_target_protein_g: 95,
      macro_target_carbs_g: 50,
      macro_target_fat_g: 20,
    });
    const put = (await h.controller.updateProfile(req('audit-client'), dto({}))) as Record<
      string,
      unknown
    >;
    expect(put.macro_target_calories).toBe(1200);
    expect(h.writes).toHaveLength(1); // profile + targets in one write

    const get = (await h.controller.getProfile(req('audit-client'))) as Record<string, unknown>;
    expect(get.macro_target_calories).toBe(1200);

    const current = await h.macros.getCurrentForSelf('audit-client');
    expect(current).toMatchObject({
      source: 'profile',
      calories_kcal: put.macro_target_calories,
      protein_g: put.macro_target_protein_g,
      carbs_g: put.macro_target_carbs_g,
      fats_g: put.macro_target_fat_g,
    });
  });

  it('floor transition back up: a weight change lifts targets off the floor and the response shows the new value', async () => {
    const h = harness({
      user_id: 'u2',
      sex: 'female',
      activity_level: 'moderate',
      goal_type: 'fat_loss',
      current_weight_lbs: 172,
      target_weight_lbs: 150,
      height_cm: 167.64,
      date_of_birth: new Date('1988-01-01'),
      macro_target_calories: 1200,
    });
    const put = (await h.svc.updateProfile('u2', dto({}), now)) as Record<string, unknown>;
    // Contract worked example: 1,789 kcal, P150 F50 C185.
    expect(put).toMatchObject({
      macro_target_calories: 1789,
      macro_target_protein_g: 150,
      macro_target_fat_g: 50,
      macro_target_carbs_g: 185,
    });
    const current = await h.macros.getCurrentForSelf('u2');
    expect(current).toMatchObject({
      calories_kcal: 1789,
      protein_g: 150,
      fats_g: 50,
      carbs_g: 185,
    });
  });

  it('client-sent targets are ignored; the server value is returned', async () => {
    const h = harness({
      user_id: 'u3',
      sex: 'male',
      activity_level: 'moderate',
      goal_type: 'maintenance',
      current_weight_lbs: 180,
      height_cm: 180,
      date_of_birth: new Date('1990-01-01'),
    });
    const put = (await h.svc.updateProfile(
      'u3',
      dto({ calorie_target: 9999, tdee: 9999 }),
      now,
    )) as Record<string, unknown>;
    expect(put.macro_target_calories).not.toBe(9999);
    expect(put.macro_target_calories).toBeGreaterThanOrEqual(1500);
  });

  it.each(FLOOR_CASES)(
    'calorie floor: $sex $where the floor stores $expected kcal',
    async ({ sex, height_cm, expected }) => {
      const h = harness({
        user_id: 'u-floor',
        sex,
        activity_level: 'sedentary',
        goal_type: 'maintenance',
        current_weight_lbs: FLOOR_CASE_WEIGHT_LBS,
        height_cm,
        date_of_birth: new Date('1988-01-01'),
      });
      const put = (await h.svc.updateProfile('u-floor', dto({}), now)) as Record<string, unknown>;
      expect(put.macro_target_calories).toBe(expected);
      const recomputed = await h.svc.computeAndSaveMacros('u-floor', now);
      expect(recomputed?.macro_target_calories).toBe(expected);
    },
  );
});
