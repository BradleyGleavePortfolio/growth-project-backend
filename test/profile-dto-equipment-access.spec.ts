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

// `equipment_access` extends the `has_gym_membership` boolean with a granular
// list so the AI workout-builder can pick between barbell, dumbbell, band,
// and bodyweight programming. The schema column is free-form `String[]` so
// future tokens do not require a migration; the DTO restricts new writes to
// the curated vocabulary so an attacker cannot stuff arbitrary strings into
// the profile and have them surface in the AI prompt.
describe('UpdateProfileDto — equipment_access', () => {
  const curated = [
    'full_gym',
    'home_gym',
    'dumbbells',
    'kettlebells',
    'barbell',
    'resistance_bands',
    'pull_up_bar',
    'cardio_machine',
    'bodyweight_only',
    'other',
  ] as const;

  it.each(curated)('accepts curated value %s as a single-element list', async (v) => {
    const out = await run({ equipment_access: [v] });
    expect(out.equipment_access).toEqual([v]);
  });

  it('accepts a multi-element subset of the curated vocabulary', async () => {
    const out = await run({
      equipment_access: ['dumbbells', 'pull_up_bar', 'resistance_bands'],
    });
    expect(out.equipment_access).toEqual([
      'dumbbells',
      'pull_up_bar',
      'resistance_bands',
    ]);
  });

  it('accepts an empty array (explicit "answered, nothing extra")', async () => {
    const out = await run({ equipment_access: [] });
    expect(out.equipment_access).toEqual([]);
  });

  it('accepts absence (field is optional)', async () => {
    const out = await run({});
    expect(out.equipment_access).toBeUndefined();
  });

  it('rejects values outside the curated vocabulary', async () => {
    await expect(
      run({ equipment_access: ['dumbbells', 'sandbag'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-array values', async () => {
    await expect(run({ equipment_access: 'dumbbells' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects arrays containing non-strings', async () => {
    await expect(run({ equipment_access: ['dumbbells', 7] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects null entries inside the array', async () => {
    await expect(run({ equipment_access: [null] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts equipment_access alongside the legacy has_gym_membership boolean', async () => {
    // The two co-exist intentionally: `has_gym_membership` stays as the
    // legacy "gym vs not" signal that older mobile clients still write,
    // while `equipment_access` provides the granular list the AI prompt
    // now uses. New writes from updated clients should set both.
    const out = await run({
      has_gym_membership: false,
      equipment_access: ['dumbbells', 'resistance_bands'],
    });
    expect(out.has_gym_membership).toBe(false);
    expect(out.equipment_access).toEqual(['dumbbells', 'resistance_bands']);
  });
});
