import { Module } from '@nestjs/common';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { AuthModule } from '../auth/auth.module';

/**
 * TimelineModule — Phase 7B.
 *
 * Self-contained NestJS module. Depends on PrismaModule (global) only.
 * No new Prisma migrations are required — all data is derived at query
 * time from existing tables:
 *   WeightLog, ClientSignal, CoachMessage, BuildWeekEnrollment.
 *
 * AuthModule imported so TimelineController can resolve JwtAuthGuard and
 * RolesGuard (added in Phase 10 role-gating hardening).
 *
 * Registered in AppModule via `TimelineModule` import.
 */
@Module({
  imports: [AuthModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
