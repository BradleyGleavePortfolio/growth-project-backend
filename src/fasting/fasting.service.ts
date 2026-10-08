import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
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

    let created;
    try {
      created = await this.prisma.fastingWindow.create({
        data: { user_id: userId, start_time: new Date(), protocol: data.protocol, notes: data.notes },
      });
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ error: 'FAST_ALREADY_ACTIVE', message: 'A fasting window is already active.' });
      }
      throw err;
    }
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

  // U10: delete one of the caller's own fasts (ended, or the one in progress
  // when it was started by mistake). The owner is part of the WHERE, so
  // another user's id (or a missing one) deletes nothing and gets the same 404.
  async deleteFast(userId: string, id: string): Promise<{ id: string; deleted: true }> {
    const { count } = await this.prisma.fastingWindow.deleteMany({
      where: { id, user_id: userId },
    });
    if (count === 0) throw new NotFoundException('Fast not found');
    // M2 — bust AI context cache so the next chat no longer sees the removed fast.
    this.aiContext.invalidateForUser(userId);
    return { id, deleted: true };
  }
}
