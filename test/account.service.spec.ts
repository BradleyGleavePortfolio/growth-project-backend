import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountService,
  DELETION_GRACE_PERIOD_DAYS,
} from '../src/users/account.service';
import { AuditAction } from '../src/audit/audit.service';

// Builds a deeply-stubbed PrismaService that the AccountService can drive
// against. Each table is given the minimum surface AccountService touches
// and returns empty arrays / null by default — only the User row matters
// for most flows. Tests can mutate `state.user` to simulate
// deletion_scheduled_at / deleted_at.
function buildPrismaMock(initialUser: any) {
  const state: { user: any; exports: any[] } = { user: initialUser, exports: [] };
  const noopFindMany = jest.fn(async () => []);
  const noopFindUnique = jest.fn(async () => null);
  return {
    state,
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === state.user?.id ? state.user : null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== state.user?.id) return null;
        Object.assign(state.user, data);
        return state.user;
      }),
    },
    userProfile: { findUnique: noopFindUnique },
    userPreferences: { findUnique: noopFindUnique },
    notificationPreferences: { findUnique: noopFindUnique },
    loggedFoodEntry: { findMany: noopFindMany },
    workoutSession: { findMany: noopFindMany },
    weightLog: { findMany: noopFindMany },
    checkIn: { findMany: noopFindMany },
    habit: { findMany: noopFindMany },
    lessonCompletion: { findMany: noopFindMany },
    waterLog: { findMany: noopFindMany },
    fastingWindow: { findMany: noopFindMany },
    communityWin: { findMany: noopFindMany },
    savedRecipe: { findMany: noopFindMany },
    listItem: { findMany: noopFindMany },
    coachMessage: { findMany: noopFindMany },
    coachNudge: { findMany: noopFindMany },
    dataExportRequest: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `exp-${state.exports.length + 1}`,
          requested_at: new Date(),
          fulfilled_at: null,
          status: 'pending',
          payload: null,
          error: null,
          ...data,
        };
        state.exports.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.exports.find((e) => e.id === where.id);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        state.exports.find((e) => e.id === where.id) ?? null,
      ),
    },
  };
}

function buildAuditMock() {
  return { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any;
}

describe('AccountService', () => {
  const baseUser = {
    id: 'u-1',
    email: 'a@a.test',
    name: 'A',
    role: 'student',
    coach_id: 'c-1',
    deletion_scheduled_at: null,
    deleted_at: null,
  };

  describe('requestDataExport', () => {
    it('persists a DataExportRequest, fulfills it inline, and writes audit entries', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser });
      const audit = buildAuditMock();
      const svc = new AccountService(prisma, audit);

      const res = await svc.requestDataExport('u-1', { ip: '1.2.3.4', userAgent: 'jest' });

      expect(res.status).toBe('ready');
      expect(prisma.dataExportRequest.create).toHaveBeenCalledTimes(1);
      // requested + fulfilled = 2 audit writes on the happy path
      expect(audit.write).toHaveBeenCalledTimes(2);
      expect(audit.write.mock.calls[0][0].action).toBe(
        AuditAction.USER_DATA_EXPORT_REQUESTED,
      );
      expect(audit.write.mock.calls[0][0].ip).toBe('1.2.3.4');
      expect(audit.write.mock.calls[1][0].action).toBe(
        AuditAction.USER_DATA_EXPORT_FULFILLED,
      );
    });

    it('refuses export for an already-deleted account', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser, deleted_at: new Date() });
      const svc = new AccountService(prisma, buildAuditMock());
      await expect(svc.requestDataExport('u-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFoundException for a missing user', async () => {
      const prisma: any = buildPrismaMock(null);
      const svc = new AccountService(prisma, buildAuditMock());
      await expect(svc.requestDataExport('u-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getDataExport', () => {
    it('refuses to return another user\'s export', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser });
      const svc = new AccountService(prisma, buildAuditMock());
      const created = await svc.requestDataExport('u-1');
      // Another user requesting the same id must get a 404.
      await expect(svc.getDataExport('u-2', created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('scheduleDeletion', () => {
    it('sets deletion_scheduled_at and writes a USER_ACCOUNT_DELETION_SCHEDULED audit', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser });
      const audit = buildAuditMock();
      const svc = new AccountService(prisma, audit);
      const res = await svc.scheduleDeletion('u-1', { ip: '5.6.7.8' });
      expect(res.scheduled).toBe(true);
      expect(res.grace_period_days).toBe(DELETION_GRACE_PERIOD_DAYS);
      expect(prisma.state.user.deletion_scheduled_at).toBeTruthy();
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write.mock.calls[0][0].action).toBe(
        AuditAction.USER_ACCOUNT_DELETION_SCHEDULED,
      );
      expect(audit.write.mock.calls[0][0].metadata).toEqual({
        grace_period_days: DELETION_GRACE_PERIOD_DAYS,
      });
    });

    it('is idempotent — second call within grace window does NOT extend deadline', async () => {
      const alreadyScheduled = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const prisma: any = buildPrismaMock({
        ...baseUser,
        deletion_scheduled_at: alreadyScheduled,
      });
      const audit = buildAuditMock();
      const svc = new AccountService(prisma, audit);
      const res = await svc.scheduleDeletion('u-1');
      expect(res.scheduled).toBe(true);
      // Returned scheduled_at must equal the prior timestamp (no extension).
      expect(new Date(res.scheduled_at!).toISOString()).toBe(
        alreadyScheduled.toISOString(),
      );
      // Idempotent path skips the user.update + audit.write.
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('refuses to schedule on an already-deleted account', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser, deleted_at: new Date() });
      const svc = new AccountService(prisma, buildAuditMock());
      await expect(svc.scheduleDeletion('u-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('cancelDeletion', () => {
    it('clears deletion_scheduled_at and writes a USER_ACCOUNT_DELETION_CANCELED audit', async () => {
      const prisma: any = buildPrismaMock({
        ...baseUser,
        deletion_scheduled_at: new Date(),
      });
      const audit = buildAuditMock();
      const svc = new AccountService(prisma, audit);
      const res = await svc.cancelDeletion('u-1');
      expect(res.scheduled).toBe(false);
      expect(prisma.state.user.deletion_scheduled_at).toBeNull();
      expect(audit.write.mock.calls[0][0].action).toBe(
        AuditAction.USER_ACCOUNT_DELETION_CANCELED,
      );
    });

    it('400s when nothing is scheduled', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser });
      const svc = new AccountService(prisma, buildAuditMock());
      await expect(svc.cancelDeletion('u-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('tenant isolation', () => {
    it('export getter scopes by user_id', async () => {
      const prisma: any = buildPrismaMock({ ...baseUser });
      const svc = new AccountService(prisma, buildAuditMock());
      const created = await svc.requestDataExport('u-1');
      const owned = await svc.getDataExport('u-1', created.id);
      expect(owned.id).toBe(created.id);
      // Same id, different caller — 404, not "not yours".
      await expect(svc.getDataExport('u-other', created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
