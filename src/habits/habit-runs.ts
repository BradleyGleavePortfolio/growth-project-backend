import type { HabitScheduleKind } from '@prisma/client';

// HB3: runs, best runs and week counts, worked out from HabitLog on every read
// so no counter can drift (planning/MOCKUP3/HABITS 10.1). Days are whole
// numbers (days since 1970-01-01) in the client's own calendar. Forgiving by
// design: only planned days count, today never breaks a run while it is still
// open, a run shows only from 2 days up, and the best run is always kept.

export interface HabitPlan {
  id: string;
  schedule_kind: HabitScheduleKind;
  schedule_days: number[];
  times_per_week: number | null;
  starts_on: Date | null;
}
export interface Count { planned: number; done: number }

const DAY_MS = 86_400_000;
export const toDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
export const dayFromYmd = (ymd: string) => toDay(new Date(`${ymd}T00:00:00Z`));
export const ymd = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: number) => (day + 4) % 7; // 0 = Sunday; day 0 was a Thursday
export const monday = (day: number) => day - ((weekday(day) + 6) % 7);
const span = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
const atLeastTwo = (n: number) => (n >= 2 ? n : null);

// A habit begins on its start date, or on its first tick if that came earlier
// (habits made before start dates were stored), else today.
function firstDay(plan: HabitPlan, done: Set<number>, today: number) {
  return Math.min(plan.starts_on ? toDay(plan.starts_on) : today, ...done);
}

// A daily habit is planned every day, a chosen-days habit on its days. A
// times-a-week habit has no fixed day: it counts per week, not per day.
const plannedOn = (plan: HabitPlan, day: number) =>
  plan.schedule_kind === 'daily' || (plan.schedule_kind === 'days' && plan.schedule_days.includes(weekday(day)));

// Planned and done over some days of one week (a times-a-week habit can plan
// no more ticks than the days left).
function weekCount(plan: HabitPlan, done: Set<number>, days: number[]): Count {
  if (plan.schedule_kind === 'times_per_week') {
    const planned = Math.min(plan.times_per_week ?? 0, days.length);
    return { planned, done: Math.min(days.filter((d) => done.has(d)).length, planned) };
  }
  const planned = days.filter((d) => plannedOn(plan, d));
  return { planned: planned.length, done: planned.filter((d) => done.has(d)).length };
}

const add = (a: Count, b: Count): Count => ({ planned: a.planned + b.planned, done: a.done + b.done });

export class HabitDays {
  readonly start: number;
  constructor(readonly plan: HabitPlan, readonly done: Set<number>, readonly today: number) {
    this.start = firstDay(plan, done, today);
  }

  // Planned and done from `from` to `to`, week by week, from the habit's start.
  count(from: number, to: number): Count {
    let total: Count = { planned: 0, done: 0 };
    for (let mon = monday(from); mon <= to; mon += 7) {
      total = add(total, weekCount(this.plan, this.done, span(Math.max(mon, from, this.start), Math.min(mon + 6, to))));
    }
    return total;
  }

  // One day's cell. A times-a-week habit shows only on the days it was ticked.
  day(day: number): Count {
    if (day < this.start) return { planned: 0, done: 0 };
    const done = this.done.has(day) ? 1 : 0;
    if (this.plan.schedule_kind === 'times_per_week') return { planned: done, done };
    return plannedOn(this.plan, day) ? { planned: 1, done } : { planned: 0, done: 0 };
  }

  // The current run and the best run, in planned days in a row. A
  // times-a-week habit has no days in a row (null).
  runs() {
    let run = 0;
    let best = 0;
    if (this.plan.schedule_kind !== 'times_per_week') {
      for (const day of span(this.start, this.today)) {
        if (!plannedOn(this.plan, day)) continue;
        if (this.done.has(day)) best = Math.max(best, ++run);
        else if (day < this.today) run = 0;
      }
    }
    return { run_days: atLeastTwo(run), best_run_days: atLeastTwo(best) };
  }
}

// GET /habits/summary: every day from `from` to `to`, each habit over the
// range, and the client's best week so far (most done; fewer planned breaks a
// tie; the latest wins after that).
export function summarize(habits: HabitDays[], from: number, to: number, today: number) {
  const total = (count: (h: HabitDays) => Count) => habits.reduce((sum, h) => add(sum, count(h)), { planned: 0, done: 0 });
  const days = span(from, to).map((day) => ({ date: ymd(day), ...total((h) => h.day(day)) }));
  let best: (Count & { start: string; end: string }) | null = null;
  for (let mon = monday(Math.min(today, ...habits.map((h) => h.start))); mon <= today; mon += 7) {
    const week = total((h) => h.count(mon, mon + 6));
    if (week.done > 0 && (!best || week.done > best.done || (week.done === best.done && week.planned <= best.planned))) {
      best = { start: ymd(mon), end: ymd(mon + 6), ...week };
    }
  }
  return {
    today: ymd(today),
    days,
    habits: habits.map((h) => ({ id: h.plan.id, ...h.count(from, to) })),
    best_week: best,
  };
}
