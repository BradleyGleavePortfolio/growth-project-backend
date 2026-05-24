/**
 * RolesGuard — hierarchy unit tests (Phase 10 audit P2-1).
 *
 * The docs (docs/security/role-gating.md) commit to owner > coach > student.
 * Pre-PR-167-fix, the code only bypassed for owner — coach was rejected from
 * any `@Roles('student')` route unless 'coach' was listed explicitly. The
 * fix implements the documented hierarchy in `roleSatisfies` and these tests
 * pin the behavior so future refactors do not regress it.
 */

import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { RolesGuard, roleSatisfies } from '../src/auth/roles.guard';
import { Roles } from '../src/common/decorators/roles.decorator';

describe('roleSatisfies — owner > coach > student hierarchy', () => {
  describe('owner', () => {
    it('passes student-only routes', () => {
      expect(roleSatisfies('owner', ['student'])).toBe(true);
    });
    it('passes coach-only routes', () => {
      expect(roleSatisfies('owner', ['coach'])).toBe(true);
    });
    it('passes owner-only routes', () => {
      expect(roleSatisfies('owner', ['owner'])).toBe(true);
    });
  });

  describe('coach', () => {
    it('passes student-only routes (hierarchy bypass)', () => {
      expect(roleSatisfies('coach', ['student'])).toBe(true);
    });
    it('passes coach-only routes', () => {
      expect(roleSatisfies('coach', ['coach'])).toBe(true);
    });
    it('does NOT pass owner-only routes', () => {
      expect(roleSatisfies('coach', ['owner'])).toBe(false);
    });
  });

  describe('student', () => {
    it('passes student-only routes', () => {
      expect(roleSatisfies('student', ['student'])).toBe(true);
    });
    it('does NOT pass coach-only routes', () => {
      expect(roleSatisfies('student', ['coach'])).toBe(false);
    });
    it('does NOT pass owner-only routes', () => {
      expect(roleSatisfies('student', ['owner'])).toBe(false);
    });
  });
});

describe('RolesGuard — canActivate end-to-end', () => {
  function makeCtx(role: string | null, requiredRoles: string[] | undefined) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { id: 'u', role } : null }),
      }),
      getHandler: () => {
        const fn = function () {};
        if (requiredRoles) {
          Reflect.defineMetadata('roles', requiredRoles, fn);
        }
        return fn;
      },
      getClass: () => class {},
    } as any;
  }

  it('no @Roles metadata — guard is a no-op (passes anything authenticated or not)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(makeCtx('student', undefined))).toBe(true);
    expect(guard.canActivate(makeCtx(null, undefined))).toBe(true);
  });

  it('coach reaches a student-only route under hierarchy', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(makeCtx('coach', ['student']))).toBe(true);
  });

  it('student is rejected from a coach-only route', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeCtx('student', ['coach']))).toThrow(
      ForbiddenException,
    );
  });

  it('coach is rejected from an owner-only route', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeCtx('coach', ['owner']))).toThrow(
      ForbiddenException,
    );
  });

  it('owner passes every role-gated route', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(makeCtx('owner', ['student']))).toBe(true);
    expect(guard.canActivate(makeCtx('owner', ['coach']))).toBe(true);
    expect(guard.canActivate(makeCtx('owner', ['owner']))).toBe(true);
  });

  it('no req.user — Authenticated user required', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(makeCtx(null, ['student']))).toThrow(
      /Authenticated user required/,
    );
  });
});

describe('@Roles decorator integration sanity', () => {
  it('@Roles(...) writes ROLES_KEY metadata that RolesGuard reads', () => {
    class Stub {
      @Roles('coach', 'owner')
      method() {}
    }
    const fn = (Stub.prototype as any).method;
    const meta = Reflect.getMetadata('roles', fn);
    expect(meta).toEqual(['coach', 'owner']);
  });
});
