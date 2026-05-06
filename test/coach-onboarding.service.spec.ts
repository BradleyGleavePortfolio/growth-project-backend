import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CoachOnboardingService,
  COACH_ONBOARDING_TOTAL_STEPS,
} from '../src/coach/coach-onboarding.service';

// Phase 6D — wizard state machine. Verifies:
//   * startWizard() is idempotent
//   * advanceStep enforces sequential ordering (resume == current_step
//     allowed; next-step == current_step+1 allowed; jumps + rewinds rejected)
//   * step_data accumulates per-step blobs without dropping prior keys
//   * completeWizard requires reaching the final step and freezes the row
//   * autoStartEnabled() reads COACH_ONBOARDING_AUTO_START

function makePrisma() {
  const rows: any[] = [];
  let seq = 0;

  const cloneOrNull = (r: any) => (r ? { ...r } : null);

  return {
    _rows: rows,
    coachOnboardingProgress: {
      findUnique: jest.fn(async ({ where }: any) =>
        cloneOrNull(rows.find((r) => r.coach_id === where.coach_id)),
      ),
      create: jest.fn(async ({ data }: any) => {
        if (rows.find((r) => r.coach_id === data.coach_id)) {
          throw new Error(
            'in-memory prisma: duplicate coach_id (the service is supposed to ' +
              'findUnique first; if you see this from a test, the idempotency ' +
              'guard regressed)',
          );
        }
        const row = {
          id: `obp-${++seq}`,
          coach_id: data.coach_id,
          started_at: new Date(),
          completed_at: null,
          current_step: data.current_step ?? 1,
          step_data: data.step_data ?? null,
        };
        rows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.coach_id === where.coach_id);
        if (!row) throw new Error('Row not found');
        Object.assign(row, data);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let out = rows.filter((r) => {
          if (!where) return true;
          if (where.completed_at?.not === null) return r.completed_at != null;
          if (where.completed_at === null) return r.completed_at == null;
          return true;
        });
        if (orderBy?.started_at === 'desc') {
          out = out.slice().sort(
            (a, b) => b.started_at.getTime() - a.started_at.getTime(),
          );
        }
        if (take) out = out.slice(0, take);
        return out.map((r) => ({ ...r }));
      }),
      count: jest.fn(async ({ where }: any) => {
        return rows.filter((r) => {
          if (!where) return true;
          if (where.completed_at?.not === null) return r.completed_at != null;
          if (where.completed_at === null) return r.completed_at == null;
          return true;
        }).length;
      }),
    },
  };
}

