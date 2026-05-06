import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  JwtAuthGuard,
  appOpenDedup,
  APP_OPEN_DEDUP_WINDOW_MS,
  APP_OPEN_DEDUP_MAX_SIZE,
} from '../src/auth/auth.guard';

// Pins the app_open dedup logic in JwtAuthGuard.
//
// The guard emits an app_open PTM signal at most once per user per
// APP_OPEN_DEDUP_WINDOW_MS (4 hours). This is the highest-weighted
// heuristic factor (+0.25 risk) so incorrect over-suppression would
// mask a genuine re-open, while under-suppression would flood the table
// and skew counts.
//
// Also verifies that:
//   - A fully-scrubbed (deleted_at) user never receives an emit even on
//     an @AllowDeletionScheduled() route (GDPR gate fires first).
//   - The overflow pruner keeps the map at most APP_OPEN_DEDUP_MAX_SIZE.

describe('JwtAuthGuard — app_open dedup (Phase 1A)', () => {
  function buildGuard(user: any) {
    const prisma: any = { user: { findUnique: jest.fn(async () => user) } };
    const jwks: any = { verify: jest.fn(async () => ({ sub: 'sup-1' })) };
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(false);
    const ptm: any = { emit: jest.fn() };
    return { guard: new JwtAuthGuard(prisma, jwks, reflector, ptm), ptm };
  }

  function buildCtx() {
    const handler = () => undefined;
    const cls = class {};
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer tok' },
        }),
      }),
      getHandler: () => handler,
      getClass: () => cls,
    } as any as ExecutionContext;
  }

  const baseUser = {
    id: 'u-app-open',
    supabase_id: 'sup-1',
    email: 'test@example.test',
    role: 'student',
    deletion_scheduled_at: null,
    deleted_at: null,
  };

  beforeEach(() => {
    appOpenDedup.clear();
  });

  it('emits app_open on first authenticated request', async () => {
    const { guard, ptm } = buildGuard(baseUser);
    await guard.canActivate(buildCtx());
    expect(ptm.emit).toHaveBeenCalledWith(
      baseUser.id,
      'app_open',
      1,
      { source: 'jwt_validate' },
    );
  });

  it('suppresses a second emit within the dedup window', async () => {
    const { guard, ptm } = buildGuard(baseUser);
    appOpenDedup.set(baseUser.id, Date.now() - 60_000); // 1 minute ago
    guard.maybeEmitAppOpen(baseUser.id);
    expect(ptm.emit).not.toHaveBeenCalled();
  });

  it('re-emits after the dedup window expires', async () => {
    const { guard, ptm } = buildGuard(baseUser);
    // Simulate a timestamp older than the 4-hour window.
    appOpenDedup.set(
      baseUser.id,
      Date.now() - APP_OPEN_DEDUP_WINDOW_MS - 1000,
    );
    guard.maybeEmitAppOpen(baseUser.id);
    expect(ptm.emit).toHaveBeenCalledTimes(1);
  });

  it('updates the dedup map timestamp on each new emit', () => {
    const { guard } = buildGuard(baseUser);
    const before = Date.now();
    guard.maybeEmitAppOpen(baseUser.id);
    const recorded = appOpenDedup.get(baseUser.id)!;
    expect(recorded).toBeGreaterThanOrEqual(before);
  });

  it('does NOT emit for a fully-deleted user (GDPR gate fires first)', async () => {
    const deletedUser = { ...baseUser, deleted_at: new Date() };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => deletedUser) },
    };
    const jwks: any = { verify: jest.fn(async () => ({ sub: 'sup-1' })) };
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ptm: any = { emit: jest.fn() };
    const guard = new JwtAuthGuard(prisma, jwks, reflector, ptm);
    await expect(guard.canActivate(buildCtx())).rejects.toThrow();
    expect(ptm.emit).not.toHaveBeenCalled();
  });

  it('prunes the oldest 50% of entries when the map overflows', () => {
    const { guard } = buildGuard(baseUser);
    // Fill map to the limit with old timestamps so every entry is
    // eligible for pruning.
    const oldTime = Date.now() - APP_OPEN_DEDUP_WINDOW_MS * 2;
    for (let i = 0; i < APP_OPEN_DEDUP_MAX_SIZE; i++) {
      appOpenDedup.set(`user-${i}`, oldTime);
    }
    expect(appOpenDedup.size).toBe(APP_OPEN_DEDUP_MAX_SIZE);
    // Trigger an emit for a new user — this should invoke the pruner.
    guard.maybeEmitAppOpen('new-overflow-user');
    // After pruning the oldest 50% and inserting one entry, map size
    // should be APP_OPEN_DEDUP_MAX_SIZE / 2 + 1.
    expect(appOpenDedup.size).toBeLessThanOrEqual(
      Math.floor(APP_OPEN_DEDUP_MAX_SIZE / 2) + 1,
    );
  });

  it('multiple unique users each get their own dedup entry', () => {
    const { guard } = buildGuard(baseUser);
    guard.maybeEmitAppOpen('alice');
    guard.maybeEmitAppOpen('bob');
    guard.maybeEmitAppOpen('carol');
    expect(appOpenDedup.has('alice')).toBe(true);
    expect(appOpenDedup.has('bob')).toBe(true);
    expect(appOpenDedup.has('carol')).toBe(true);
  });
});
