import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LogWeightDto } from './weight.dto';

@Injectable()
export class WeightService {
  constructor(private prisma: PrismaService) {}

  async logWeight(userId: string, data: LogWeightDto) {
    return this.prisma.weightLog.create({
      data: {
        user_id: userId,
        date: data.date ? new Date(data.date) : new Date(),
        weight_lbs: data.weight_lbs,
        notes: data.notes,
      },
    });
  }

  async getHistory(userId: string, days = 30) {
    const start = new Date();
    start.setDate(start.getDate() - days);
    const logs = await this.prisma.weightLog.findMany({
      where: { user_id: userId, date: { gte: start } },
      orderBy: { date: 'asc' },
    });

    // Include height from UserProfile for BMI calculations
    const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
    return { logs, height_cm: profile?.height_cm || null };
  }
}
