import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * WORKOUT-REFUSAL-CODES-BE (owner 203-P1, Style 2 "Tells you why"): the refusals of POST /workouts and
 * PUT /workouts/:id a client can meet today, each with a stable code and one plain next step for the
 * phone's refused-workout card. WorkoutRefusalFilter adds both to the exception's own body (status,
 * message and error stay as thrown); error-details.ts lets `next_step` through for these codes only.
 * This file imports nothing from src/filters/: error-details.ts imports it, so a filter import here
 * would close a loop through http-exception.filter.ts.
 */
export interface WorkoutRefusal {
  readonly code: string;
  readonly next_step: string;
  /** The class it is thrown as; the coded copy keeps it. */
  readonly type: typeof BadRequestException | typeof NotFoundException;
  /** True for this refusal's `message` (a body that already carries a code never matches). */
  readonly matches: (message: unknown) => boolean;
}

export const WORKOUT_REFUSALS: readonly WorkoutRefusal[] = [
  {
    // The global ValidationPipe (main.ts) on CreateWorkoutDto or UpdateWorkoutDto: an array of lines.
    code: 'WORKOUT_INVALID',
    next_step: 'If an app update is waiting, install it, then send it again.',
    type: BadRequestException,
    matches: (message) => Array.isArray(message),
  },
  {
    // updateWorkout: a workout no longer there and another member's answer alike.
    code: 'WORKOUT_NOT_FOUND',
    next_step: 'This workout is no longer in your history. Remove it from this phone.',
    type: NotFoundException,
    matches: (message) => message === 'Workout not found',
  },
];
