import { Module } from '@nestjs/common';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';

/**
 * TimelineModule — Phase 7B.
 *
 * Self-contained NestJS module. Depends on PrismaModule (global) only.
 * No new Prisma migrations are required — all data is derived at query
 * time from existing tables:
 *   WeightLog, ClientSignal, CoachMessage, BuildWeekEnrollment.
 *
 * Registered in AppModule via `TimelineModule` import.
 */
@Module({
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
