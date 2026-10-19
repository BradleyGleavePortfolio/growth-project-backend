import { HabitDays, HabitPlan, dayFromYmd, monday, summarize } from '../src/habits/habit-runs';

// HB3: forgiving runs and week counts (planning/MOCKUP3/HABITS 6 and 10.1).
// Today is Wednesday 2026-10-14; its week runs Monday 12 to Sunday 18.
const TODAY = dayFromYmd('2026-10-14');
const plan = (over: Partial<HabitPlan> = {}): HabitPlan => ({
  id: 'h1', schedule_kind: 'daily', schedule_days: [], times_per_week: null, starts_on: new Date('2026-10-01'), ...over,
});
const ticked = (...days: string[]) => new Set(days.map(dayFromYmd));
const oct = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);
const habit = (over: Partial<HabitPlan>, days: string[]) => new HabitDays(plan(over), ticked(...days), TODAY);
const MWF = { schedule_kind: 'days' as const, schedule_days: [1, 3, 5] };

describe('HabitDays.runs: planned days in a row, shown from 2 up, the best kept', () => {
  it.each<[string, Partial<HabitPlan>, string[], number | null, number | null]>([
    ['today still open keeps the run', {}, oct(10, 13), 4, 4],
    ['today ticked adds to it', {}, oct(10, 14), 5, 5],
    ['a missed day ends the run; the best stays', {}, [...oct(2, 8), ...oct(10, 13)], 4, 7],
    ['an open yesterday ends the run until it is marked', {}, oct(5, 12), null, 8],
    ['one day is not a run yet (never a zero)', {}, ['2026-10-13'], null, null],
    ['nothing ticked shows nothing', {}, [], null, null],
    ['chosen days: off days are never missed', MWF, ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12'], 4, 4],
    ['chosen days: a tick on an off day is not needed and not counted', MWF, ['2026-10-09', '2026-10-10', '2026-10-12'], 2, 2],
    ['a start typed years back still counts (two years looked back at most)', { starts_on: new Date('0001-01-01') }, oct(10, 13), 4, 4],
    ['a tick before the start moves the start back to it', { starts_on: new Date('2026-10-12') }, oct(10, 13), 4, 4],
    ['times a week has no days in a row', { schedule_kind: 'times_per_week', times_per_week: 3 }, oct(5, 14), null, null],
  ])('%s', (_name, over, days, run, best) => {
    expect(habit(over, days).runs()).toEqual({ run_days: run, best_run_days: best });
  });

  // A late tick heals the run: runs are read from the ticks, never stored (#WORDING-HB3, #HB3-OPEN-YESTERDAY op 1).
  it.each<[string, string[], number | null, string, number]>([
    ['yesterday, marked this morning', oct(5, 12), null, '2026-10-13', 9],
    ['a day last week, marked today', [...oct(8, 10), ...oct(12, 13)], 2, '2026-10-11', 6],
  ])('a late tick heals the run: %s', (_name, days, before, late, healed) => {
    expect(habit({}, days).runs().run_days).toBe(before);
    expect(habit({}, [...days, late]).runs()).toEqual({ run_days: healed, best_run_days: healed });
  });

  it('a habit made before start dates were stored begins on its first tick', () => {
    expect(habit({ starts_on: null }, oct(11, 13)).runs()).toEqual({ run_days: 3, best_run_days: 3 });
  });
});

describe('HabitDays.count: this week, Monday to Sunday, planned days only', () => {
  const week = (over: Partial<HabitPlan>, days: string[]) => habit(over, days).count(monday(TODAY), monday(TODAY) + 6);

  it.each<[string, Partial<HabitPlan>, string[], number, number]>([
    ['daily: every day of the week is planned', {}, oct(12, 14), 7, 3],
    ['daily from Wednesday: only Wednesday on', { starts_on: new Date('2026-10-14') }, ['2026-10-14'], 5, 1],
    ['coach-set from tomorrow: today is not planned', { starts_on: new Date('2026-10-15') }, [], 4, 0],
    ['chosen days: Mon, Wed, Fri', MWF, ['2026-10-12', '2026-10-13'], 3, 1],
    ['times a week: the number, done capped at it', { schedule_kind: 'times_per_week', times_per_week: 3 }, oct(12, 14).concat('2026-10-11'), 3, 3],
    ['times a week from Saturday: no more than the days left', { schedule_kind: 'times_per_week', times_per_week: 3, starts_on: new Date('2026-10-17') }, [], 2, 0],
  ])('%s', (_name, over, days, planned, done) => {
    expect(week(over, days)).toEqual({ planned, done });
  });
});

describe('summarize: GET /habits/summary', () => {
  const water = habit({ id: 'water' }, [...oct(5, 9), ...oct(12, 13)]);
  const run = habit({ id: 'run', schedule_kind: 'times_per_week', times_per_week: 2 }, ['2026-10-06', '2026-10-13']);

  it('gives each day its planned and done; a times-a-week habit shows on the days it was ticked', () => {
    const s = summarize([water, run], dayFromYmd('2026-10-12'), dayFromYmd('2026-10-15'), TODAY);
    expect(s.today).toBe('2026-10-14');
    expect(s.days).toEqual([
      { date: '2026-10-12', planned: 1, done: 1 },
      { date: '2026-10-13', planned: 2, done: 2 },
      { date: '2026-10-14', planned: 1, done: 0 },
      { date: '2026-10-15', planned: 1, done: 0 },
    ]);
    expect(s.habits).toEqual([{ id: 'water', planned: 4, done: 2 }, { id: 'run', planned: 2, done: 1 }]);
  });

  it('the best week has the most done', () => {
    const s = summarize([water, run], dayFromYmd('2026-10-12'), dayFromYmd('2026-10-18'), TODAY);
    // Sep 28 week: nothing ticked; Oct 5 week: 5 water + 1 run, of 7 + 2; this week: 2 + 1, of 7 + 2.
    expect(s.best_week).toEqual({ start: '2026-10-05', end: '2026-10-11', planned: 9, done: 6 });
  });

  it('of tied weeks, the most recent is the best week (#HB3-BEST-WEEK), even with more planned', () => {
    // From Wednesday Sep 30: that week plans 5 and does 3; the Oct 5 week plans 7 and does 3.
    const walk = habit({ starts_on: new Date('2026-09-30') }, ['2026-09-30', '2026-10-01', '2026-10-02', ...oct(5, 7)]);
    expect(summarize([walk], TODAY, TODAY, TODAY).best_week).toEqual({ start: '2026-10-05', end: '2026-10-11', planned: 7, done: 3 });
  });

  it('has no best week before the first tick, and no days with no habits', () => {
    const s = summarize([habit({}, [])], TODAY, TODAY, TODAY);
    expect(s.best_week).toBeNull();
    expect(summarize([], TODAY, TODAY, TODAY)).toEqual({
      today: '2026-10-14', days: [{ date: '2026-10-14', planned: 0, done: 0 }], habits: [], best_week: null,
    });
  });
});
