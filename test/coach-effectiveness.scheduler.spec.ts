import {
  CoachEffectivenessScheduler,
  COACH_EFFECTIVENESS_CRON_DEFAULT,
} from '../src/coach/coach-effectiveness.scheduler';

// Phase 6A — verify the scheduler:
//   * honors COACH_EFFECTIVENESS_ENABLED=false as a no-op kill switch.
//   * walks every active coach and surfaces a per-run report.
//   * swallows per-coach errors instead of aborting the run.
//   * exposes the canonical default cron expression.

function buildPrisma(coachIds: string[]) {
  return {
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.role !== 'coach') return [];
        return coachIds.map((id) => ({ id }));
      }),
    },
  };
}

function buildEffectiveness(impl: (coachId: string) => Promise<unknown>) {
  return { score: jest.fn(impl) } as any;
}

describe('CoachEffectivenessScheduler', () => {
  const ORIGINAL_ENABLED = process.env.COACH_EFFECTIVENESS_ENABLED;

  afterEach(() => {
    process.env.COACH_EFFECTIVENESS_ENABLED = ORIGINAL_ENABLED;
  });

  it('default cron expression is 05:00 UTC', () => {
    expect(COACH_EFFECTIVENESS_CRON_DEFAULT).toBe('0 5 * * *');
  });

  it('handleCron skips work when disabled by env flag', async () => {
    process.env.COACH_EFFECTIVENESS_ENABLED = 'false';
    const prisma = buildPrisma(['c1', 'c2']);
    const eff = buildEffectiveness(async () => ({}));
    const scheduler = new CoachEffectivenessScheduler(prisma as any, eff);
    await scheduler.handleCron();
    expect(eff.score).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('run iterates every active coach and counts results', async () => {
    process.env.COACH_EFFECTIVENESS_ENABLED = 'true';
    const prisma = buildPrisma(['c1', 'c2', 'c3']);
    const eff = buildEffectiveness(async () => ({}));
    const scheduler = new CoachEffectivenessScheduler(prisma as any, eff);
    const report = await scheduler.run();
    expect(report.considered).toBe(3);
    expect(report.computed).toBe(3);
    expect(report.errors).toBe(0);
    expect(eff.score).toHaveBeenCalledTimes(3);
  });

  it('per-coach errors are swallowed and counted', async () => {
    const prisma = buildPrisma(['c1', 'c2', 'c3']);
    const eff = buildEffectiveness(async (id: string) => {
      if (id === 'c2') throw new Error('boom');
      return {};
    });
    const scheduler = new CoachEffectivenessScheduler(prisma as any, eff);
    const report = await scheduler.run();
    expect(report.considered).toBe(3);
    expect(report.computed).toBe(2);
    expect(report.errors).toBe(1);
  });
});
