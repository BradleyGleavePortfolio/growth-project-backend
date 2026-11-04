import { CoachService } from '../src/coach/coach.service';

// Pins Tier-2 timeline integration: check-ins appear in the merged `events`
// stream as `type: 'check_in'`, sorted with the other event types by date
// descending. Also pins the backwards-compat contract — the per-type arrays
// (meals/workouts/weights/checkIns) remain on the response shape so existing
// consumers aren't broken.
function makePrisma(fixtures: {
  meals?: Array<{ id: string; date: Date }>;
  workouts?: Array<{ id: string; date: Date; created_at: Date }>;
  weights?: Array<{ id: string; date: Date }>;
  checkIns?: Array<{ id: string; date: Date }>;
}) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'client-1',
        coach_id: 'coach-A',
        name: 'Client One',
      }),
    },
    loggedFoodEntry: {
      findMany: jest.fn().mockResolvedValue(fixtures.meals ?? []),
    },
    workoutSession: {
      findMany: jest.fn().mockResolvedValue(fixtures.workouts ?? []),
    },
    weightLog: {
      findMany: jest.fn().mockResolvedValue(fixtures.weights ?? []),
    },
    checkIn: {
      findMany: jest.fn().mockResolvedValue(fixtures.checkIns ?? []),
    },
  } as any;
}

const audit = () =>
  ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;

describe('CoachService.getClientTimeline (Tier-2 check-in integration)', () => {
  it('returns per-type arrays AND a merged `events` stream', async () => {
    const svc = new CoachService(
      makePrisma({
        meals: [{ id: 'm1', date: new Date('2026-04-22T10:00:00Z') }],
        workouts: [{ id: 'w1', date: new Date('2026-04-23T00:00:00Z'), created_at: new Date('2026-04-23T10:00:00Z') }],
        weights: [{ id: 'wt1', date: new Date('2026-04-21T00:00:00Z') }],
        checkIns: [{ id: 'c1', date: new Date('2026-04-24T00:00:00Z') }],
      }),
      audit(),
    );
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    // Backwards-compat: per-type arrays still present
    expect(r.meals).toHaveLength(1);
    expect(r.workouts).toHaveLength(1);
    expect(r.weights).toHaveLength(1);
    expect(r.checkIns).toHaveLength(1);
    // New merged events stream
    expect(r.events).toHaveLength(4);
    expect(r.events.map((e: any) => e.type)).toEqual([
      'check_in', // 2026-04-24 (newest)
      'workout',  // 2026-04-23
      'meal',     // 2026-04-22
      'weight',   // 2026-04-21 (oldest)
    ]);
  });

  it('each event carries a type, date, and ref back to the row', async () => {
    const svc = new CoachService(
      makePrisma({
        checkIns: [
          {
            id: 'c1',
            date: new Date('2026-04-24T00:00:00Z'),
            // extra fields should round-trip through `ref`
            mood: 4,
            energy: 3,
          } as any,
        ],
      }),
      audit(),
    );
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe('check_in');
    expect((r.events[0].ref as any).id).toBe('c1');
    expect((r.events[0].ref as any).mood).toBe(4);
  });

  it('returns empty events when client has no activity', async () => {
    const svc = new CoachService(makePrisma({}), audit());
    const r = (await svc.getClientTimeline('coach-A', 'client-1')) as any;
    expect(r.events).toEqual([]);
    expect(r.meals).toEqual([]);
    expect(r.checkIns).toEqual([]);
  });

  // Same-day foods tie on `date` (a calendar day). Without a unique
  // tie-break, the next mealsCursor page restarts at the boundary day and
  // repeats its entries, so a coach's food review double counts them.
  it('pages the meals slice on a unique order (date, then id)', async () => {
    const prisma = makePrisma({});
    const svc = new CoachService(prisma, audit());
    await svc.getClientTimeline('coach-A', 'client-1', 30, undefined, { mealsCursor: 'm-100' });
    expect(prisma.loggedFoodEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        cursor: { id: 'm-100' },
        skip: 1,
        take: 100,
      }),
    );
  });
});

