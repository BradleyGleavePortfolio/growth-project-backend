// Phase 8 — invite-code redeemer drilldown tests.
//
// 1. 404 when the InviteCode does not exist.
// 2. 403 when the InviteCode belongs to a different coach (IDOR guard).
// 3. Empty array when used_count === 0 (no fake data).
// 4. Happy path: returns user_id/name/email/redeemed_at/last_active_at
//    for users whose created_at falls in the invite window, capped at used_count.

import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';

interface MockPrisma {
  inviteCode: { findUnique: jest.Mock };
  user: { findMany: jest.Mock };
  workoutSession: { findMany: jest.Mock };
  loggedFoodEntry: { findMany: jest.Mock };
  checkIn: { findMany: jest.Mock };
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  return {
    inviteCode: { findUnique: jest.fn(async () => null) },
    user: { findMany: jest.fn(async () => []) },
    workoutSession: { findMany: jest.fn(async () => []) },
    loggedFoodEntry: { findMany: jest.fn(async () => []) },
    checkIn: { findMany: jest.fn(async () => []) },
    ...overrides,
  };
}

function buildAnalytics() {
  return { capture: jest.fn() };
}

describe('InviteCodesService.listRedeemersForCoach', () => {
  it('throws NotFoundException for an unknown invite code id', async () => {
    const prisma = buildPrisma();
    const svc = new InviteCodesService(prisma as never, buildAnalytics() as never);
    await expect(
      svc.listRedeemersForCoach('coach-1', 'ghost-id'),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the invite belongs to another coach', async () => {
    const prisma = buildPrisma({
      inviteCode: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          coach_id: 'other-coach',
          created_at: new Date(),
          expires_at: null,
          used_count: 1,
        })),
      },
    });
    const svc = new InviteCodesService(prisma as never, buildAnalytics() as never);
    await expect(
      svc.listRedeemersForCoach('coach-1', 'inv-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns [] when used_count is zero (no fake redeemers)', async () => {
    const prisma = buildPrisma({
      inviteCode: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          coach_id: 'coach-1',
          created_at: new Date(),
          expires_at: null,
          used_count: 0,
        })),
      },
    });
    const svc = new InviteCodesService(prisma as never, buildAnalytics() as never);
    const out = await svc.listRedeemersForCoach('coach-1', 'inv-1');
    expect(out).toEqual([]);
  });

  it('returns redeemer rows capped at used_count, sorted by created_at ASC', async () => {
    const createdAt = new Date('2026-04-01T00:00:00Z');
    const expiresAt = new Date('2026-04-30T00:00:00Z');
    const prisma = buildPrisma({
      inviteCode: {
        findUnique: jest.fn(async () => ({
          id: 'inv-1',
          coach_id: 'coach-1',
          created_at: createdAt,
          expires_at: expiresAt,
          used_count: 2,
        })),
      },
      user: {
        findMany: jest.fn(async () => [
          {
            id: 'u-1',
            name: 'Alice',
            email: 'a@example.com',
            created_at: new Date('2026-04-05T00:00:00Z'),
          },
          {
            id: 'u-2',
            name: 'Bob',
            email: 'b@example.com',
            created_at: new Date('2026-04-10T00:00:00Z'),
          },
        ]),
      },
      workoutSession: {
        findMany: jest.fn(async () => [
          { user_id: 'u-1', created_at: new Date('2026-04-09T00:00:00Z') },
        ]),
      },
    });
    const svc = new InviteCodesService(prisma as never, buildAnalytics() as never);
    const out = await svc.listRedeemersForCoach('coach-1', 'inv-1');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ user_id: 'u-1', name: 'Alice' });
    expect(out[0].last_active_at).toBe('2026-04-09T00:00:00.000Z');
    expect(out[1]).toMatchObject({ user_id: 'u-2', name: 'Bob' });
    expect(out[1].last_active_at).toBeNull();
  });
});
