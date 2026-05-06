import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BuildWeekController } from './build-week.controller';
import { CoachBuildWeekController } from './coach-build-week.controller';
import { BuildWeekService } from './build-week.service';

// Phase 4 — Build Week module.
//
// PrismaService comes from the global PrismaModule (see app.module.ts).
// AuditService comes from the global AuditModule. PtmService comes from
// the global PtmModule. We only need to import AuthModule here for the
// JwtAuthGuard / CoachGuard wiring, matching the LessonsModule pattern.
@Module({
  imports: [AuthModule],
  controllers: [BuildWeekController, CoachBuildWeekController],
  providers: [BuildWeekService],
  exports: [BuildWeekService],
})
export class BuildWeekModule {}
