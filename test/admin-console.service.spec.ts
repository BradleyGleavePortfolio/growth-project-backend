import { NotFoundException } from '@nestjs/common';
import { AdminConsoleService } from '../src/admin/console/admin-console.service';
import {
  UnifiedClientResponse,
  UnifiedCoachResponse,
} from '../src/admin/federation/federation.service';
import { AccountEntitlements } from '../src/admin/entitlements/entitlements.types';

function emptyEntitlements(): AccountEntitlements {
  return {
    active_products: [],
    bundle: 'none',
    overall: 'inactive',
    products: {
      fitness: { product: 'fitness', status: 'inactive', reason: 'fitness_no_record' },
      finance: { product: 'finance', status: 'inactive', reason: 'finance_no_record' },
    },
    account_suspended: false,
  };
}

class FederationStub {
  unifiedClient = jest.fn<Promise<UnifiedClientResponse>, [string]>();
  unifiedCoach = jest.fn<Promise<UnifiedCoachResponse>, [string]>();
}

function buildPrismaStub(rows: Array<{ id: string; email: string; role: string }>) {
  return {
    user: {
      findUnique: jest.fn(async ({ where, select: _select }: any) => {
        const row = rows.find((r) => r.id === where.id);
        return row ?? null;
      }),
    },
  } as any;
}

function emptyClientResponse(email: string): UnifiedClientResponse {
  return {
    email,
    fitness: null,
    finance: { status: 'ok', data: null },
    products: {
      fitness: { active: false, reason: 'not_found' },
      finance: { active: false, reason: 'not_found' },
    },
    entitlements: emptyEntitlements(),
  };
}

function emptyCoachResponse(email: string): UnifiedCoachResponse {
  return {
    email,
    fitness: null,
    finance: { status: 'ok', data: null },
    products: {
      fitness: { active: false, reason: 'not_found' },
      finance: { active: false, reason: 'not_found' },
    },
    entitlements: emptyEntitlements(),
  };
}

describe('AdminConsoleService.getCoachOverview', () => {
  it('resolves coach by id, delegates to federation, and echoes user_id', async () => {
    const prisma = buildPrismaStub([
      { id: 'coach-1', email: 'Coach@example.test', role: 'coach' },
    ]);
    const fed = new FederationStub();
    fed.unifiedCoach.mockResolvedValueOnce(emptyCoachResponse('Coach@example.test'));

    const svc = new AdminConsoleService(prisma, fed as any);
    const out = await svc.getCoachOverview('coach-1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'coach-1' },
      select: { id: true, email: true, role: true },
    });
    expect(fed.unifiedCoach).toHaveBeenCalledWith('Coach@example.test');
    expect(out.user_id).toBe('coach-1');
    expect(out.email).toBe('Coach@example.test');
  });

  it('404s when the user does not exist', async () => {
    const prisma = buildPrismaStub([]);
    const fed = new FederationStub();
    const svc = new AdminConsoleService(prisma, fed as any);
    await expect(svc.getCoachOverview('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(fed.unifiedCoach).not.toHaveBeenCalled();
  });

  it('404s when the user exists but is not a coach', async () => {
    const prisma = buildPrismaStub([
      { id: 'student-1', email: 'student@example.test', role: 'student' },
    ]);
    const fed = new FederationStub();
    const svc = new AdminConsoleService(prisma, fed as any);
    await expect(svc.getCoachOverview('student-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(fed.unifiedCoach).not.toHaveBeenCalled();
  });
});

describe('AdminConsoleService.getClientUnified', () => {
  it('resolves any user role by id (clients can be student or coach)', async () => {
    const prisma = buildPrismaStub([
      { id: 'user-1', email: 'jay@example.test', role: 'student' },
    ]);
    const fed = new FederationStub();
    fed.unifiedClient.mockResolvedValueOnce(emptyClientResponse('jay@example.test'));

    const svc = new AdminConsoleService(prisma, fed as any);
    const out = await svc.getClientUnified('user-1');

    expect(fed.unifiedClient).toHaveBeenCalledWith('jay@example.test');
    expect(out.user_id).toBe('user-1');
  });

  it('404s when the user does not exist', async () => {
    const prisma = buildPrismaStub([]);
    const fed = new FederationStub();
    const svc = new AdminConsoleService(prisma, fed as any);
    await expect(svc.getClientUnified('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(fed.unifiedClient).not.toHaveBeenCalled();
  });

  it('getClientEntitlements returns just the entitlement block keyed by user_id', async () => {
    const prisma = buildPrismaStub([
      { id: 'user-1', email: 'jay@example.test', role: 'student' },
    ]);
    const fed = new FederationStub();
    const ents = emptyEntitlements();
    ents.bundle = 'fitness_only';
    ents.overall = 'active';
    ents.active_products = ['fitness'];
    fed.unifiedClient.mockResolvedValueOnce({
      ...emptyClientResponse('jay@example.test'),
      entitlements: ents,
    });

    const svc = new AdminConsoleService(prisma, fed as any);
    const out = await svc.getClientEntitlements('user-1');
    expect(out.user_id).toBe('user-1');
    expect(out.email).toBe('jay@example.test');
    expect(out.entitlements.bundle).toBe('fitness_only');
    expect(out.entitlements.overall).toBe('active');
  });

  it('getCoachEntitlements 404s for non-coach roles', async () => {
    const prisma = buildPrismaStub([
      { id: 'student-1', email: 's@example.test', role: 'student' },
    ]);
    const fed = new FederationStub();
    const svc = new AdminConsoleService(prisma, fed as any);
    await expect(svc.getCoachEntitlements('student-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes through degraded finance status from federation', async () => {
    const prisma = buildPrismaStub([
      { id: 'user-1', email: 'jay@example.test', role: 'student' },
    ]);
    const fed = new FederationStub();
    fed.unifiedClient.mockResolvedValueOnce({
      email: 'jay@example.test',
      fitness: null,
      finance: { status: 'timeout', detail: 'timed out after 2500ms', data: null },
      products: {
        fitness: { active: false, reason: 'not_found' },
        finance: { active: false, reason: 'timeout' },
      },
      entitlements: emptyEntitlements(),
    });
    const svc = new AdminConsoleService(prisma, fed as any);
    const out = await svc.getClientUnified('user-1');
    expect(out.finance.status).toBe('timeout');
    expect(out.finance.data).toBeNull();
  });
});
