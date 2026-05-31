import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CoachMessagingController } from '../src/messaging/coach-messaging.controller';
import { RolesGuard } from '../src/auth/roles.guard';
import { ROLES_KEY, AppRole } from '../src/common/decorators/roles.decorator';

// #5 — defence-in-depth: CoachMessagingController must carry an explicit
// class-level @Roles('coach'). The runtime CoachGuard already gates these
// routes, but the global RolesGuard + @Roles is the second layer the
// roles-enforced meta-test enforces. These tests prove the decorator is both
// PRESENT (metadata) and ENFORCED (RolesGuard actually reads it and rejects a
// non-coach) — so the defence-in-depth is real, not cosmetic.

function ctxFor(controllerClass: Function, role?: AppRole) {
  // Mirrors how RolesGuard reads metadata via Reflector.getAllAndOverride
  // over [handler, class]; the class-level @Roles must apply to every handler.
  return {
    getHandler: () => () => undefined,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: () => (role ? { user: { id: 'u1', role } } : { user: undefined }),
    }),
  } as any;
}

describe('CoachMessagingController @Roles defence-in-depth (#5)', () => {
  it('carries class-level @Roles(\'coach\') metadata', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, CoachMessagingController) as
      | AppRole[]
      | undefined;
    expect(roles).toEqual(['coach']);
  });

  describe('global RolesGuard actually enforces the class-level @Roles', () => {
    const guard = new RolesGuard(new Reflector());

    it('allows a coach', () => {
      expect(guard.canActivate(ctxFor(CoachMessagingController, 'coach'))).toBe(
        true,
      );
    });

    it('allows an owner (hierarchy bypass)', () => {
      expect(guard.canActivate(ctxFor(CoachMessagingController, 'owner'))).toBe(
        true,
      );
    });

    it('rejects a student', () => {
      expect(() =>
        guard.canActivate(ctxFor(CoachMessagingController, 'student')),
      ).toThrow(ForbiddenException);
    });

    it('rejects an unauthenticated request', () => {
      expect(() =>
        guard.canActivate(ctxFor(CoachMessagingController, undefined)),
      ).toThrow(ForbiddenException);
    });
  });
});
