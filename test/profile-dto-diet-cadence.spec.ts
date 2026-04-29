import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { UpdateProfileDto } from '../src/profile/profile.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function run(value: unknown): Promise<UpdateProfileDto> {
  return pipe.transform(value, {
    type: 'body',
    metatype: UpdateProfileDto as new () => UpdateProfileDto,
  });
}

describe('UpdateProfileDto — dietary + workout cadence (profile-fill UX audit)', () => {
  describe('dietary_pattern', () => {
    it.each(['none', 'vegan', 'vegetarian', 'keto', 'pescatarian', 'paleo', 'other'])(
      'accepts curated value %s',
      async (v) => {
        const out = await run({ dietary_pattern: v });
        expect(out.dietary_pattern).toBe(v);
      },
    );

    it('rejects values outside the curated list', async () => {
      await expect(run({ dietary_pattern: 'carnivore' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects non-string values', async () => {
      await expect(run({ dietary_pattern: 5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts absence (field is optional)', async () => {
      const out = await run({});
      expect(out.dietary_pattern).toBeUndefined();
    });
  });

  describe('dietary_restrictions', () => {
    it('accepts an empty array (explicit "no restrictions")', async () => {
      const out = await run({ dietary_restrictions: [] });
      expect(out.dietary_restrictions).toEqual([]);
    });

    it('accepts an array of strings', async () => {
      const out = await run({ dietary_restrictions: ['peanuts', 'shellfish'] });
      expect(out.dietary_restrictions).toEqual(['peanuts', 'shellfish']);
    });

    it('rejects non-array values', async () => {
      await expect(run({ dietary_restrictions: 'peanuts' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects arrays containing non-strings', async () => {
      await expect(run({ dietary_restrictions: ['peanuts', 7] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('workout_days_per_week', () => {
    it.each([0, 1, 3, 5, 7])('accepts in-range integer %i', async (n) => {
      const out = await run({ workout_days_per_week: n });
      expect(out.workout_days_per_week).toBe(n);
    });

    it('rejects negative values', async () => {
      await expect(run({ workout_days_per_week: -1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects values above 7', async () => {
      await expect(run({ workout_days_per_week: 8 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects fractional values', async () => {
      await expect(run({ workout_days_per_week: 3.5 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects non-numeric values', async () => {
      await expect(run({ workout_days_per_week: 'three' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('accepts a fully-specified payload alongside existing fields', async () => {
    const out = await run({
      height_cm: 178,
      current_weight_lbs: 180,
      sex: 'female',
      goal_type: 'maintenance',
      dietary_pattern: 'vegetarian',
      dietary_restrictions: ['gluten'],
      workout_days_per_week: 4,
    });
    expect(out.height_cm).toBe(178);
    expect(out.dietary_pattern).toBe('vegetarian');
    expect(out.dietary_restrictions).toEqual(['gluten']);
    expect(out.workout_days_per_week).toBe(4);
  });
});
