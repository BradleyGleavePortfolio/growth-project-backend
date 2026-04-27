import { AdminService } from '../src/admin/admin.service';
import { AuditAction } from '../src/audit/audit.service';

// Pins the audit-log wiring on AdminService.promoteUser. A role change is
// the canonical sensitive action — losing the audit trail here would be a
// silent compliance regression.
describe('AdminService.promoteUser → audit log', () => {
  function build() {
    const owner = {
      id: 'owner-1',
      email: 'o@o.test',
      name: 'Owner',
      role: 'owner',
      coach_id: null,
    };
    const target: any = {
      id: 'u-target',
      email: 'jay@coach.test',
      name: 'Jay',
      role: 'student',
      coach_id: null,
    };
    const profiles: any[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where, select }: any) => {
          if (where.id === target.id) return target;
          if (where.id === owner.id) {
            return select ? { email: owner.email, role: owner.role } : owner;
          }
          return null;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          if (where.id === target.id) {
            Object.assign(target, data);
            return target;
          }
          return null;
        }),
        findMany: jest.fn(async () => []),
      },
      coachProfile: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `cp-${profiles.length + 1}`, ...data };
          profiles.push(row);
          return row;
        }),
      },
    };
    const audit = { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any;
    return { admin: new AdminService(prisma, audit), prisma, target, profiles, audit };
  }

  it('writes USER_ROLE_CHANGED with from/to metadata + IP/UA context', async () => {
    const { admin, audit } = build();
    await admin.promoteUser('owner-1', 'u-target', 'coach', undefined, {
      ip: '5.5.5.5',
      userAgent: 'jest',
    });
    expect(audit.write).toHaveBeenCalledTimes(1);
    const call = audit.write.mock.calls[0][0];
    expect(call.action).toBe(AuditAction.USER_ROLE_CHANGED);
    expect(call.actorId).toBe('owner-1');
    expect(call.actorRole).toBe('owner');
    expect(call.actorEmail).toBe('o@o.test');
    expect(call.targetUserId).toBe('u-target');
    expect(call.tenantCoachId).toBe('u-target'); // role=coach -> the target IS the new tenant
    expect(call.ip).toBe('5.5.5.5');
    expect(call.userAgent).toBe('jest');
    expect(call.metadata).toEqual({ from: 'student', to: 'coach' });
  });

  it('does not write an audit row when the role is unchanged', async () => {
    const { admin, audit, target } = build();
    target.role = 'coach';
    await admin.promoteUser('owner-1', 'u-target', 'coach');
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('demoting yourself is rejected before any audit row is written', async () => {
    const { admin, audit, target } = build();
    target.id = 'owner-1'; // owner trying to demote self
    target.role = 'owner';
    await expect(
      admin.promoteUser('owner-1', 'owner-1', 'coach'),
    ).rejects.toThrow();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
