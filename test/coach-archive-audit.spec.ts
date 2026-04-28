import { CoachService } from '../src/coach/coach.service';
import { AuditAction } from '../src/audit/audit.service';

// Pins coach archive/unarchive auditing. The admin console + sales-ready
// posture both require an immutable trail of who archived a client and
// when, scoped by tenant_coach_id so an OWNER can scope an audit-log
// query to one coach's tenant.

function buildPrisma(seedClient: any) {
  const state: { client: any } = { client: seedClient };
  return {
    state,
    user: {
      findFirst: jest.fn(async () => state.client),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== state.client?.id) return null;
        Object.assign(state.client, data);
        return state.client;
      }),
    },
  };
}
function buildAudit() {
  return { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any;
}

describe('CoachService.archiveClient / unarchiveClient (audit trail)', () => {
  const baseClient = {
    id: 'client-1',
    coach_id: 'coach-A',
    archived_at: null,
  };

  it('writes COACH_CLIENT_ARCHIVED with tenant + actor scoping on first archive', async () => {
    const prisma: any = buildPrisma({ ...baseClient });
    const audit = buildAudit();
    const svc = new CoachService(prisma, audit);

    const updated = await svc.archiveClient('coach-A', 'client-1', 'coach', {
      ip: '1.2.3.4',
      userAgent: 'jest',
    });

    expect(updated.archived_at).toBeTruthy();
    expect(audit.write).toHaveBeenCalledTimes(1);
    const row = audit.write.mock.calls[0][0];
    expect(row.action).toBe(AuditAction.COACH_CLIENT_ARCHIVED);
    expect(row.actorId).toBe('coach-A');
    expect(row.actorRole).toBe('coach');
    expect(row.targetUserId).toBe('client-1');
    expect(row.tenantCoachId).toBe('coach-A');
    expect(row.ip).toBe('1.2.3.4');
  });

  it('archive is idempotent — second call on already-archived row writes no audit', async () => {
    const prisma: any = buildPrisma({
      ...baseClient,
      archived_at: new Date('2026-01-01T00:00:00Z'),
    });
    const audit = buildAudit();
    const svc = new CoachService(prisma, audit);

    await svc.archiveClient('coach-A', 'client-1', 'coach');
    expect(audit.write).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('writes COACH_CLIENT_UNARCHIVED on unarchive', async () => {
    const prisma: any = buildPrisma({
      ...baseClient,
      archived_at: new Date('2026-01-01T00:00:00Z'),
    });
    const audit = buildAudit();
    const svc = new CoachService(prisma, audit);

    await svc.unarchiveClient('coach-A', 'client-1', 'coach');
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write.mock.calls[0][0].action).toBe(
      AuditAction.COACH_CLIENT_UNARCHIVED,
    );
  });

  it('unarchive is idempotent — second call on active row writes no audit', async () => {
    const prisma: any = buildPrisma({ ...baseClient });
    const audit = buildAudit();
    const svc = new CoachService(prisma, audit);

    await svc.unarchiveClient('coach-A', 'client-1', 'coach');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('OWNER acting cross-tenant still resolves tenant_coach_id from the client row', async () => {
    const prisma: any = buildPrisma({
      ...baseClient,
      coach_id: 'coach-B',
    });
    const audit = buildAudit();
    const svc = new CoachService(prisma, audit);

    await svc.archiveClient('owner-1', 'client-1', 'owner');
    const row = audit.write.mock.calls[0][0];
    expect(row.actorId).toBe('owner-1');
    expect(row.actorRole).toBe('owner');
    // Tenant scoping must follow the client's actual coach, NOT the owner.
    expect(row.tenantCoachId).toBe('coach-B');
  });
});
