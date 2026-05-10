import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { ALLOW_DELETION_SCHEDULED_KEY } from '../src/common/decorators/allow-deletion-scheduled.decorator';

// Pins the GDPR-lifecycle gate in JwtAuthGuard. A scheduled-for-deletion
// user must be locked out of every route except those explicitly opted in
// with @AllowDeletionScheduled(); a fully-scrubbed user (deleted_at set)
// is locked out of every route, period. Without these checks a logged-in
// client could keep mutating data through the 30-day grace window.
//
// NOTE: JwtAuthGuard now also fires a fire-and-forget app_open PTM signal
// after the GDPR gates pass. The ptm mock injected below ensures the signal
// path is exercised safely — any emission for deleted/scheduled users would
// be a regression because those code paths throw before reaching emit.
describe('JwtAuthGuard — GDPR lifecycle lockout', () => {
  function buildContext(metadataFlag: boolean) {
    const handler = () => undefined;
    const cls = class {};
    const ctx: ExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer t' },
        }),
      }),
      getHandler: () => handler,
      getClass: () => cls,
    } as any;
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: any) => {
      if (key === ALLOW_DELETION_SCHEDULED_KEY) return metadataFlag;
      return false;
    });
    return { ctx, reflector };
  }

  function buildGuard(user: any, reflector: Reflector) {
    const prisma: any = { user: { findUnique: jest.fn(async () => user) } };
    const jwks: any = { verify: jest.fn(async () => ({ sub: 'sup-1' })) };
    // PtmService stub — emit is fire-and-forget; the stub captures calls so
    // tests can assert it was NOT invoked for deleted / locked-out users.
    const ptm: any = { emit: jest.fn() };
    return new JwtAuthGuard(prisma, jwks, reflector, ptm);
  }

  const baseUser = {
    id: 'u-1',
    supabase_id: 'sup-1',
    email: 'a@a.test',
    role: 'student',
    deletion_scheduled_at: null,
    deleted_at: null,
  };

  it('rejects a scheduled-for-deletion user on a non-recovery route', async () => {
    const { ctx, reflector } = buildContext(false);
    const guard = buildGuard(
      { ...baseUser, deletion_scheduled_at: new Date() },
      reflector,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a scheduled-for-deletion user on an @AllowDeletionScheduled() route', async () => {
    const { ctx, reflector } = buildContext(true);
    const guard = buildGuard(
      { ...baseUser, deletion_scheduled_at: new Date() },
      reflector,
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a fully-scrubbed (deleted_at) user even on opted-in routes', async () => {
    const { ctx, reflector } = buildContext(true);
    const guard = buildGuard(
      { ...baseUser, deleted_at: new Date() },
      reflector,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets healthy users through unchanged', async () => {
    const { ctx, reflector } = buildContext(false);
    const guard = buildGuard({ ...baseUser }, reflector);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
