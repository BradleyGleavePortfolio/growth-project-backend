import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { SchedulingService } from '../src/scheduling/scheduling.service';

// In-memory prisma fake — just the surfaces SchedulingService touches
// in the override CRUD methods. Mirrors the pattern used by
// scheduling.service.spec.ts.

function buildPrismaFake() {
  const overrides: any[] = [];
  let _id = 0;
  return {
    _state: { overrides },
    coachAvailabilityOverride: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        overrides.find((o) => o.id === id) ?? null,
      ),
      findMany: jest.fn(async ({ where, orderBy: _orderBy }: any) =>
        overrides
          .filter((o) => o.coach_id === where.coach_id)
          .filter((o) =>
            where.date?.gte ? o.date >= where.date.gte : true,
          )
          .filter((o) =>
            where.date?.lte ? o.date <= where.date.lte : true,
          ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `ov-${++_id}`, ...data };
        overrides.push(row);
        return row;
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const i = overrides.findIndex((o) => o.id === id);
        overrides[i] = { ...overrides[i], ...data };
        return overrides[i];
      }),
      delete: jest.fn(async ({ where: { id } }: any) => {
        const i = overrides.findIndex((o) => o.id === id);
        const row = overrides[i];
        overrides.splice(i, 1);
        return row;
      }),
    },
    // Stubs that are never hit in these specs but the service
    // constructor pulls.
    user: { findUnique: jest.fn() },
    coachAvailability: { findMany: jest.fn() },
    coachingSession: { findMany: jest.fn() },
  };
}

function buildService() {
  const prisma = buildPrismaFake();
  const audit: Partial<AuditService> = { write: jest.fn() };
  const svc = new SchedulingService(
    prisma as any,
    audit as AuditService,
    {} as any,
  );
  return { svc, prisma };
}

const coachActor = {
  id: 'coach-1',
  role: 'coach' as const,
  email: null,
  coach_id: null,
};
const otherCoachActor = {
  id: 'coach-2',
  role: 'coach' as const,
  email: null,
  coach_id: null,
};
const studentActor = {
  id: 'student-1',
  role: 'student' as const,
  email: null,
  coach_id: 'coach-1',
};
const ownerActor = {
  id: 'owner-1',
  role: 'owner' as const,
  email: null,
  coach_id: null,
};

describe('SchedulingService — availability overrides CRUD', () => {
  it('create + list (holiday, full day)', async () => {
    const { svc } = buildService();
    const created = await svc.createAvailabilityOverride(coachActor, {
      date: '2026-06-04',
      kind: 'holiday',
    });
    expect(created.kind).toBe('holiday');
    expect(created.start_minute).toBeNull();
    expect(created.end_minute).toBeNull();
    const list = await svc.listMyAvailabilityOverrides(coachActor, {});
    expect(list).toHaveLength(1);
  });

  it('create EXTRA window', async () => {
    const { svc } = buildService();
    const row = await svc.createAvailabilityOverride(coachActor, {
      date: '2026-06-05',
      kind: 'extra',
      start_time: '14:00',
      end_time: '16:30',
      note: 'one-off afternoon block',
    });
    expect(row.start_minute).toBe(14 * 60);
    expect(row.end_minute).toBe(16 * 60 + 30);
    expect(row.note).toBe('one-off afternoon block');
  });

  it('rejects HOLIDAY with start_time (400)', async () => {
    const { svc } = buildService();
    await expect(
      svc.createAvailabilityOverride(coachActor, {
        date: '2026-06-04',
        kind: 'holiday',
        start_time: '09:00',
        end_time: '10:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects BLOCK without start_time/end_time (400)', async () => {
    const { svc } = buildService();
    await expect(
      svc.createAvailabilityOverride(coachActor, {
        date: '2026-06-04',
        kind: 'block',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects EXTRA where end_time <= start_time (400)', async () => {
    const { svc } = buildService();
    await expect(
      svc.createAvailabilityOverride(coachActor, {
        date: '2026-06-04',
        kind: 'extra',
        start_time: '10:00',
        end_time: '09:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects creates by a student (403)', async () => {
    const { svc } = buildService();
    await expect(
      svc.createAvailabilityOverride(studentActor as any, {
        date: '2026-06-04',
        kind: 'holiday',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('non-owner cannot update someone else\'s override (403)', async () => {
    const { svc } = buildService();
    const row = await svc.createAvailabilityOverride(coachActor, {
      date: '2026-06-04',
      kind: 'holiday',
    });
    await expect(
      svc.updateAvailabilityOverride(otherCoachActor, row.id, { note: 'mine now' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('owner can update any coach\'s override', async () => {
    const { svc } = buildService();
    const row = await svc.createAvailabilityOverride(coachActor, {
      date: '2026-06-04',
      kind: 'holiday',
    });
    const upd = await svc.updateAvailabilityOverride(ownerActor, row.id, {
      note: 'admin updated',
    });
    expect(upd.note).toBe('admin updated');
  });

  it('delete by non-owner is 403; owner OK', async () => {
    const { svc } = buildService();
    const row = await svc.createAvailabilityOverride(coachActor, {
      date: '2026-06-04',
      kind: 'holiday',
    });
    await expect(
      svc.deleteAvailabilityOverride(otherCoachActor, row.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const r = await svc.deleteAvailabilityOverride(coachActor, row.id);
    expect(r.ok).toBe(true);
  });

  it('update/delete on missing id is 404', async () => {
    const { svc } = buildService();
    await expect(
      svc.updateAvailabilityOverride(coachActor, 'missing', { note: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.deleteAvailabilityOverride(coachActor, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
