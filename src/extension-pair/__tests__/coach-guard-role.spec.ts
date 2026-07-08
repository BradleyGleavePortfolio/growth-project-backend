// The init + status routes are gated by CoachGuard (see the wiring spec). This
// pins the guard's ROLE contract, which is the security invariant those routes
// lean on: only coach/owner pass; every other authenticated caller (and the
// unauthenticated case) gets 403. This matches the @Roles('coach','owner') +
// RolesGuard enforcement used by the sibling importer PRs — CoachGuard is the
// pre-existing equivalent, so the pairing routes stay consistent with them.
import { ForbiddenException } from '@nestjs/common';
import { CoachGuard } from '../../auth/coach.guard';
import { executionContextFor as contextFor } from './test-doubles.test';

describe('CoachGuard role contract (extension-pair init + status)', () => {
  const guard = new CoachGuard();

  it('admits a coach', () => {
    expect(guard.canActivate(contextFor({ id: 'c1', role: 'coach' }))).toBe(true);
  });

  it('admits an owner (platform-admin bypass)', () => {
    expect(guard.canActivate(contextFor({ id: 'o1', role: 'owner' }))).toBe(true);
  });

  it('rejects a student with 403', () => {
    expect(() => guard.canActivate(contextFor({ id: 's1', role: 'student' }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an authenticated caller with an unknown role with 403', () => {
    expect(() => guard.canActivate(contextFor({ id: 'x1', role: 'client' }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a caller with no user (unauthenticated) with 403', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });
});
