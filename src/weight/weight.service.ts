import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { saveOnce } from '../common/save-once';
import { LogWeightDto, UpdateWeightDto } from './weight.dto';

const WEIGH_IN_NOT_FOUND = 'Weigh-in not found.';

type NewWeighIn = Pick<Prisma.WeightLogUncheckedCreateInput, 'user_id' | 'date' | 'weight_lbs' | 'notes'>;

@Injectable()
export class WeightService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
    // M2 — bust the AI context cache after weight writes.
    private aiContext: ClientAIContextService,
  ) {}

  async logWeight(userId: string, data: LogWeightDto) {
    // WATER-WEIGHT-KEYS-BE: no key is a plain create, as before, and its answer
    // keeps its shape (the new column is left out). With a key, a resend
    // answers with the first row and stores nothing, so it emits no second
    // 'weight_logged' and busts nothing; another member's key is a 404
    // (src/common/save-once.ts).
    const key = data.client_uuid;
    if (!key) {
      return this.createWeight(userId, data, (row) =>
        this.prisma.weightLog.create({ data: row, omit: { client_uuid: true } }),
      );
    }
    return saveOnce(
      userId,
      () => this.prisma.weightLog.findUnique({ where: { client_uuid: key } }),
      () => this.createWeight(userId, data, (row) => this.prisma.weightLog.create({ data: { ...row, client_uuid: key } })),
    );
  }

  // One new weigh-in and its effects, which run only after `insert` succeeds.
  private async createWeight<T>(userId: string, data: LogWeightDto, insert: (row: NewWeighIn) => Promise<T>) {
    const prior = await this.prisma.weightLog.findFirst({
      where: { user_id: userId },
      orderBy: { date: 'desc' },
      select: { weight_lbs: true },
    });
    const created = await insert({
      user_id: userId,
      date: data.date ? new Date(data.date) : new Date(),
      weight_lbs: data.weight_lbs,
      notes: data.notes,
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

  // Edit and delete write with `where: { id, user_id }`: a weigh-in that is not
  // the caller's matches no row, so it answers 404 and is never changed.
  async updateWeight(userId: string, id: string, data: UpdateWeightDto) {
    if (data.weight_lbs === undefined && data.notes === undefined) {
      throw new BadRequestException('Send weight_lbs or notes to change a weigh-in.');
    }
    const { count } = await this.prisma.weightLog.updateMany({
      where: { id, user_id: userId },
      data: { weight_lbs: data.weight_lbs, notes: data.notes },
    });
    if (count === 0) throw new NotFoundException(WEIGH_IN_NOT_FOUND);
    // Bust the AI context cache so the next chat sees the corrected weight.
    this.aiContext.invalidateForUser(userId);
    return this.prisma.weightLog.findFirst({ where: { id, user_id: userId } });
  }

  async deleteWeight(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.weightLog.deleteMany({ where: { id, user_id: userId } });
    if (count === 0) throw new NotFoundException(WEIGH_IN_NOT_FOUND);
    this.aiContext.invalidateForUser(userId);
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
