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
    return this.prisma.habit.create({ data: { ...data, user_id: userId } });
  }

  async logHabit(userId: string, habitId: string, data: any) {
    // Upsert habit log for today
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await this.prisma.habitLog.findFirst({
      where: { habit_id: habitId, date: today },
    });

    if (existing) {
      return this.prisma.habitLog.update({ where: { id: existing.id }, data });
    }
    return this.prisma.habitLog.create({
      data: { habit_id: habitId, date: today, ...data },
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
