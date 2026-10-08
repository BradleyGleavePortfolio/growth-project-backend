import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateWorkoutDto, UpdateWorkoutDto } from '../src/workout/workout.dto';

const workout = {
  workout_name: 'Strength',
  workout_type: 'strength',
  notes: 'Completed session',
  exercises: [
    {
      exercise_name: 'Squat',
      muscle_group: 'legs',
      sets_completed: 1,
      reps_per_set: [8],
      weight_per_set: [60],
    },
  ],
};

describe.each([
  { name: 'CreateWorkoutDto', metatype: CreateWorkoutDto },
  { name: 'UpdateWorkoutDto', metatype: UpdateWorkoutDto },
])('$name duration', ({ metatype }) => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = { type: 'body' as const, metatype };
  const transformDuration = (duration_minutes: unknown) =>
    pipe.transform({ ...workout, duration_minutes }, metadata);

  it.each([1441, 2880])('caps a resumed or queued duration of %i minutes', async (duration) => {
    await expect(transformDuration(duration)).resolves.toMatchObject({
      ...workout,
      duration_minutes: 1440,
    });
  });

  it.each([0, 45, 1440])('preserves a duration of %i minutes', async (duration) => {
    await expect(transformDuration(duration)).resolves.toMatchObject({
      ...workout,
      duration_minutes: duration,
    });
  });

  it('keeps duration optional', async () => {
    const result = await pipe.transform(workout, metadata);
    expect(result.duration_minutes).toBeUndefined();
  });

  it.each([-1, 45.5, 1440.5, '1441'])('still rejects an invalid duration of %p', async (duration) => {
    await expect(transformDuration(duration)).rejects.toBeInstanceOf(BadRequestException);
  });
});
