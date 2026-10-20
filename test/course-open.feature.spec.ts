import { CourseOpenInput, OpenWeekInput, courseOpen } from '../src/courses/course-open.feature';

const lessons = (...done: boolean[]) => done.map((d, i) => ({ id: `l${i}`, done: d }));
const week = (id: string, position: number, opensAfterDays: number, ...done: boolean[]): OpenWeekInput => ({
  id,
  position,
  opensAfterDays,
  lessons: lessons(...done),
});

const base: CourseOpenInput = {
  startsOn: '2026-10-05',
  endedOn: null,
  today: '2026-10-12',
  releaseMode: 'dates',
  weeks: [week('w1', 1, 0, true, true), week('w2', 2, 7, true, false), week('w3', 3, 14, false)],
};
const run = (over: Partial<CourseOpenInput>) => courseOpen({ ...base, ...over });
const openIds = (r: ReturnType<typeof courseOpen>) => r.weeks.filter((w) => w.open).map((w) => w.id);

describe('courseOpen (LEARN-BE2)', () => {
  it('opens a week on its day, not the day before', () => {
    expect(openIds(run({ today: '2026-10-11' }))).toEqual(['w1']);
    expect(openIds(run({ today: '2026-10-12' }))).toEqual(['w1', 'w2']);
  });

  it('opens nothing before the start day and names the first unlock', () => {
    const r = run({ today: '2026-10-04' });
    expect(openIds(r)).toEqual([]);
    expect(r.currentWeekId).toBeNull();
    expect(r.nextUnlockOn).toBe('2026-10-05');
  });

  it('reports the next unlock, the current week and the lesson counts', () => {
    const r = run({});
    expect(r.nextUnlockOn).toBe('2026-10-19');
    expect(r.currentWeekId).toBe('w2');
    expect(r.weeks.map((w) => [w.number, w.opensOn, w.done, w.total])).toEqual([
      [1, '2026-10-05', 2, 2],
      [2, '2026-10-12', 1, 2],
      [3, '2026-10-19', 0, 1],
    ]);
    expect([r.done, r.total]).toEqual([3, 5]);
  });

  it('keeps the current week on the last open week when every open lesson is done', () => {
    const r = run({ weeks: [week('w1', 1, 0, true), week('w2', 2, 7, true), week('w3', 3, 14, false)] });
    expect(r.currentWeekId).toBe('w2');
  });

  it('opens every week at once, ignoring opens_after_days, and has no next unlock', () => {
    const r = run({ releaseMode: 'all_at_once', today: '2026-10-05' });
    expect(openIds(r)).toEqual(['w1', 'w2', 'w3']);
    expect(r.nextUnlockOn).toBeNull();
    expect(r.weeks.every((w) => w.opensOn === '2026-10-05')).toBe(true);
  });

  it('opens every week when the coach opened all, even before the start day', () => {
    const r = run({ releaseMode: 'open_all', today: '2026-10-01' });
    expect(openIds(r)).toEqual(['w1', 'w2', 'w3']);
    expect(r.nextUnlockOn).toBeNull();
  });

  it('stops opening weeks on the day the enrolment ended', () => {
    const r = run({ endedOn: '2026-10-10', today: '2026-11-30' });
    expect(openIds(r)).toEqual(['w1']);
    expect(r.nextUnlockOn).toBeNull();
    expect(r.currentWeekId).toBe('w1');
  });

  it('still names an unlock that falls on or before an end day not yet reached', () => {
    const r = run({ endedOn: '2026-10-20', today: '2026-10-12' });
    expect(r.nextUnlockOn).toBe('2026-10-19');
  });

  it('numbers weeks by position, whatever order they arrive in', () => {
    const r = run({ weeks: [week('w3', 3, 14, false), week('w1', 1, 0, true), week('w2', 2, 7, true)] });
    expect(r.weeks.map((w) => [w.id, w.number])).toEqual([['w1', 1], ['w2', 2], ['w3', 3]]);
  });

  it('handles a course with no weeks', () => {
    const r = run({ weeks: [] });
    expect(r).toEqual({ weeks: [], nextUnlockOn: null, currentWeekId: null, done: 0, total: 0 });
  });
});
