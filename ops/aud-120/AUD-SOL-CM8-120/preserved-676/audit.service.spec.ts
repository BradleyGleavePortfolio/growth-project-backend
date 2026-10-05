import { AuditAction, AuditService } from '../src/audit/audit.service';

describe('AuditService', () => {
  function buildPrisma() {
    return {
      auditLog: {
        create: jest.fn(async ({ data }: any) => ({ id: 'a-1', ...data })),
        findMany: jest.fn(async () => []),
      },
    } as any;
  }

  it('writes a row with all populated fields', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);
    await svc.write({
      action: AuditAction.USER_ROLE_CHANGED,
      actorId: 'owner-1',
      actorRole: 'owner',
      actorEmail: 'o@o.test',
      targetUserId: 'target-1',
      targetType: 'user',
      targetId: 'target-1',
      tenantCoachId: 'target-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      metadata: { from: 'student', to: 'coach' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.action).toBe('user.role_changed');
    expect(data.actor_id).toBe('owner-1');
    expect(data.target_user_id).toBe('target-1');
    expect(data.metadata).toEqual({ from: 'student', to: 'coach' });
    expect(data.tenant_coach_id).toBe('target-1');
  });

  // Audit writes are best-effort — a DB failure must not propagate to the
  // caller (otherwise a transient outage in the audit table would 500
  // every privileged endpoint). The error must still be logged for ops.
  it('swallows DB errors instead of throwing', async () => {
    const prisma: any = buildPrisma();
    prisma.auditLog.create = jest
      .fn()
      .mockRejectedValue(new Error('connection refused'));
    const svc = new AuditService(prisma);
    await expect(
      svc.write({ action: 'test.event' }),
    ).resolves.toBeUndefined();
  });

  it('list applies action / target / tenant / before filters', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);
    const before = new Date('2026-04-20T00:00:00.000Z');
    await svc.list({
      action: AuditAction.USER_ROLE_CHANGED,
      targetUserId: 't-1',
      tenantCoachId: 'c-1',
      before,
      limit: 25,
    });
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.auditLog.findMany.mock.calls[0][0];
    expect(args.where.action).toBe('user.role_changed');
    expect(args.where.target_user_id).toBe('t-1');
    expect(args.where.tenant_coach_id).toBe('c-1');
    expect(args.where.created_at).toEqual({ lt: before });
    expect(args.take).toBe(25);
    expect(args.orderBy).toEqual({ created_at: 'desc' });
  });

  it('list clamps limit to [1, 200]', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);
    await svc.list({ limit: 999 });
    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(200);
    await svc.list({ limit: 0 });
    expect(prisma.auditLog.findMany.mock.calls[1][0].take).toBe(1);
  });
});
