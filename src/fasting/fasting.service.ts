import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { StartFastDto } from './fasting.dto';

@Injectable()
export class FastingService {
  constructor(
    private prisma: PrismaService,
    // M2 — bust the AI context cache after fasting events.
    private aiContext: ClientAIContextService,
  ) {}

  async startFast(userId: string, data: StartFastDto) {
    // Check no active fast
    const active = await this.prisma.fastingWindow.findFirst({
      where: { user_id: userId, end_time: null },
    });
    if (active) throw new BadRequestException('A fast is already in progress');

    const created = await this.prisma.fastingWindow.create({
      data: { user_id: userId, start_time: new Date(), protocol: data.protocol, notes: data.notes },
    });
    // M2 — bust AI context cache so next chat sees the active fast.
    this.aiContext.invalidateForUser(userId);
    return created;
  }

  async endFast(userId: string, notes?: string) {
    const active = await this.prisma.fastingWindow.findFirst({
      where: { user_id: userId, end_time: null },
      orderBy: { start_time: 'desc' },
    });
    if (!active) throw new BadRequestException('No active fast found');

    const updated = await this.prisma.fastingWindow.update({
      where: { id: active.id },
      data: { end_time: new Date(), notes: notes || active.notes },
    });
    // M2 — bust AI context cache so next chat sees the completed fast.
    this.aiContext.invalidateForUser(userId);
    return updated;
  }

  async getHistory(userId: string, limit = 10) {
    return this.prisma.fastingWindow.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' },
      take: limit,
    });
  }
}
