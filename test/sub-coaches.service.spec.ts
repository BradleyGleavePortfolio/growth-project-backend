// Phase 8 — SubCoachesService coverage.
//
// 1. list — bulk lookup with tier + assigned counts.
// 2. detail — head coach reads; sub-coach self-reads OK; others 403.
// 3. invite — duplicate outstanding invite rejected as Conflict.
// 4. invite — self-invite rejected; existing sub-coach rejected.
// 5. revoke — reassigns clients + writes audit events + archives.
// 6. reassignClient — cross-team rejected (403); same-team OK + audit.

import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SubCoachesService } from '../src/sub-coaches/sub-coaches.service';

const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
  process.env.PUBLIC_INVITE_BASE_URL = 'https://test.example.com/join';
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

interface MockPrisma {
  teamSubCoachAssignment: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  teamAuditEvent: {
    create: jest.Mock;
    createMany: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    groupBy: jest.Mock;
  };
  coachSubscription: {
    findMany: jest.Mock;
  };
  subCoachInvite: {
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  loggedFoodEntry: { findMany: jest.Mock };
  checkIn: { findMany: jest.Mock };
  coachMessage: { findMany: jest.Mock };
  clientWorkoutAssignment: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  const base: MockPrisma = {
    teamSubCoachAssignment: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    teamAuditEvent: {
      create: jest.fn(async () => ({ id: 'evt-1' })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(async () => ({})),
      groupBy: jest.fn(async () => []),
    },
    coachSubscription: {
      findMany: jest.fn(async () => []),
    },
    subCoachInvite: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv-1',
        ...data,
      })),
    },
    loggedFoodEntry: { findMany: jest.fn(async () => []) },
    checkIn: { findMany: jest.fn(async () => []) },
    coachMessage: { findMany: jest.fn(async () => []) },
    clientWorkoutAssignment: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(base as unknown),
    ),
    ...overrides,
  };
  return base;
}

function buildTeam() {
  return {
    refreshCounters: jest.fn(async () => undefined),
  };
}

describe('SubCoachesService.list', () => {
  it('returns empty array when caller has no sub-coaches', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.list('head-1');
    expect(out).toEqual([]);
  });

  it('hydrates capacity + tier-derived max per sub-coach', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        ...buildPrisma().teamSubCoachAssignment,
        findMany: jest.fn(async () => [
          { sub_coach_id: 'sub-1', archived_at: null, created_at: new Date() },
        ]),
      },
      user: {
        ...buildPrisma().user,
        findMany: jest.fn(async () => [
          {
            id: 'sub-1',
            name: 'Sub',
            email: 's@example.com',
            created_at: new Date(),
            coach_profile: { plan_tier: 'pro', business_name: 'B' },
          },
        ]),
        groupBy: jest.fn(async () => [{ coach_id: 'sub-1', _count: { _all: 12 } }]),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.list('head-1');
    expect(out).toHaveLength(1);
    expect(out[0].capacity.assignedClients).toBe(12);
    expect(out[0].capacity.maxClients).toBeGreaterThan(0);
    expect(out[0].capacity.hasCapacity).toBe(true);
  });
});

