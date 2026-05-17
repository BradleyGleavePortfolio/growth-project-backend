import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { LogWeightDto } from './weight.dto';

@Injectable()
export class WeightService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
    // M2 — bust the AI context cache after weight writes.
    private aiContext: ClientAIContextService,
  ) {}

  async logWeight(userId: string, data: LogWeightDto) {
    const prior = await this.prisma.weightLog.findFirst({
      where: { user_id: userId },
      orderBy: { date: 'desc' },
      select: { weight_lbs: true },
    });
    const created = await this.prisma.weightLog.create({
      data: {
        user_id: userId,
        date: data.date ? new Date(data.date) : new Date(),
        weight_lbs: data.weight_lbs,
        notes: data.notes,
      },
    });
    const priorLbs = prior?.weight_lbs ?? null;
    const delta = priorLbs == null ? 0 : data.weight_lbs - priorLbs;
    this.ptm.emit(userId, 'weight_logged', delta, {
      weight_lbs: data.weight_lbs,
      prior_weight_lbs: priorLbs,
    });
    // M2 — bust AI context cache so next chat sees the new weight.
    this.aiContext.invalidateForUser(userId);
    return created;
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
