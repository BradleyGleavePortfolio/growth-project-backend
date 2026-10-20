import { CourseOpenInput, courseOpen } from '../src/courses/course-open.feature';

const week = (id: string, position: number, opensAfterDays: number) => ({ id, position, opensAfterDays });
const base: CourseOpenInput = {
  startsOn: '2026-10-05', // a Monday
  endedOn: null,
  today: '2026-10-12',
  releaseMode: 'dates',
  weeks: [week('w1', 1, 0), week('w2', 2, 7), week('w3', 3, 14)],
};
const run = (over: Partial<CourseOpenInput>) => courseOpen({ ...base, ...over });
const openIds = (r: ReturnType<typeof courseOpen>) => r.filter((w) => w.open).map((w) => w.id);
const dates = (r: ReturnType<typeof courseOpen>) => r.map((w) => [w.id, w.opensOn, w.finishBy]);

describe('courseOpen (LEARN-BE2)', () => {
  it('opens a week on its day, not the day before', () => {
    expect(openIds(run({ today: '2026-10-11' }))).toEqual(['w1']);
    expect(openIds(run({ today: '2026-10-12' }))).toEqual(['w1', 'w2']);
  });

  it('opens nothing before the start day', () => {
    expect(openIds(run({ today: '2026-10-04' }))).toEqual([]);
  });

  it('Monday start: each week is finished by the Sunday that closes its 7 days, the last week too', () => {
    expect(dates(run({}))).toEqual([
      ['w1', '2026-10-05', '2026-10-11'],
      ['w2', '2026-10-12', '2026-10-18'],
      ['w3', '2026-10-19', '2026-10-25'],
    ]);
  });

  it('mid-week start: each week is finished by the Sunday inside its 7 days', () => {
    expect(dates(run({ startsOn: '2026-10-07', today: '2026-10-07' }))).toEqual([
      ['w1', '2026-10-07', '2026-10-11'],
      ['w2', '2026-10-14', '2026-10-18'],
      ['w3', '2026-10-21', '2026-10-25'],
    ]);
    // A Sunday start: week 1 is finished by its first day.
    expect(run({ startsOn: '2026-10-11' }).map((w) => w.finishBy)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
  });

  it('a week that opens later than its 7-day slot is finished by the Sunday after it opens', () => {
    expect(dates(run({ weeks: [week('w1', 1, 0), week('w2', 2, 16)] }))[1]).toEqual(['w2', '2026-10-21', '2026-10-25']);
  });

  it('finish-by never locks an open week: a week stays open after its Sunday', () => {
    const r = run({ today: '2026-11-30' });
    expect(openIds(r)).toEqual(['w1', 'w2', 'w3']);
    expect(r[0].finishBy).toBe('2026-10-11');
  });

  it('opens every week at once, ignoring opens_after_days, still pacing finish-by a week apart', () => {
    const r = run({ releaseMode: 'all_at_once', today: '2026-10-05' });
    expect(openIds(r)).toEqual(['w1', 'w2', 'w3']);
    expect(dates(r)).toEqual([
      ['w1', '2026-10-05', '2026-10-11'],
      ['w2', '2026-10-05', '2026-10-18'],
      ['w3', '2026-10-05', '2026-10-25'],
    ]);
  });

  it('opens every week when the coach opened all, even before the start day', () => {
    expect(openIds(run({ releaseMode: 'open_all', today: '2026-10-01' }))).toEqual(['w1', 'w2', 'w3']);
  });

  it('stops opening weeks on the day the enrolment ended, keeping what had opened', () => {
    expect(openIds(run({ endedOn: '2026-10-10', today: '2026-11-30' }))).toEqual(['w1']);
  });

  it('orders weeks by position, whatever order they arrive in', () => {
    expect(run({ weeks: [week('w3', 3, 14), week('w1', 1, 0), week('w2', 2, 7)] }).map((w) => w.id)).toEqual(['w1', 'w2', 'w3']);
  });

  it('handles a course with no weeks', () => {
    expect(run({ weeks: [] })).toEqual([]);
  });
});
