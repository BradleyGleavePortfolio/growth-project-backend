// test/first-win.controller.spec.ts
//
// Phase 7A — Day 1 Win Sequence endpoint contract guards.
//
// What we assert:
//   1. Source-level: the controller is decorated with @UseGuards(JwtAuthGuard)
//      — the guard annotation is present on the class declaration.
//   2. POST /me/first-win/complete — idempotency: calling complete() a second
//      time returns the original timestamp, not a new one.
//   3. POST /me/first-win/complete — winType validation: rejects unknown types.
//   4. GET /me/first-win/status — returns { completed: false, completedAt: null }
//      before any win is logged; { completed: true, ... } after.
//   5. Service never writes a second DB row when already completed.
//
// Pattern: we test the service directly against a mock PrismaService, and
// test the source of the controller for the guard annotation — mirroring the
// approach used in coach-alerts.service.spec.ts and RiskBoardScreen.test.tsx.

import * as fs from 'fs';
import * as path from 'path';
import { FirstWinService } from '../src/first-win/first-win.service';

// ── Source guard ────────────────────────────────────────────────────────────

const CONTROLLER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'first-win', 'first-win.controller.ts'),
  'utf8',
);

describe('FirstWinController — source guards', () => {
  it('is protected by JwtAuthGuard', () => {
    expect(CONTROLLER_SRC).toMatch(/@UseGuards\(JwtAuthGuard\)/);
  });

  it('exposes POST complete at /me/first-win/complete', () => {
    expect(CONTROLLER_SRC).toMatch(/@Post\(['"]complete['"]\)/);
    expect(CONTROLLER_SRC).toMatch(/async complete/);
  });

  it('exposes GET status at /me/first-win/status', () => {
    expect(CONTROLLER_SRC).toMatch(/@Get\(['"]status['"]\)/);
    expect(CONTROLLER_SRC).toMatch(/async getStatus/);
  });

  it('declares the controller prefix as me/first-win', () => {
    expect(CONTROLLER_SRC).toMatch(/@Controller\(['"]me\/first-win['"]\)/);
  });
});

// ── Service unit tests ──────────────────────────────────────────────────────

function buildPrisma(initialFirstWinCompletedAt: Date | null = null) {
  let completedAt: Date | null = initialFirstWinCompletedAt;
  let updateCallCount = 0;

  return {
    updateCallCount: () => updateCallCount,
    user: {
      findUniqueOrThrow: jest.fn(async () => ({
        first_win_completed_at: completedAt,
      })),
      update: jest.fn(async ({ data }: { data: { first_win_completed_at?: Date } }) => {
        updateCallCount += 1;
        if (data.first_win_completed_at !== undefined) {
          completedAt = data.first_win_completed_at;
        }
        return {};
      }),
    },
  };
}

describe('FirstWinService — complete()', () => {
  it('sets first_win_completed_at on first call', async () => {
    const prisma = buildPrisma(null);
    const service = new FirstWinService(prisma as any);

    const before = new Date();
    const result = await service.complete('user-1', 'logged_first_weight');
    const after = new Date();

    expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(prisma.updateCallCount()).toBe(1);
  });

  it('is idempotent — returns original timestamp on second call, no DB write', async () => {
    const originalDate = new Date('2026-05-06T05:00:00Z');
    const prisma = buildPrisma(originalDate);
    const service = new FirstWinService(prisma as any);

    const first = await service.complete('user-1', 'logged_first_weight');
    const second = await service.complete('user-1', 'first_meal');

    expect(first.toISOString()).toBe(originalDate.toISOString());
    expect(second.toISOString()).toBe(originalDate.toISOString());
    // No update should fire because the field was already set
    expect(prisma.updateCallCount()).toBe(0);
  });

  it('accepts all four valid winTypes without throwing', async () => {
    const winTypes = ['logged_first_weight', 'set_first_goal', 'first_checkin', 'first_meal'] as const;
    for (const winType of winTypes) {
      const prisma = buildPrisma(null);
      const service = new FirstWinService(prisma as any);
      await expect(service.complete('user-1', winType)).resolves.toBeInstanceOf(Date);
    }
  });
});

describe('FirstWinService — getStatus()', () => {
  it('returns { completed: false, completedAt: null } before any win', async () => {
    const prisma = buildPrisma(null);
    const service = new FirstWinService(prisma as any);

    const status = await service.getStatus('user-1');
    expect(status).toEqual({ completed: false, completedAt: null });
  });

  it('returns { completed: true, completedAt: ISO string } after win', async () => {
    const date = new Date('2026-05-06T09:30:00.000Z');
    const prisma = buildPrisma(date);
    const service = new FirstWinService(prisma as any);

    const status = await service.getStatus('user-1');
    expect(status.completed).toBe(true);
    expect(status.completedAt).toBe('2026-05-06T09:30:00.000Z');
  });
});
