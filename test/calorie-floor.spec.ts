import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { calorieFloorKcal } from '../src/macros/calorie-floor';
import { computeMacros } from '../src/macros/macro-calculator';
import { CreateMacroTargetDto } from '../src/macros/macros.dto';
import { MacrosService } from '../src/macros/macros.service';
import type { PrismaService } from '../src/prisma.service';
import {
  FLOOR_CASES,
  FLOOR_CASE_AGE,
  FLOOR_CASE_WEIGHT_KG,
  FLOOR_CASE_WEIGHT_LBS,
} from './_fixtures/calorie-floor-cases';

// One hard daily calorie floor: 1,200 kcal for women, 1,500 kcal for men and
// for anyone whose sex is not recorded. Coach targets below it are rejected;
// computed targets are raised to it.

describe('calorieFloorKcal', () => {
  it.each([
    ['female', 1200],
    ['male', 1500],
    ['prefer_not_to_say', 1500],
    [null, 1500],
    [undefined, 1500],
    ['other', 1500],
  ])('%s -> %i kcal', (sex, floor) => {
    expect(calorieFloorKcal(sex)).toBe(floor);
  });
});

describe('coach-set targets (MacrosService.createForClient)', () => {
  function world(profile: { sex: string } | null) {
    const create = jest.fn(async ({ data }: { data: object }) => ({ id: 'target-1', ...data }));
    const prisma = {
      user: { findFirst: jest.fn(async () => ({ id: 'client-1' })) },
      userProfile: { findUnique: jest.fn(async () => profile) },
      macroTarget: { create },
    };
    return { svc: new MacrosService(prisma as unknown as PrismaService), create };
  }
  const dto = (calories_kcal: number): CreateMacroTargetDto => ({
    calories_kcal,
    protein_g: 120,
    carbs_g: 100,
    fats_g: 40,
  });
  const clients = [
    ['a woman', { sex: 'female' }, 1200, '1,200'],
    ['a man', { sex: 'male' }, 1500, '1,500'],
    ['a client who prefers not to say', { sex: 'prefer_not_to_say' }, 1500, '1,500'],
    ['a client with no profile', null, 1500, '1,500'],
  ] as const;

  it.each(clients)(
    'rejects a target below the floor for %s',
    async (_who, profile, floor, shown) => {
      const w = world(profile);
      const saving = w.svc.createForClient('coach-1', 'client-1', dto(floor - 1));
      await expect(saving).rejects.toBeInstanceOf(BadRequestException);
      await expect(saving).rejects.toThrow(
        new BadRequestException(`Calorie targets can't go below ${shown} for this client.`),
      );
      expect(w.create).not.toHaveBeenCalled();
    },
  );

  it.each(clients)('saves a target at and above the floor for %s', async (_who, profile, floor) => {
    for (const kcal of [floor, floor + 1]) {
      const w = world(profile);
      await expect(w.svc.createForClient('coach-1', 'client-1', dto(kcal))).resolves.toMatchObject({
        calories_kcal: kcal,
      });
    }
  });

  it('leaves the lower bound to the service so every low number gets the floor message', async () => {
    const errors = await validate(plainToInstance(CreateMacroTargetDto, dto(700)));
    expect(errors).toEqual([]);
  });
});

describe('computed targets are raised to the floor, never rejected', () => {
  it.each(FLOOR_CASES)(
    'calculator: $sex $where the floor -> $expected kcal',
    ({ sex, where, height_cm, expected }) => {
      const m = computeMacros({
        weight_lbs: FLOOR_CASE_WEIGHT_LBS,
        height_cm,
        age_years: FLOOR_CASE_AGE,
        sex,
        activity_level: 'sedentary',
        goal: 'maintenance',
      });
      expect(m.calories).toBe(expected);
      expect(m.floor_applied).toBe(where === 'below');
    },
  );

  it.each(FLOOR_CASES)(
    'coach preset: $sex $where the floor -> $expected kcal',
    ({ sex, height_cm, expected }) => {
      const svc = new MacrosService(null as unknown as PrismaService);
      const out = svc.computePreset({
        weight_kg: FLOOR_CASE_WEIGHT_KG,
        height_cm,
        age_years: FLOOR_CASE_AGE,
        sex,
        activity_level: 'sedentary',
        goal: 'maintain',
      });
      expect(out.calories_kcal).toBe(expected);
    },
  );
});
