// Phase 8 — TeamService coverage.
//
//   1. getProfile throws 404 with the typed `team_profile_not_configured`
//      kind when no row exists (mobile collapses this to a CTA empty state).
//   2. getProfile returns the row + refreshes denormalized counters.
//   3. upsertProfile generates a unique team_code on first create and
//      preserves it on subsequent updates.
//   4. upsertProfile rejects an empty business_name with 400.
//   5. listMembers returns head + sub-coaches with per-coach assigned counts.

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TeamService } from '../src/team/team.service';

interface MockPrisma {
  teamProfile: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
  teamSubCoachAssignment: {
    findMany: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
  connectAccount: {
    findUnique: jest.Mock;
  };
  coachSubscription: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  const base: MockPrisma = {
    teamProfile: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: 'tp-1',
        ...create,
        created_at: new Date(),
        updated_at: new Date(),
      })),
      update: jest.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => ({
        id: where.id,
        ...data,
      })),
    },
    teamSubCoachAssignment: {
      findMany: jest.fn(async () => []),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: 'head-1',
        name: 'Head',
        email: 'head@example.com',
        created_at: new Date(),
      })),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
    },
    connectAccount: {
      findUnique: jest.fn(async () => null),
    },
    coachSubscription: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    ...overrides,
  };
  return base;
}

describe('TeamService.getProfile', () => {
  it('throws NotFoundException with typed kind when no profile exists', async () => {
    const prisma = buildPrisma();
    const svc = new TeamService(prisma as never, null as never);
    await expect(svc.getProfile('head-1')).rejects.toThrow(NotFoundException);
    try {
      await svc.getProfile('head-1');
    } catch (err) {
      expect((err as NotFoundException).getResponse()).toMatchObject({
        kind: 'team_profile_not_configured',
      });
    }
  });

  it('returns existing profile and refreshes counters when stale', async () => {
    const prisma = buildPrisma({
      teamProfile: {
        findUnique: jest.fn(async () => ({
          id: 'tp-1',
          head_coach_id: 'head-1',
          business_name: 'Acme Fitness',
          team_code: 'GP-TEAM-AAAA',
          client_capacity: 0,
          clients_assigned: 0,
          payouts_enabled: false,
          created_at: new Date(),
          updated_at: new Date(),
        })),
        upsert: jest.fn(),
        update: jest.fn(async () => ({})),
      },
      user: {
        ...buildPrisma().user,
        count: jest.fn(async () => 5),
      },
    });
    const svc = new TeamService(prisma as never, null as never);
    const view = await svc.getProfile('head-1');
    expect(view.business_name).toBe('Acme Fitness');
    expect(view.team_code).toBe('GP-TEAM-AAAA');
    expect(view.clients_assigned).toBe(5);
    // Counter refresh on stale read.
    expect(prisma.teamProfile.update).toHaveBeenCalled();
  });
});

describe('TeamService.upsertProfile', () => {
  it('rejects empty business_name with BadRequestException', async () => {
    const prisma = buildPrisma();
    const svc = new TeamService(prisma as never, null as never);
    await expect(
      svc.upsertProfile('head-1', { business_name: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('generates a unique team_code on first create', async () => {
    const prisma = buildPrisma();
    const svc = new TeamService(prisma as never, null as never);
    const result = await svc.upsertProfile('head-1', {
      business_name: 'Acme Fitness',
    });
    expect(result.business_name).toBe('Acme Fitness');
    expect(result.team_code).toMatch(/^GP-TEAM-[A-Z2-9]+$/);
    expect(prisma.teamProfile.upsert).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing team_code on update', async () => {
    const existing = {
      id: 'tp-1',
      head_coach_id: 'head-1',
      business_name: 'Old Name',
      team_code: 'GP-TEAM-KEEP',
      client_capacity: 0,
      clients_assigned: 0,
      payouts_enabled: false,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const prisma = buildPrisma({
      teamProfile: {
        findUnique: jest.fn(async () => existing),
        upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => ({
          ...existing,
          ...update,
        })),
        update: jest.fn(),
      },
    });
    const svc = new TeamService(prisma as never, null as never);
    const result = await svc.upsertProfile('head-1', {
      business_name: 'New Name',
    });
    expect(result.team_code).toBe('GP-TEAM-KEEP');
    expect(result.business_name).toBe('New Name');
  });
});

describe('TeamService.listMembers', () => {
  it('returns head coach + non-archived sub-coaches with assignment counts', async () => {
    const head = {
      id: 'head-1',
      name: 'Head',
      email: 'head@example.com',
      created_at: new Date(),
    };
    const prisma = buildPrisma({
      user: {
        findUnique: jest.fn(async () => head),
        findMany: jest.fn(async () => [
          {
            id: 'sub-1',
            name: 'Sub One',
            email: 'sub1@example.com',
            created_at: new Date(),
          },
          {
            id: 'sub-2',
            name: 'Sub Two',
            email: 'sub2@example.com',
            created_at: new Date(),
          },
        ]),
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => [
          { coach_id: 'head-1', _count: { _all: 3 } },
          { coach_id: 'sub-1', _count: { _all: 7 } },
          { coach_id: 'sub-2', _count: { _all: 0 } },
        ]),
      },
      teamSubCoachAssignment: {
        findMany: jest.fn(async () => [
          { id: 'asn-1', sub_coach_id: 'sub-1', archived_at: null, created_at: new Date() },
          { id: 'asn-2', sub_coach_id: 'sub-2', archived_at: null, created_at: new Date() },
        ]),
      },
    });
    const svc = new TeamService(prisma as never, null as never);
    const members = await svc.listMembers('head-1');
    expect(members).toHaveLength(3);
    expect(members[0].role).toBe('head_coach');
    expect(members[0].assigned_clients).toBe(3);
    expect(members[1].role).toBe('sub_coach');
    expect(members[1].id).toBe('sub-1');
    expect(members[1].assigned_clients).toBe(7);
    expect(members[2].id).toBe('sub-2');
    expect(members[2].assigned_clients).toBe(0);
  });

  it('returns just the head coach when there are no sub-coaches', async () => {
    const prisma = buildPrisma();
    const svc = new TeamService(prisma as never, null as never);
    const members = await svc.listMembers('head-1');
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('head_coach');
  });

  it('throws NotFoundException for unknown head coach', async () => {
    const prisma = buildPrisma({
      user: {
        ...buildPrisma().user,
        findUnique: jest.fn(async () => null),
      },
    });
    const svc = new TeamService(prisma as never, null as never);
    await expect(svc.listMembers('ghost')).rejects.toThrow(NotFoundException);
  });
});
