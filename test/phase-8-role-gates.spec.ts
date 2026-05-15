// Phase 8 — Role-gate coverage for the new mobile-facing controllers.
//
// Mirrors test/sprint-b-workout-builder-guard.spec.ts: we exercise the
// CoachGuard directly with each phase-8 controller's method handle to
// prove the guard admits {coach,owner} and rejects {student, none} for
// every new route. The service-layer head-coach checks (only the
// issuing head coach can revoke / reassign) are covered in the
// service spec; the guard test below is the network-layer gate.

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { CoachGuard } from '../src/auth/coach.guard';
import { TeamController } from '../src/team/team.controller';
import { SubCoachesController } from '../src/sub-coaches/sub-coaches.controller';
import { CoachConnectController } from '../src/coach-connect/coach-connect.controller';

function makeContext(role: string | null, handler: () => unknown, cls: unknown) {
  const user = role ? { id: 'u-1', role, email: 'u@x.test' } : null;
  const req = { user } as { user: typeof user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as Parameters<CoachGuard['canActivate']>[0];
}

const guard = new CoachGuard();

describe.each([
  ['TeamController.get', TeamController.prototype.get, TeamController],
  ['TeamController.upsert', TeamController.prototype.upsert, TeamController],
  ['TeamController.members', TeamController.prototype.members, TeamController],
  ['SubCoachesController.list', SubCoachesController.prototype.list, SubCoachesController],
  ['SubCoachesController.detail', SubCoachesController.prototype.detail, SubCoachesController],
  ['SubCoachesController.analytics', SubCoachesController.prototype.analytics, SubCoachesController],
  ['SubCoachesController.invite', SubCoachesController.prototype.invite, SubCoachesController],
  ['SubCoachesController.revoke', SubCoachesController.prototype.revoke, SubCoachesController],
  ['SubCoachesController.reassign', SubCoachesController.prototype.reassign, SubCoachesController],
  ['SubCoachesController.acceptInvite', SubCoachesController.prototype.acceptInvite, SubCoachesController],
  ['CoachConnectController.status', CoachConnectController.prototype.status, CoachConnectController],
  ['CoachConnectController.metrics', CoachConnectController.prototype.metrics, CoachConnectController],
  ['CoachConnectController.payouts', CoachConnectController.prototype.payouts, CoachConnectController],
  ['CoachConnectController.packages', CoachConnectController.prototype.packages, CoachConnectController],
  ['CoachConnectController.onboardingLink', CoachConnectController.prototype.onboardingLink, CoachConnectController],
])('Phase 8 — %s', (_label, handler, cls) => {
  it('allows coach role', () => {
    expect(guard.canActivate(makeContext('coach', handler as () => unknown, cls))).toBe(true);
  });
  it('allows owner role', () => {
    expect(guard.canActivate(makeContext('owner', handler as () => unknown, cls))).toBe(true);
  });
  it('rejects student with 403', () => {
    expect(() => guard.canActivate(makeContext('student', handler as () => unknown, cls))).toThrow(
      ForbiddenException,
    );
  });
  it('rejects unauthenticated', () => {
    expect(() => guard.canActivate(makeContext(null, handler as () => unknown, cls))).toThrow(
      ForbiddenException,
    );
  });
});
