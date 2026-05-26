// src/coach/brief/coach-daily-log.service.ts
//
// CoachDailyLogService — owner of CoachDailyLog reads + upserts.
// One log per (coach_id, log_date). Upserts use the named unique
// constraint so concurrent writes converge.

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  CoachDailyLogResponse,
  EmptyDailyLogResponse,
  LogHistoryResponse,
} from './coach-brief.types';
import { bucketDateLocal } from './coach-brief.service';

@Injectable()
export class CoachDailyLogService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCoachTimezone(coachId: string): Promise<string> {
    const prefs = await this.prisma.coachBriefPreferences.findUnique({
      where: { coach_id: coachId },
      select: { timezone: true },
    });
    return prefs?.timezone ?? 'America/Los_Angeles';
  }

  async getTodaysLog(
    coachId: string,
  ): Promise<CoachDailyLogResponse | EmptyDailyLogResponse> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const logDate = bucketDateLocal(new Date(), timezone);

    const row = await this.prisma.coachDailyLog.findUnique({
      where: {
        CoachDailyLog_coach_log_date_key: {
          coach_id: coachId,
          log_date: logDate,
        },
      },
    });
    if (!row) {
      return {
        coach_id: coachId,
        log_date: logDate,
        content: '',
        exists: false,
      };
    }
    return this.toResponse(row);
  }

  async upsertTodaysLog(
    coachId: string,
    content: string,
  ): Promise<CoachDailyLogResponse> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const logDate = bucketDateLocal(new Date(), timezone);

    const row = await this.prisma.coachDailyLog.upsert({
      where: {
        CoachDailyLog_coach_log_date_key: {
          coach_id: coachId,
          log_date: logDate,
        },
      },
      create: { coach_id: coachId, log_date: logDate, content },
      update: { content },
    });
    return this.toResponse(row);
  }

  async getLogHistory(
    coachId: string,
    page: number,
    limit: number,
  ): Promise<LogHistoryResponse> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoff = bucketDateLocal(thirtyDaysAgo, timezone);

    const where: Prisma.CoachDailyLogWhereInput = {
      coach_id: coachId,
      log_date: { gte: cutoff },
    };

    const [total, rows] = await Promise.all([
      this.prisma.coachDailyLog.count({ where }),
      this.prisma.coachDailyLog.findMany({
        where,
        orderBy: { log_date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((r) => this.toResponse(r)),
      total,
      page,
      limit,
    };
  }

  private toResponse(row: {
    id: string;
    coach_id: string;
    log_date: string;
    content: string;
    created_at: Date;
    updated_at: Date;
  }): CoachDailyLogResponse {
    return {
      id: row.id,
      coach_id: row.coach_id,
      log_date: row.log_date,
      content: row.content,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
