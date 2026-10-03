// src/coach/brief/coach-brief.module.ts
//
// R43 Coach Brief — daily AI-generated dispatch for coaches. Wires the
// controller + services + cron scheduler under /coach/brief/*.

import { Module } from '@nestjs/common';
import { CoachBriefController } from './coach-brief.controller';
import { CoachBriefService } from './coach-brief.service';
import { CoachBriefPreferencesService } from './coach-brief-preferences.service';
import { CoachDailyLogService } from './coach-daily-log.service';
import { CoachBriefScheduler } from './coach-brief.scheduler';
import { CoachBriefEnabledGuard } from './coach-brief-enabled.guard';
import { RomanDraftsController } from './roman/roman-drafts.controller';
import { RomanReplyDraftsService } from './roman/roman-reply-drafts.service';
import { RomanBriefFlagGuard } from './roman/roman-brief-flag.guard';
import { PrismaService } from '../../prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { NotificationsModule } from '../../notifications/notifications.module';

@Module({
  imports: [AuthModule, NotificationsModule],
  // A5-COACH-BRIEF — RomanDraftsController serves /coach/brief/drafts/*
  // (no overlap with the brief routes; flag-gated by RomanBriefFlagGuard).
  controllers: [CoachBriefController, RomanDraftsController],
  providers: [
    PrismaService,
    CoachBriefService,
    CoachBriefPreferencesService,
    CoachDailyLogService,
    CoachBriefScheduler,
    CoachBriefEnabledGuard,
    RomanReplyDraftsService,
    RomanBriefFlagGuard,
  ],
  exports: [CoachBriefService],
})
export class CoachBriefModule {}
