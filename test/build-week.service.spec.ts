import { ConflictException, NotFoundException } from '@nestjs/common';
import { BuildWeekService } from '../src/build-week/build-week.service';

// Pins the Phase 4 BuildWeekService contracts:
//   * enroll() is idempotent — a fresh active enrollment is returned
//     unchanged; a prior 'completed' or 'abandoned' enrollment is reset
//     in place and the AuditLog records the transition.
//   * completeDay(N) requires current_day === N. Day skipping throws
//     ConflictException; days outside 1..7 throw BadRequest.
//   * Day-7 completion sets status='completed' and emits the
//     `finance_milestone` PTM signal exactly once.

interface FakeEnrollment {
  id: string;
  user_id: string;
  started_at: Date;
  current_day: number;
  status: string;
  completed_at: Date | null;
  completions: FakeCompletion[];
}

interface FakeCompletion {
  id: string;
  enrollment_id: string;
  day_number: number;
  completed_at: Date;
  responses: Record<string, unknown>;
  artifact_text: string | null;
}

function buildPrisma() {
  const enrollments = new Map<string, FakeEnrollment>();
  const completions: FakeCompletion[] = [];

  const prisma: any = {
    buildWeekEnrollment: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const row = enrollments.get(where.user_id) ?? null;
        if (!row) return null;
        if (include?.completions) {
          return { ...row, completions: completions.filter((c) => c.enrollment_id === row.id) };
        }
        return row;
      }),
      create: jest.fn(async ({ data, include: _include }: any) => {
        const row: FakeEnrollment = {
          id: `enr-${enrollments.size + 1}`,
          user_id: data.user_id,
          started_at: new Date(),
          current_day: data.current_day ?? 1,
          status: data.status ?? 'active',
          completed_at: null,
          completions: [],
        };
        enrollments.set(row.user_id, row);
        return { ...row, completions: [] };
      }),
      update: jest.fn(async ({ where, data, include: _include }: any) => {
        const existing = [...enrollments.values()].find((e) => e.id === where.id);
        if (!existing) throw new Error('not found');
        Object.assign(existing, data);
        return {
          ...existing,
          completions: completions.filter((c) => c.enrollment_id === existing.id),
        };
      }),
      findMany: jest.fn(async () => [...enrollments.values()]),
    },
    buildWeekDayCompletion: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const idx = completions.findIndex(
          (c) =>
            c.enrollment_id === where.BuildWeekDayCompletion_enrollment_day_key.enrollment_id &&
            c.day_number === where.BuildWeekDayCompletion_enrollment_day_key.day_number,
        );
        if (idx >= 0) {
          completions[idx] = { ...completions[idx], ...update };
          return completions[idx];
        }
        const row: FakeCompletion = {
          id: `c-${completions.length + 1}`,
          enrollment_id: create.enrollment_id,
          day_number: create.day_number,
          completed_at: new Date(),
          responses: create.responses,
          artifact_text: create.artifact_text ?? null,
        };
        completions.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = completions.length - 1; i >= 0; i--) {
          if (completions[i].enrollment_id === where.enrollment_id) completions.splice(i, 1);
        }
        return { count: 0 };
      }),
      groupBy: jest.fn(async ({ by: _by }: any) => {
        const counts = new Map<number, number>();
        for (const c of completions) counts.set(c.day_number, (counts.get(c.day_number) ?? 0) + 1);
        return [...counts.entries()].map(([day, n]) => ({
          day_number: day,
          _count: { _all: n },
        }));
      }),
    },
    buildWeekDay: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    $transaction: jest.fn(async (arg: any): Promise<any> => {
      if (typeof arg === 'function') return arg(prisma);
      return Promise.all(arg);
    }),
  };
  return { prisma, enrollments, completions };
}

function buildSvc() {
  const fixtures = buildPrisma();
  const audit = { write: jest.fn(async () => {}) } as any;
  const ptm = { emit: jest.fn(), recordSignal: jest.fn(async () => {}) } as any;
  const svc = new BuildWeekService(fixtures.prisma as any, audit, ptm);
  return { svc, audit, ptm, fixtures };
}