// COACH-DAY-ORDER-BE: a workout belongs to the day it was done (`date`), not the
// moment the phone saved it (`created_at`). A Monday session saved on Wednesday
// sits on Monday, inside the window by Monday, and pages in day order.
describe('CoachService.getClientTimeline workouts by the day done', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  type Row = { id: string; date: Date; created_at: Date };
  // A Prisma-shaped fake: `where` gte on date / created_at, `orderBy`, and a
  // cursor that, like Prisma, keeps every row at or after the cursor row's sort
  // values (ties included), then skip and take.
  function workoutsTable(rows: Row[]) {
    return jest.fn(async (q: any) => {
      const keys: Array<[keyof Row, 'asc' | 'desc']> = [q.orderBy]
        .flat()
        .map((o: any) => Object.entries(o)[0] as [keyof Row, 'asc' | 'desc']);
      const cmp = (a: Row, b: Row) => {
        for (const [k, dir] of keys) {
          const x = +a[k] || String(a[k]);
          const y = +b[k] || String(b[k]);
          if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      };
      let out = rows
        .filter((r) => Object.entries(q.where).every(([k, v]: [string, any]) => k === 'user_id' || +r[k as keyof Row] >= +v.gte))
        .sort(cmp);
      if (q.cursor) {
        const at = out.find((r) => r.id === q.cursor.id)!;
        out = out.filter((r) => cmp(r, at) >= 0).slice(q.skip ?? 0);
      }
      return out.slice(0, q.take);
    });
  }
  const now = new Date('2026-11-03T23:00:00.000Z');
  beforeEach(() =>
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'queueMicrotask'] }),
  );
  afterEach(() => jest.useRealTimers());

  it('files a workout saved two days late under the day it was done', async () => {
    const prisma = makePrisma({ meals: [{ id: 'm1', date: day('2026-11-02') }] });
    prisma.workoutSession.findMany = workoutsTable([
      { id: 'w-mon', date: day('2026-11-01'), created_at: new Date('2026-11-03T08:00:00Z') },
    ]);
    const r = (await new CoachService(prisma, audit()).getClientTimeline('coach-A', 'client-1', 30)) as any;
    expect(r.events.map((e: any) => [e.type, e.date.toISOString().slice(0, 10)])).toEqual([
      ['meal', '2026-11-02'],
      ['workout', '2026-11-01'],
    ]);
    // The row itself is unchanged: the phone still reads created_at for the save time.
    expect(r.workouts[0].created_at.toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('chooses the window by whole days done, not by save time', async () => {
    const prisma = makePrisma({});
    prisma.workoutSession.findMany = workoutsTable([
      // Done on the window's first day (30 days back), saved that morning: in.
      { id: 'w-edge', date: day('2026-10-04'), created_at: new Date('2026-10-04T08:00:00Z') },
      // Done the day before the window, back-logged last week: out.
      { id: 'w-old', date: day('2026-10-03'), created_at: new Date('2026-10-28T10:00:00Z') },
    ]);
    const r = (await new CoachService(prisma, audit()).getClientTimeline('coach-A', 'client-1', 30)) as any;
    expect(r.workouts.map((w: Row) => w.id)).toEqual(['w-edge']);
  });

  it('keeps one order inside a day: meals first, then workouts newest save first', async () => {
    const prisma = makePrisma({ meals: [{ id: 'm1', date: day('2026-11-02') }] });
    prisma.workoutSession.findMany = workoutsTable([
      { id: 'w-am', date: day('2026-11-02'), created_at: new Date('2026-11-02T07:00:00Z') },
      { id: 'w-pm', date: day('2026-11-02'), created_at: new Date('2026-11-02T18:00:00Z') },
    ]);
    const r = (await new CoachService(prisma, audit()).getClientTimeline('coach-A', 'client-1', 30)) as any;
    expect(r.events.map((e: any) => e.ref.id)).toEqual(['m1', 'w-pm', 'w-am']);
  });

  it('pages 250 workouts in day order with none skipped or repeated', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 250; i++) {
      const done = new Date(day('2026-10-30').getTime() - (i % 25) * 86_400_000);
      // Every fifth one was saved three days late; rows 125 apart share their day and save instant (one offline flush).
      const saved = new Date(done.getTime() + (i % 5 === 0 ? 3 * 86_400_000 : 0) + (Math.floor(i / 25) % 5) * 3_600_000);
      rows.push({ id: `w-${String(i).padStart(3, '0')}`, date: done, created_at: saved });
    }
    const prisma = makePrisma({});
    prisma.workoutSession.findMany = workoutsTable(rows);
    const svc = new CoachService(prisma, audit());
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = (await svc.getClientTimeline('coach-A', 'client-1', 90, undefined, { workoutsCursor: cursor })) as any;
      seen.push(...r.workouts.map((w: Row) => w.id));
      if (r.workouts.length < 100) break;
      cursor = r.workouts[r.workouts.length - 1].id;
    }
    const want = [...rows]
      .sort((a, b) => +b.date - +a.date || +b.created_at - +a.created_at || (a.id < b.id ? 1 : -1))
      .map((w) => w.id);
    expect(seen).toEqual(want);
  });
});
