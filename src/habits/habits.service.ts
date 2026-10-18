import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateHabitDto, LogHabitDto, REMINDER_FIELDS, UpdateHabitDto } from './habits.dto';

// A habit on chosen days names at least one; a times-a-week habit says how many.
function planIsComplete(h: { schedule_kind?: string; schedule_days?: number[] | null; times_per_week?: number | null }) {
  if (h.schedule_kind === 'days') return Boolean(h.schedule_days?.length);
  return h.schedule_kind !== 'times_per_week' || Boolean(h.times_per_week);
}
const toDate = (day: string | null | undefined) => (day == null ? day : new Date(day));

// HB1: every route works on the caller's own habits only. A removed habit is
// archived: it leaves the client's list, and its logs stay in their history
// (exports, Roman's timeline). Coaches reach habits through the row rule in
// prisma/migrations/20270502002500_coach_set_habits, not through these routes.
@Injectable()
export class HabitsService {
  constructor(private prisma: PrismaService) {}

  async getHabits(userId: string) {
    return this.prisma.habit.findMany({
      where: { user_id: userId, archived_at: null },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
      include: { logs: { orderBy: { date: 'desc' }, take: 30 } },
    });
  }

  async createHabit(userId: string, data: CreateHabitDto) {
    const { name, category, target_value, target_count, unit, starts_on, ...plan } = data;
    if (!planIsComplete(plan)) throw new BadRequestException();
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
        starts_on: toDate(starts_on),
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

    const targetDate = data.date ? new Date(data.date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

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

  private async ownHabit(userId: string, habitId: string) {
    const habit = await this.prisma.habit.findFirst({
      where: { id: habitId, user_id: userId, archived_at: null },
    });
    if (!habit) throw new NotFoundException('Habit not found');
    return habit;
  }
}
