import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class HabitsService {
  constructor(private prisma: PrismaService) {}

  async getHabits(userId: string) {
    return this.prisma.habit.findMany({
      where: { user_id: userId },
      include: { logs: { orderBy: { date: 'desc' }, take: 30 } },
    });
  }

  async createHabit(userId: string, data: any) {
    return this.prisma.habit.create({
      data: {
        user_id: userId,
        name: data.name,
        category: data.category || 'custom',
        icon: data.icon || 'checkmark-circle',
        color: data.color || '#2D6A4F',
        frequency: data.frequency || 'daily',
        target_value: data.target_count ? parseFloat(data.target_count) : data.target_value || null,
        unit: data.unit || null,
      },
    });
  }

  async logHabit(userId: string, habitId: string, data: any) {
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

    const habits = await this.prisma.habit.findMany({
      where: { user_id: userId },
      select: { id: true },
    });
    const habitIds = habits.map(h => h.id);

    return this.prisma.habitLog.findMany({
      where: {
        habit_id: { in: habitIds },
        date: targetDate,
      },
    });
  }

  async getStreaks(userId: string) {
    const habits = await this.prisma.habit.findMany({
      where: { user_id: userId },
      include: { logs: { orderBy: { date: 'desc' }, take: 90 } },
    });

    return habits.map(h => {
      let streak = 0;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (let i = 0; i < 90; i++) {
        const checkDate = new Date(today);
        checkDate.setDate(checkDate.getDate() - i);
        const log = h.logs.find(l => {
          const d = new Date(l.date);
          d.setHours(0, 0, 0, 0);
          return d.getTime() === checkDate.getTime();
        });
        if (log && log.completed) streak++;
        else break;
      }

      return { habit_id: h.id, habit_name: h.name, streak };
    });
  }
}
