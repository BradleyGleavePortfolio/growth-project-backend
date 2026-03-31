import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class WaterService {
  constructor(private prisma: PrismaService) {}

  async logWater(userId: string, data: { amount_ml: number; date?: string }) {
    if (!data.amount_ml || data.amount_ml <= 0) {
      throw new BadRequestException('amount_ml must be a positive number');
    }

    return this.prisma.waterLog.create({
      data: {
        user_id: userId,
        amount_ml: data.amount_ml,
        logged_at: data.date ? new Date(data.date) : new Date(),
      },
    });
  }

  async getDaily(userId: string, date: string) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const logs = await this.prisma.waterLog.findMany({
      where: {
        user_id: userId,
        logged_at: { gte: start, lte: end },
      },
      orderBy: { logged_at: 'asc' },
      select: { id: true, amount_ml: true, logged_at: true },
    });

    const total_ml = logs.reduce((sum, log) => sum + log.amount_ml, 0);

    return { total_ml, logs };
  }

  async getWeekly(userId: string, startDate: string) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const logs = await this.prisma.waterLog.findMany({
      where: {
        user_id: userId,
        logged_at: { gte: start, lt: end },
      },
      orderBy: { logged_at: 'asc' },
    });

    const byDate: Record<string, { date: string; total_ml: number; count: number }> = {};
    logs.forEach((log) => {
      const d = log.logged_at.toISOString().split('T')[0];
      if (!byDate[d]) byDate[d] = { date: d, total_ml: 0, count: 0 };
      byDate[d].total_ml += log.amount_ml;
      byDate[d].count += 1;
    });

    return Object.values(byDate);
  }
}