describe('SubCoachesService.detail', () => {
  it('forbids access for a coach who is not the head and not the sub-coach', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.detail('outsider', 'coach', 'sub-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a sub-coach to read their own detail', async () => {
    const prisma = buildPrisma({
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({
          id: 'sub-1',
          name: 'Sub',
          email: 's@example.com',
          created_at: new Date(),
          coach_profile: { plan_tier: 'growth', business_name: null, bio: null },
        })),
        findMany: jest.fn(async () => []),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.detail('sub-1', 'coach', 'sub-1');
    expect(out.id).toBe('sub-1');
    expect(out.clients).toEqual([]);
  });
});

describe('SubCoachesService.invite', () => {
  it('rejects self-invite', async () => {
    const prisma = buildPrisma({
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({ id: 'head-1', role: 'coach' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.invite('head-1', { email: 'head@example.com' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when the user is already a non-archived sub-coach', async () => {
    const prisma = buildPrisma({
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({ id: 'sub-1', role: 'coach' })),
      },
      teamSubCoachAssignment: {
        ...buildPrisma().teamSubCoachAssignment,
        findFirst: jest.fn(async () => ({ id: 'asn-1' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.invite('head-1', { email: 'sub@example.com' }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects when an outstanding invite already exists for the email', async () => {
    const prisma = buildPrisma({
      subCoachInvite: {
        ...buildPrisma().subCoachInvite,
        findFirst: jest.fn(async () => ({ id: 'inv-existing' })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.invite('head-1', { email: 'new@example.com' }),
    ).rejects.toThrow(ConflictException);
  });

  it('writes a SubCoachInvite + audit row on the happy path', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    const out = await svc.invite('head-1', {
      email: 'new@example.com',
      name: 'New',
      max_clients: 50,
    });
    expect(out.email).toBe('new@example.com');
    expect(out.inviteUrl).toMatch(/sub-coach\//);
    expect(out.expires_at).toMatch(/T/);
    expect(prisma.subCoachInvite.create).toHaveBeenCalledTimes(1);
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
    // P1-2 regression: new invites must store a token_hash, not a plaintext token.
    const createCall = prisma.subCoachInvite.create.mock.calls[0][0];
    expect(createCall.data.token_hash).toBeDefined();
    expect(typeof createCall.data.token_hash).toBe('string');
    expect(createCall.data.token_hash.length).toBe(64); // SHA-256 hex = 64 chars
    expect(createCall.data.token).toBeNull(); // plaintext token must not be persisted
    // The raw token (returned in inviteUrl) must NOT match the stored hash.
    const rawToken = out.inviteUrl.split('/').pop()!;
    expect(rawToken).not.toBe(createCall.data.token_hash);
  });
});

describe('SubCoachesService.revoke', () => {
  it('404s when the sub-coach is not on the calling head coach\'s team', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.revoke('head-1', 'sub-1', {}),
    ).rejects.toThrow(NotFoundException);
  });

  it('reassigns all active clients back to the head coach and writes events', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        ...buildPrisma().teamSubCoachAssignment,
        findFirst: jest.fn(async () => ({
          id: 'asn-1',
          head_coach_id: 'head-1',
          sub_coach_id: 'sub-1',
          archived_at: null,
        })),
      },
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({ id: 'sub-1', name: 'Sub' })),
        findMany: jest.fn(async () => [{ id: 'client-1' }, { id: 'client-2' }]),
      },
    });
    const team = buildTeam();
    const svc = new SubCoachesService(prisma as never, team as never);
    const out = await svc.revoke('head-1', 'sub-1', { reason: 'audit' });
    expect(out).toEqual({ ok: true, reassignedClientCount: 2 });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['client-1', 'client-2'] } },
      data: { coach_id: 'head-1' },
    });
    // 2 client_reassigned written via createMany; 1 sub_coach_removed via create.
    expect(prisma.teamAuditEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.teamAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.teamSubCoachAssignment.update).toHaveBeenCalled();
    expect(team.refreshCounters).toHaveBeenCalledWith('head-1');
  });
});

describe('SubCoachesService.reassignClient', () => {
  it('rejects when target coach is not on the calling head coach\'s team', async () => {
    const prisma = buildPrisma();
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.reassignClient('head-1', 'outsider', { clientId: 'c-1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects when the client is currently coached by someone outside the team', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        ...buildPrisma().teamSubCoachAssignment,
        // Target is on team but client is not.
        findFirst: jest.fn(async () => ({ id: 'asn-1' })),
        findMany: jest.fn(async () => [{ sub_coach_id: 'sub-1' }]),
      },
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({
          id: 'c-1',
          role: 'student',
          coach_id: 'outsider-coach',
          name: 'Client',
        })),
      },
    });
    const svc = new SubCoachesService(prisma as never, buildTeam() as never);
    await expect(
      svc.reassignClient('head-1', 'sub-1', { clientId: 'c-1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('updates User.coach_id and writes an audit event on the happy path', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        ...buildPrisma().teamSubCoachAssignment,
        findFirst: jest.fn(async () => ({ id: 'asn-1' })),
        findMany: jest.fn(async () => [{ sub_coach_id: 'sub-1' }]),
      },
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => ({
          id: 'c-1',
          role: 'student',
          coach_id: 'head-1',
          name: 'Client',
        })),
      },
    });
    const team = buildTeam();
    const svc = new SubCoachesService(prisma as never, team as never);
    const out = await svc.reassignClient('head-1', 'sub-1', {
      clientId: 'c-1',
      reason: 'workload',
    });
    expect(out.previousCoachId).toBe('head-1');
    expect(out.newCoachId).toBe('sub-1');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { coach_id: 'sub-1' },
    });
    expect(prisma.teamAuditEvent.create).toHaveBeenCalled();
    expect(team.refreshCounters).toHaveBeenCalled();
  });
});
