// src/coach/brief/coach-brief-preferences.service.ts
//
// CoachBriefPreferencesService — per-coach notification time + timezone +
// opt-in. The scheduler reads enabled rows once per minute; the
// controller reads + upserts via PUT /coach/brief/preferences.
//
// GET returns the row when present, or a defaults stub when absent. We do
// NOT auto-create on GET — mobile may render defaults without persisting
// any DB row until the coach explicitly saves.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CoachBriefPreferencesResponse } from './coach-brief.types';

// R43 / A5-P1-1 — the operator-locked default is "05:00". Decacorn-grade
// fitness coaches start their day before clients hit the gym; a 07:00
// brief lands after the first session is already underway. The constant,
// the Prisma schema (@default), and the SQL migration MUST agree on this
// literal — see test/invariants/locked_defaults.spec.ts which enforces
// the three-way agreement at every CI run (R51).
const DEFAULT_NOTIFICATION_TIME = '05:00';
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

@Injectable()
export class CoachBriefPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrDefault(coachId: string): Promise<CoachBriefPreferencesResponse> {
    const row = await this.prisma.coachBriefPreferences.findUnique({
      where: { coach_id: coachId },
    });
    if (!row) {
      return {
        coach_id: coachId,
        notification_time: DEFAULT_NOTIFICATION_TIME,
        timezone: DEFAULT_TIMEZONE,
        enabled: true,
        created_at: null,
        updated_at: null,
      };
    }
    return this.toResponse(row);
  }

  async upsert(
    coachId: string,
    patch: {
      notification_time?: string;
      timezone?: string;
      enabled?: boolean;
    },
  ): Promise<CoachBriefPreferencesResponse> {
    const row = await this.prisma.coachBriefPreferences.upsert({
      where: { coach_id: coachId },
      create: {
        coach_id: coachId,
        notification_time: patch.notification_time ?? DEFAULT_NOTIFICATION_TIME,
        timezone: patch.timezone ?? DEFAULT_TIMEZONE,
        enabled: patch.enabled ?? true,
      },
      update: {
        ...(patch.notification_time !== undefined && {
          notification_time: patch.notification_time,
        }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      },
    });
    return this.toResponse(row);
  }

  private toResponse(row: {
    coach_id: string;
    notification_time: string;
    timezone: string;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
  }): CoachBriefPreferencesResponse {
    return {
      coach_id: row.coach_id,
      notification_time: row.notification_time,
      timezone: row.timezone,
      enabled: row.enabled,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