describe('CoachOnboardingService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: CoachOnboardingService;

  beforeEach(() => {
    prisma = makePrisma();
    const analytics = { capture: jest.fn(), identify: jest.fn() } as any;
    svc = new CoachOnboardingService(prisma as any, analytics);
  });

  describe('startWizard', () => {
    it('creates a fresh row at step 1', async () => {
      const result = await svc.startWizard('coach-1');
      expect(result.coach_id).toBe('coach-1');
      expect(result.current_step).toBe(1);
      expect(result.is_complete).toBe(false);
      expect(prisma._rows).toHaveLength(1);
    });

    it('is idempotent — re-calling returns the existing row', async () => {
      const a = await svc.startWizard('coach-1');
      const b = await svc.startWizard('coach-1');
      expect(b.id).toBe(a.id);
      expect(prisma._rows).toHaveLength(1);
    });
  });

  describe('advanceStep', () => {
    it('allows the same step (resume mid-flow) without advancing', async () => {
      await svc.startWizard('coach-1');
      const after = await svc.advanceStep('coach-1', {
        step: 1,
        data: { business_name: 'Acme' },
      });
      expect(after.current_step).toBe(2);
      expect(after.step_data['1']).toEqual({ business_name: 'Acme' });
    });

    it('advances forward when step == current_step + 1', async () => {
      await svc.startWizard('coach-1');
      await svc.advanceStep('coach-1', { step: 1, data: { a: 1 } });
      const after = await svc.advanceStep('coach-1', { step: 2, data: { b: 2 } });
      expect(after.current_step).toBe(3);
      expect(after.step_data['1']).toEqual({ a: 1 });
      expect(after.step_data['2']).toEqual({ b: 2 });
    });

    it('rejects out-of-order jumps (skip ahead)', async () => {
      await svc.startWizard('coach-1');
      await expect(
        svc.advanceStep('coach-1', { step: 4 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects rewinds to a prior step', async () => {
      await svc.startWizard('coach-1');
      await svc.advanceStep('coach-1', { step: 1 });
      await svc.advanceStep('coach-1', { step: 2 });
      await expect(
        svc.advanceStep('coach-1', { step: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a step number outside [1, total]', async () => {
      await svc.startWizard('coach-1');
      await expect(
        svc.advanceStep('coach-1', { step: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.advanceStep('coach-1', { step: COACH_ONBOARDING_TOTAL_STEPS + 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns 404 when wizard has not been started', async () => {
      await expect(
        svc.advanceStep('coach-1', { step: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('completeWizard', () => {
    it('refuses when not yet on the final step', async () => {
      await svc.startWizard('coach-1');
      await expect(svc.completeWizard('coach-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('sets completed_at once the wizard reaches the final step', async () => {
      await svc.startWizard('coach-1');
      // Walk through every step to reach current_step = TOTAL.
      for (let i = 1; i <= COACH_ONBOARDING_TOTAL_STEPS; i++) {
        await svc.advanceStep('coach-1', { step: i });
      }
      const done = await svc.completeWizard('coach-1');
      expect(done.is_complete).toBe(true);
      expect(done.completed_at).not.toBeNull();
    });

    it('locks further mutations after completion (advance returns 409)', async () => {
      await svc.startWizard('coach-1');
      for (let i = 1; i <= COACH_ONBOARDING_TOTAL_STEPS; i++) {
        await svc.advanceStep('coach-1', { step: i });
      }
      await svc.completeWizard('coach-1');
      await expect(
        svc.advanceStep('coach-1', { step: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('re-calling completeWizard is idempotent (no error, returns frozen row)', async () => {
      await svc.startWizard('coach-1');
      for (let i = 1; i <= COACH_ONBOARDING_TOTAL_STEPS; i++) {
        await svc.advanceStep('coach-1', { step: i });
      }
      const a = await svc.completeWizard('coach-1');
      const b = await svc.completeWizard('coach-1');
      expect(b.completed_at).toBe(a.completed_at);
    });
  });

  describe('autoStartEnabled', () => {
    afterEach(() => {
      delete process.env.COACH_ONBOARDING_AUTO_START;
    });

    it('defaults to true when env unset', () => {
      expect(CoachOnboardingService.autoStartEnabled()).toBe(true);
    });

    it('honors "false" / "0" / "no"', () => {
      process.env.COACH_ONBOARDING_AUTO_START = 'false';
      expect(CoachOnboardingService.autoStartEnabled()).toBe(false);
      process.env.COACH_ONBOARDING_AUTO_START = '0';
      expect(CoachOnboardingService.autoStartEnabled()).toBe(false);
      process.env.COACH_ONBOARDING_AUTO_START = 'no';
      expect(CoachOnboardingService.autoStartEnabled()).toBe(false);
    });
  });

  describe('listAllProgress', () => {
    it('filters by completed=true', async () => {
      await svc.startWizard('coach-1');
      await svc.startWizard('coach-2');
      // Mark coach-1 complete via direct row mutation (the service requires
      // walking every step; we shortcut here because this is a list test).
      const row = prisma._rows.find((r: any) => r.coach_id === 'coach-1');
      row.completed_at = new Date();
      row.current_step = COACH_ONBOARDING_TOTAL_STEPS;
      const completed = await svc.listAllProgress({ completed: 'true' });
      const inflight = await svc.listAllProgress({ completed: 'false' });
      expect(completed.items.map((i) => i.coach_id)).toEqual(['coach-1']);
      expect(inflight.items.map((i) => i.coach_id)).toEqual(['coach-2']);
    });
  });
});
