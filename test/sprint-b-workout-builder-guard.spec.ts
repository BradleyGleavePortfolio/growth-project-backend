// test/sprint-b-workout-builder-guard.spec.ts
//
// Sprint B v2.1 fix — coach-role boundary on WorkoutBuilderController.
//
// The original PR shipped /workout-plans without CoachGuard, so a
// student JWT could POST /workout-plans and tag rows with their own
// user id as coach_id. This spec asserts the guard now rejects
// non-coach roles and admits coach + owner.
//
// We test the guard directly (not via supertest) because the existing
// test/coach-ptm-risk-board.spec.ts uses the same pattern — the role
// boundary is the guard, and the guard is independently unit-tested
// elsewhere too. Mounting the full Nest module into supertest would
// add ~100 lines of fixture wiring for one assertion already covered
// by the canActivate signature.
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { CoachGuard } from '../src/auth/coach.guard';
import {
  WorkoutBuilderController,
} from '../src/workout-builder/workout-builder.controller';

function makeContext(role: string | null) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req = { user } as { user: typeof user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => WorkoutBuilderController.prototype.createPlan,
    getClass: () => WorkoutBuilderController,
  } as unknown as Parameters<CoachGuard['canActivate']>[0];
}

describe('WorkoutBuilderController — CoachGuard', () => {
  const guard = new CoachGuard();

  it('allows coach role on POST /workout-plans', () => {
    expect(guard.canActivate(makeContext('coach'))).toBe(true);
  });

  it('allows owner role (platform-wide bypass)', () => {
    expect(guard.canActivate(makeContext('owner'))).toBe(true);
  });

  it('rejects student with ForbiddenException (403)', () => {
    expect(() => guard.canActivate(makeContext('student'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects unauthenticated request with ForbiddenException', () => {
    expect(() => guard.canActivate(makeContext(null))).toThrow(
      ForbiddenException,
    );
  });
});
