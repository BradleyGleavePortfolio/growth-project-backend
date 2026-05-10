import { BuildWeekService } from '../src/build-week/build-week.service';

// Pins the funnel aggregation contract used by GET /admin/build-week/funnel.
// We exercise BuildWeekService.funnel() directly rather than spinning up
// the AdminController + auth stack — the controller is a thin wrapper
// (delegate -> service.funnel()), and the OWNER guard is covered by
// admin-audit.spec.ts.

interface FakeEnrollment {
  id: string;
  user_id: string;
  current_day: number;
  status: string;
}
interface FakeCompletion {
  enrollment_id: string;
  day_number: number;
}

function buildSvc() {
  const enrollments: FakeEnrollment[] = [];
  const completions: FakeCompletion[] = [];

  const prisma = {
    buildWeekEnrollment: {
      findMany: jest.fn(async () => enrollments.slice()),
    },
    buildWeekDayCompletion: {
      groupBy: jest.fn(async () => {
        const counts = new Map<number, number>();
        for (const c of completions) counts.set(c.day_number, (counts.get(c.day_number) ?? 0) + 1);
        return [...counts.entries()].map(([day, n]) => ({
          day_number: day,
          _count: { _all: n },
        }));
      }),
    },
  };
  const audit = { write: jest.fn(async () => {}) } as any;
  const ptm = { emit: jest.fn() } as any;
  const svc = new BuildWeekService(prisma as any, audit, ptm);
  return { svc, enrollments, completions };
}

describe('admin build-week funnel', () => {
  it('reports zero counts on an empty cohort', async () => {
    const { svc } = buildSvc();
    const f = await svc.funnel();
    expect(f.total_enrolled).toBe(0);
    expect(f.total_completed).toBe(0);
    expect(f.completion_rate).toBe(0);
    expect(f.dropoff_per_day).toHaveLength(7);
    for (const d of f.dropoff_per_day) {
      expect(d.reached).toBe(0);
      expect(d.dropped).toBe(0);
    }
  });

  it('returns expected drop-off counts on a synthetic enrollment set', async () => {
    const { svc, enrollments, completions } = buildSvc();
    // Cohort: 5 enrolled.
    //   - 5 cleared day 1.
    //   - 4 cleared day 2.
    //   - 3 cleared day 3.
    //   - 2 cleared day 4.
    //   - 1 cleared days 5, 6, 7 and is 'completed'.
    for (let i = 1; i <= 5; i++) {
      enrollments.push({ id: `e${i}`, user_id: `u${i}`, current_day: i === 5 ? 7 : i, status: i === 5 ? 'completed' : 'active' });
    }
    const reached: Record<number, number> = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1, 6: 1, 7: 1 };
    for (const [dayStr, count] of Object.entries(reached)) {
      const day = Number(dayStr);
      for (let i = 0; i < count; i++) {
        completions.push({ enrollment_id: `e${i + 1}`, day_number: day });
      }
    }

    const f = await svc.funnel();
    expect(f.total_enrolled).toBe(5);
    expect(f.total_completed).toBe(1);
    expect(f.completion_rate).toBeCloseTo(0.2, 5);
    const byDay = Object.fromEntries(f.dropoff_per_day.map((d) => [d.day_number, d]));
    expect(byDay[1]).toEqual({ day_number: 1, reached: 5, dropped: 1 });
    expect(byDay[2]).toEqual({ day_number: 2, reached: 4, dropped: 1 });
    expect(byDay[3]).toEqual({ day_number: 3, reached: 3, dropped: 1 });
    expect(byDay[4]).toEqual({ day_number: 4, reached: 2, dropped: 1 });
    expect(byDay[5]).toEqual({ day_number: 5, reached: 1, dropped: 0 });
    expect(byDay[6]).toEqual({ day_number: 6, reached: 1, dropped: 0 });
    expect(byDay[7]).toEqual({ day_number: 7, reached: 1, dropped: 0 });
  });
});