describe('BuildWeekService', () => {
  describe('enroll()', () => {
    it('creates a fresh enrollment with current_day=1 and status=active', async () => {
      const { svc, audit } = buildSvc();
      const dto = await svc.enroll('user-1');
      expect(dto.current_day).toBe(1);
      expect(dto.status).toBe('active');
      expect(dto.completions).toEqual([]);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'build_week.enrolled' }),
      );
    });

    it('returns the existing active enrollment unchanged (idempotent)', async () => {
      const { svc, audit } = buildSvc();
      const a = await svc.enroll('user-1');
      const b = await svc.enroll('user-1');
      expect(b.id).toBe(a.id);
      // Audit fires only on the first enroll, not on the idempotent re-call.
      expect(audit.write).toHaveBeenCalledTimes(1);
    });

    it('resets a prior completed enrollment in place on re-enroll', async () => {
      const { svc, fixtures } = buildSvc();
      await svc.enroll('user-1');
      const enrollment = fixtures.enrollments.get('user-1')!;
      enrollment.status = 'completed';
      enrollment.current_day = 7;
      enrollment.completed_at = new Date('2026-05-01');
      fixtures.completions.push({
        id: 'c-old',
        enrollment_id: enrollment.id,
        day_number: 1,
        completed_at: new Date(),
        responses: {},
        artifact_text: null,
      });
      const reset = await svc.enroll('user-1');
      expect(reset.status).toBe('active');
      expect(reset.current_day).toBe(1);
      expect(reset.completed_at).toBeNull();
      expect(reset.completions).toEqual([]);
    });
  });

  describe('completeDay()', () => {
    it('throws ConflictException when day !== enrollment.current_day', async () => {
      const { svc } = buildSvc();
      await svc.enroll('user-1');
      await expect(
        svc.completeDay('user-1', 2, { responses: {} }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException when the user has no enrollment', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.completeDay('ghost', 1, { responses: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('advances current_day after a successful completion', async () => {
      const { svc } = buildSvc();
      await svc.enroll('user-1');
      const after1 = await svc.completeDay('user-1', 1, { responses: { q1: 'a' } });
      expect(after1.current_day).toBe(2);
      expect(after1.status).toBe('active');
      expect(after1.completions).toHaveLength(1);
    });

    it('day 7 completion sets status=completed and emits the finance_milestone PTM signal', async () => {
      const { svc, ptm } = buildSvc();
      await svc.enroll('user-1');
      for (let d = 1; d <= 6; d++) {
        await svc.completeDay('user-1', d, { responses: {} });
      }
      expect(ptm.emit).not.toHaveBeenCalled();
      const finished = await svc.completeDay('user-1', 7, {
        responses: { income: 'done', body: 'done', env: 'done' },
        artifact_text: 'video uploaded',
      });
      expect(finished.status).toBe('completed');
      expect(finished.completed_at).toBeTruthy();
      expect(ptm.emit).toHaveBeenCalledTimes(1);
      expect(ptm.emit).toHaveBeenCalledWith(
        'user-1',
        'finance_milestone',
        1,
        expect.objectContaining({
          source: 'build_week',
          day_number: 7,
          total_days: 7,
        }),
      );
    });

    it('rejects an out-of-range day_number', async () => {
      const { svc } = buildSvc();
      await svc.enroll('user-1');
      await expect(svc.completeDay('user-1', 0, { responses: {} })).rejects.toBeTruthy();
      await expect(svc.completeDay('user-1', 8, { responses: {} })).rejects.toBeTruthy();
    });
  });

  describe('funnel()', () => {
    it('returns expected drop-off counts on a synthetic enrollment set', async () => {
      const { svc, fixtures } = buildSvc();
      // 3 users get to day 3, 2 also clear day 4, 1 finishes day 7.
      // expected reached: d1=3, d2=3, d3=3, d4=2, d5=1, d6=1, d7=1.
      // dropped: d1=0, d2=0, d3=1, d4=1, d5=0, d6=0, d7=0 (one completed).
      for (const u of ['u1', 'u2', 'u3']) {
        await svc.enroll(u);
      }
      const u1 = fixtures.enrollments.get('u1')!;
      const u2 = fixtures.enrollments.get('u2')!;
      const u3 = fixtures.enrollments.get('u3')!;
      const push = (e: FakeEnrollment, day: number) =>
        fixtures.completions.push({
          id: `c-${e.id}-${day}`,
          enrollment_id: e.id,
          day_number: day,
          completed_at: new Date(),
          responses: {},
          artifact_text: null,
        });
      [1, 2, 3].forEach((d) => push(u1, d));
      [1, 2, 3, 4].forEach((d) => push(u2, d));
      [1, 2, 3, 4, 5, 6, 7].forEach((d) => push(u3, d));
      u3.status = 'completed';
      u3.completed_at = new Date();

      const f = await svc.funnel();
      expect(f.total_enrolled).toBe(3);
      expect(f.total_completed).toBe(1);
      expect(f.completion_rate).toBeCloseTo(1 / 3, 5);
      const byDay = Object.fromEntries(f.dropoff_per_day.map((d) => [d.day_number, d]));
      expect(byDay[1].reached).toBe(3);
      expect(byDay[3].reached).toBe(3);
      expect(byDay[3].dropped).toBe(1);
      expect(byDay[4].reached).toBe(2);
      expect(byDay[4].dropped).toBe(1);
      expect(byDay[7].reached).toBe(1);
      expect(byDay[7].dropped).toBe(0);
    });
  });
});
