import { dayFromYmd, ymd } from '../habits/habit-runs';

/**
 * LEARN-BE2: which weeks of a course are open to one enrolled client today.
 * One pure function, no Prisma and no clock of its own, so the course routes
 * and the tests ask the same question. The SQL helper app.course_module_open
 * answers the same way on the same day (app.client_today, 20270502007400): a
 * week is open once its day has come, start day + opens_after_days (0 when
 * every week opens at once), counted up to today or the day the enrolment
 * ended, whichever is first; a coach's open-all opens every week. Days are
 * YYYY-MM-DD strings in the client's own calendar, the end day too (Sol B2).
 *
 * finishBy (#LEARN-COURSE-STYLE "A · Weeks"): the last of the week's 7 days,
 * counted from the start (window + 6). Week n's window starts on the client's
 * start day + 7(n-1), or on the day the week opens if that is later, so a
 * Monday start finishes on the Sunday and every start gets a full 7 days
 * (b#1114 round 3, Opus B1). Advisory only: it never locks an open week again.
 */
export type ReleaseMode = 'dates' | 'all_at_once' | 'open_all';

export interface CourseOpenInput {
  startsOn: string;
  endedOn: string | null;
  today: string;
  releaseMode: ReleaseMode;
  weeks: ReadonlyArray<{ id: string; position: number; opensAfterDays: number }>;
}

export interface WeekOpen {
  id: string;
  open: boolean;
  /** The day the week opens (or opened); the start day when every week opens at once. */
  opensOn: string;
  finishBy: string;
}

export function courseOpen(input: CourseOpenInput): WeekOpen[] {
  const start = dayFromYmd(input.startsOn);
  const today = dayFromYmd(input.today);
  const reach = input.endedOn === null ? today : Math.min(today, dayFromYmd(input.endedOn));
  return [...input.weeks]
    .sort((a, b) => a.position - b.position)
    .map((week, index) => {
      const day = start + (input.releaseMode === 'dates' ? week.opensAfterDays : 0);
      const window = Math.max(day, start + 7 * index);
      return { id: week.id, open: input.releaseMode === 'open_all' || day <= reach, opensOn: ymd(day), finishBy: ymd(window + 6) };
    });
}
