import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class FastingService {
  constructor(private prisma: PrismaService) {}

  async startFast(userId: string, data: { protocol?: string; notes?: string }) {
    // Check no active fast
    const active = await this.prisma.fastingWindow.findFirst({
      where: { user_id: userId, end_time: null },
    });
    if (active) throw new BadRequestException('A fast is already in progress');

    return this.prisma.fastingWindow.create({
      data: { user_id: userId, start_time: new Date(), protocol: data.protocol, notes: data.notes },
    });
  }

  async endFast(userId: string, notes?: string) {
    const active = await this.prisma.fastingWindow.findFirst({
      where: { user_id: userId, end_time: null },
      orderBy: { start_time: 'desc' },
    });
    if (!active) throw new BadRequestException('No active fast found');

    return this.prisma.fastingWindow.update({
      where: { id: active.id },
      data: { end_time: new Date(), notes: notes || active.notes },
    });
  }

  async getHistory(userId: string, limit = 10) {
    return this.prisma.fastingWindow.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' },
      take: limit,
    });
  }
}
