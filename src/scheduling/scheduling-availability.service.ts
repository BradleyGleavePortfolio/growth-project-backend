import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type {
  CreateAvailabilityOverrideDto,
  UpdateAvailabilityOverrideDto,
} from './dto/scheduling.dto';
import { validateOverridePayload } from './dto/scheduling.dto';
import { minutesToHHMM } from './scheduling.types';
import type { ActorContext } from './scheduling.types';

// ---------------- Coach availability overrides — CRUD ----------------
// Pulled out of SchedulingService during the M9 refactor. The
// behaviour, validation, and refusal envelopes match the pre-split
// code exactly.
@Injectable()
export class SchedulingAvailabilityService {
  private readonly logger = new Logger(SchedulingAvailabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listMyAvailabilityOverrides(
    actor: ActorContext,
    args: { from?: string; to?: string },
  ) {
    // Only coaches and owners list their own overrides. A student has
    // no business reading override notes (note may be private).
    if (actor.role !== 'coach' && actor.role !== 'owner') {
      throw new ForbiddenException(
        'Only coaches may list their availability overrides',
      );
    }
    const where: Prisma.CoachAvailabilityOverrideWhereInput = {
      coach_id: actor.id,
    };
    if (args.from || args.to) {
      where.date = {};
      if (args.from) (where.date as Prisma.DateTimeFilter).gte = new Date(args.from);
      if (args.to) (where.date as Prisma.DateTimeFilter).lte = new Date(args.to);
    }
    return this.prisma.coachAvailabilityOverride.findMany({
      where,
      orderBy: [{ date: 'asc' }, { start_minute: 'asc' }],
    });
  }

  async createAvailabilityOverride(
    actor: ActorContext,
    dto: CreateAvailabilityOverrideDto,
  ) {
    if (actor.role !== 'coach' && actor.role !== 'owner') {
      throw new ForbiddenException(
        'Only coaches may create availability overrides',
      );
    }
    let validated: { minutes: { start: number | null; end: number | null } };
    try {
      validated = validateOverridePayload({
        kind: dto.kind,
        date: dto.date,
        start_time: dto.start_time ?? null,
        end_time: dto.end_time ?? null,
      });
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid override payload',
      );
    }
    return this.prisma.coachAvailabilityOverride.create({
      data: {
        coach_id: actor.id,
        date: new Date(`${dto.date}T00:00:00.000Z`),
        kind: dto.kind,
        start_minute: validated.minutes.start,
        end_minute: validated.minutes.end,
        note: dto.note ?? null,
      },
    });
  }

  async updateAvailabilityOverride(
    actor: ActorContext,
    id: string,
    dto: UpdateAvailabilityOverrideDto,
  ) {
    const existing = await this.prisma.coachAvailabilityOverride.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Override not found');
    if (actor.role !== 'owner' && existing.coach_id !== actor.id) {
      throw new ForbiddenException(
        'You can only update your own availability overrides',
      );
    }
    const mergedKind = dto.kind ?? (existing.kind as 'holiday' | 'block' | 'extra');
    const hasStart = dto.start_time !== undefined;
    const hasEnd = dto.end_time !== undefined;
    let startMin = existing.start_minute;
    let endMin = existing.end_minute;
    if (hasStart || hasEnd || dto.kind !== undefined) {
      try {
        const v = validateOverridePayload({
          kind: mergedKind,
          start_time: hasStart ? dto.start_time : minutesToHHMM(existing.start_minute),
          end_time: hasEnd ? dto.end_time : minutesToHHMM(existing.end_minute),
        });
        startMin = v.minutes.start;
        endMin = v.minutes.end;
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'Invalid override payload',
        );
      }
    }
    return this.prisma.coachAvailabilityOverride.update({
      where: { id },
      data: {
        kind: mergedKind,
        start_minute: startMin,
        end_minute: endMin,
        note: dto.note ?? existing.note,
      },
    });
  }

  async deleteAvailabilityOverride(actor: ActorContext, id: string) {
    const existing = await this.prisma.coachAvailabilityOverride.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Override not found');
    if (actor.role !== 'owner' && existing.coach_id !== actor.id) {
      throw new ForbiddenException(
        'You can only delete your own availability overrides',
      );
    }
    await this.prisma.coachAvailabilityOverride.delete({ where: { id } });
    return { ok: true };
  }
}
