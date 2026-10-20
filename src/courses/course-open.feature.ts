import { dayFromYmd, ymd } from '../habits/habit-runs';

/**
 * LEARN-BE2: which weeks of a course are open to one enrolled client today.
 * One pure function, no Prisma and no clock of its own, so the course routes
 * and the tests ask the same question. The SQL helper app.course_module_open
 * (20270502006000) answers the same way: a week is open once its day has come,
 * start day + opens_after_days (0 when every week opens at once), counted up to
 * today or the day the enrolment ended, whichever is first; a coach's open-all
 * opens every week. Days are YYYY-MM-DD strings in the client's own calendar.
 */
export type ReleaseMode = 'dates' | 'all_at_once' | 'open_all';

export interface OpenWeekInput {
  id: string;
  position: number;
  opensAfterDays: number;
  lessons: ReadonlyArray<{ id: string; done: boolean }>;
}

export interface CourseOpenInput {
  startsOn: string;
  endedOn: string | null;
  today: string;
  releaseMode: ReleaseMode;
  weeks: ReadonlyArray<OpenWeekInput>;
}

export interface WeekOpen {
  id: string;
  number: number;
  open: boolean;
  /** The day the week opens (or opened); the start day when every week opens at once. */
  opensOn: string;
  done: number;
  total: number;
}

export interface CourseOpen {
  weeks: WeekOpen[];
  /** The soonest day a locked week opens; null when none will (all open, or the enrolment ended first). */
  nextUnlockOn: string | null;
  /** First open week with a lesson left, else the last open week; null while none is open. */
  currentWeekId: string | null;
  done: number;
  total: number;
}

export function courseOpen(input: CourseOpenInput): CourseOpen {
  const start = dayFromYmd(input.startsOn);
  const today = dayFromYmd(input.today);
  const ended = input.endedOn === null ? null : dayFromYmd(input.endedOn);
  const reach = ended === null ? today : Math.min(today, ended);
  const ordered = [...input.weeks].sort((a, b) => a.position - b.position);

  const weeks = ordered.map((week, index): WeekOpen => {
    const day = start + (input.releaseMode === 'dates' ? week.opensAfterDays : 0);
    const done = week.lessons.filter((lesson) => lesson.done).length;
    return {
      id: week.id,
      number: index + 1,
      open: input.releaseMode === 'open_all' || day <= reach,
      opensOn: ymd(day),
      done,
      total: week.lessons.length,
    };
  });

  const coming = weeks
    .filter((week) => !week.open && (ended === null || dayFromYmd(week.opensOn) <= ended))
    .map((week) => week.opensOn)
    .sort();
  const open = weeks.filter((week) => week.open);
  const current = open.find((week) => week.done < week.total) ?? open[open.length - 1];

  return {
    weeks,
    nextUnlockOn: coming[0] ?? null,
    currentWeekId: current?.id ?? null,
    done: weeks.reduce((sum, week) => sum + week.done, 0),
    total: weeks.reduce((sum, week) => sum + week.total, 0),
  };
}
