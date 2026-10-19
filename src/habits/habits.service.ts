import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateHabitDto, HabitSummaryQuery, LogHabitDto, REMINDER_FIELDS, UpdateHabitDto } from './habits.dto';
import { resolveRecipientTimeZoneWithSource } from '../notifications/recipient-timezone';
import { localDate } from '../roman-adjust/roman-adjust.rules';
import { HabitDays, LOOK_BACK_DAYS, dayFromYmd, monday, summarize, toDay, ymd } from './habit-runs';

// A habit on chosen days names at least one; a times-a-week habit says how many.
function planIsComplete(h: { schedule_kind?: string; schedule_days?: number[] | null; times_per_week?: number | null }) {
  if (h.schedule_kind === 'days') return Boolean(h.schedule_days?.length);
  return h.schedule_kind !== 'times_per_week' || Boolean(h.times_per_week);
}
const toDate = (day: string | null | undefined) => (day == null ? day : new Date(day));
const SUMMARY_MAX_DAYS = 93;

// HB1: every route works on the caller's own habits only. A removed habit is
// archived: it leaves the client's list, and its logs stay in their history
// (exports, Roman's timeline). Coaches reach habits through the row rule in
// prisma/migrations/20270502002500_coach_set_habits, not through these routes.
@Injectable()
export class HabitsService {
  constructor(private prisma: PrismaService) {}

  // HB3: each habit adds its run, best run and this week's count (Monday to Sunday).
  async getHabits(userId: string) {
    const { today, habits } = await this.liveHabits(userId);
    const week = monday(today);
    return habits.map(({ habit, days }) => ({ ...habit, ...days.runs(), week: days.count(week, week + 6) }));
  }

  // GET /habits/summary: each day's planned and done, each habit's, the best week.
  async getSummary(userId: string, { from, to }: HabitSummaryQuery) {
    const [first, last] = [dayFromYmd(from), dayFromYmd(to)];
    if (!(last >= first && last - first < SUMMARY_MAX_DAYS)) throw new BadRequestException();
    const { today, habits } = await this.liveHabits(userId);
    return summarize(habits.map((h) => h.days), first, last, today);
  }

  async createHabit(userId: string, data: CreateHabitDto) {
    const { name, category, target_value, target_count, unit, starts_on, ...plan } = data;
    if (!planIsComplete(plan)) throw new BadRequestException();
    // HB3: planned days count from the start date, today unless the client picks one.
    const start = starts_on ?? ymd((await this.clientToday(userId)).today);
    // A new habit goes to the end of the client's list.
    const last = await this.prisma.habit.aggregate({ where: { user_id: userId }, _max: { sort_order: true } });
    // Only write columns that exist in the database schema.
    // Display fields (icon, color) are handled client-side with defaults.
    return this.prisma.habit.create({
      data: {
        user_id: userId,
        name,
        category: category || 'custom',
        target_value: target_count ?? target_value ?? null,
        unit: unit || null,
        ...plan,
        starts_on: toDate(start),
        sort_order: (last._max.sort_order ?? -1) + 1,
      },
    });
  }

  // The client edits a habit they made; on one their coach set, only its reminder.
  async updateHabit(userId: string, habitId: string, data: UpdateHabitDto) {
    const habit = await this.ownHabit(userId, habitId);
    if (habit.assigned_by_coach_id && Object.keys(data).some((key) => !REMINDER_FIELDS.includes(key))) {
      throw new ForbiddenException();
    }
    if (!planIsComplete({ ...habit, ...data })) throw new BadRequestException();
    return this.prisma.habit.update({
      where: { id: habit.id },
      data: { ...data, starts_on: toDate(data.starts_on) },
    });
  }

  async logHabit(userId: string, habitId: string, data: LogHabitDto) {
    // SECURITY: verify the habit belongs to the requesting user before writing a log
    // (audit C7 — IDOR: any authenticated user could log completions against any
    // other user's habit by guessing/obtaining the habit UUID).
    await this.ownHabit(userId, habitId);

    // HB3 (#WORDING-HB3): a tick is for any day up to the client's today in their
    // own calendar (a day of slack while their zone is unknown). A tick before the
    // habit's start moves the start back, as a first tick always has (main's list
    // shows a habit before its start). A future day is refused with a code only;
    // the app shows its own words.
    const { today, slack } = await this.clientToday(userId);
    const day = data.date ? dayFromYmd(data.date.slice(0, 10)) : today;
    if (day > today + slack) throw new BadRequestException({ code: 'HABIT_FUTURE_DAY' });
    const targetDate = new Date(`${ymd(day)}T00:00:00Z`);

    const existing = await this.prisma.habitLog.findFirst({
      where: { habit_id: habitId, date: targetDate },
    });

    if (existing) {
      return this.prisma.habitLog.update({
        where: { id: existing.id },
        data: {
          completed: data.completed ?? !existing.completed,
          value: data.value ?? existing.value,
        },
      });
    }
    return this.prisma.habitLog.create({
      data: {
        habit_id: habitId,
        date: targetDate,
        completed: data.completed ?? true,
        value: data.value ?? null,
      },
    });
  }

  async getLogs(userId: string, date: string) {
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    return this.prisma.habitLog.findMany({
      where: {
        date: targetDate,
        habit: { user_id: userId, archived_at: null },
      },
    });
  }

  // DELETE /habits/:id archives the habit and keeps its logs (found-not-fixed 2).
  async deleteHabit(userId: string, habitId: string) {
    const { count } = await this.prisma.habit.updateMany({
      where: { id: habitId, user_id: userId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (count === 0) throw new NotFoundException('Habit not found');
  }

  // The client's today, in days since 1970: their own zone, else their coach's, else UTC.
  private async clientToday(userId: string) {
    const zone = await resolveRecipientTimeZoneWithSource(this.prisma, userId);
    const today = dayFromYmd(localDate(new Date(), zone?.timeZone ?? 'UTC'));
    return { today, slack: zone?.source === 'recipient' ? 0 : 1 };
  }

  // The caller's live habits in list order, each with the days it was ticked done
  // in the two years the maths looks back.
  private async liveHabits(userId: string) {
    const live = { user_id: userId, archived_at: null };
    const { today } = await this.clientToday(userId);
    const since = new Date(`${ymd(today - LOOK_BACK_DAYS)}T00:00:00Z`);
    const [habits, ticks] = await Promise.all([
      this.prisma.habit.findMany({
        where: live,
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        include: { logs: { orderBy: { date: 'desc' }, take: 30 } },
      }),
      this.prisma.habitLog.findMany({ where: { completed: true, date: { gte: since }, habit: live }, select: { habit_id: true, date: true } }),
    ]);
    const done = (id: string) => new Set(ticks.filter((t) => t.habit_id === id).map((t) => toDay(t.date)));
    return { today, habits: habits.map((habit) => ({ habit, days: new HabitDays(habit, done(habit.id), today) })) };
  }

  private async ownHabit(userId: string, habitId: string) {
    const habit = await this.prisma.habit.findFirst({
      where: { id: habitId, user_id: userId, archived_at: null },
    });
    if (!habit) throw new NotFoundException('Habit not found');
    return habit;
  }
}
