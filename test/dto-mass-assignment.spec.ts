import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { LogFoodDto, UpdateLogEntryDto } from '../src/log/log.dto';
import { CreateHabitDto } from '../src/habits/habits.dto';
import { CreateRoutineDto } from '../src/workout/workout.dto';
import { UpdateNotificationPreferencesDto } from '../src/notifications/notifications.dto';
import { CreateLessonDto } from '../src/lessons/lessons.dto';
import { CreateFoodDto } from '../src/food/food.dto';
import { CreateInviteCodeDto } from '../src/invite-codes/invite-codes.dto';

// Regression tests for the round-5 mass-assignment sweep. Each case proves that
// the ValidationPipe (whitelist + forbidNonWhitelisted + transform) strips or
// rejects fields that used to reach Prisma via `@Body() body: any`.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

async function run<T>(dto: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, { type: 'body', metatype: dto as any });
}

describe('DTO mass-assignment lockdown', () => {
  it('LogFoodDto rejects unknown fields like user_id / id', async () => {
    await expect(
      run(LogFoodDto, {
        date: '2025-01-01',
        meal_type: 'breakfast',
        food_item_id: 'fi-1',
        user_id: 'someone-else',
        id: 'forged',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('UpdateLogEntryDto rejects attempts to overwrite user_id', async () => {
    await expect(
      run(UpdateLogEntryDto, { quantity_multiplier: 2, user_id: 'attacker' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CreateHabitDto accepts only schema fields', async () => {
    const out = await run(CreateHabitDto, { name: 'Walk', category: 'custom' });
    expect(out).toEqual({ name: 'Walk', category: 'custom' });
    await expect(
      run(CreateHabitDto, { name: 'Walk', user_id: 'victim' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CreateRoutineDto does not accept is_template or creator_id', async () => {
    // is_template=true would publish the routine to every user via the
    // `{ OR: [{ creator_id: userId }, { is_template: true }] }` clause.
    await expect(
      run(CreateRoutineDto, { name: 'R', is_template: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateRoutineDto, { name: 'R', creator_id: 'other' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('UpdateNotificationPreferencesDto validates quiet_hours format', async () => {
    await expect(
      run(UpdateNotificationPreferencesDto, { quiet_hours_start: '25:99' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const ok = await run(UpdateNotificationPreferencesDto, {
      quiet_hours_start: '07:30',
      water_enabled: false,
    });
    expect(ok).toEqual({ quiet_hours_start: '07:30', water_enabled: false });
  });

  it('CreateLessonDto does not accept coach_id from the client', async () => {
    // coach_id is always the authenticated user; a client-supplied value would
    // let a coach publish lessons to another coach's students.
    await expect(
      run(CreateLessonDto, { title: 'L', coach_id: 'victim-coach' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('CreateInviteCodeDto rejects coach_id / used_count / revoked', async () => {
    // coach_id is set server-side from req.user — a client-supplied value would
    // let one coach mint codes that redeem into another coach's roster.
    await expect(
      run(CreateInviteCodeDto, { coach_id: 'victim-coach' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateInviteCodeDto, { used_count: -1000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(CreateInviteCodeDto, { revoked: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Empty body is valid — both fields are optional.
    const ok = await run(CreateInviteCodeDto, {});
    expect(ok).toEqual({});
  });

  it('CreateFoodDto strips id / created_at attempts', async () => {
    await expect(
      run(CreateFoodDto, {
        name: 'Apple',
        serving_description: '1 medium',
        serving_size_grams: 182,
        calories: 95,
        protein_g: 0,
        carbs_g: 25,
        fat_g: 0,
        id: 'forged-uuid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
