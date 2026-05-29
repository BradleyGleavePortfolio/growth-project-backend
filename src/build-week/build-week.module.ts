import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PackagesModule } from '../packages/packages.module';
import { BuildWeekController } from './build-week.controller';
import { CoachBuildWeekController } from './coach-build-week.controller';
import { BuildWeekService } from './build-week.service';

// Phase 4 — Build Week module.
//
// PrismaService comes from the global PrismaModule (see app.module.ts).
// AuditService comes from the global AuditModule. PtmService comes from
// the global PtmModule. We only need to import AuthModule here for the
// JwtAuthGuard / CoachGuard wiring, matching the LessonsModule pattern.
//
// PR-11 — PackagesModule import wires MilestoneService into the build-
// week completion path so a 7-day finish emits the
// 'build_week_complete' milestone, firing any matching on_milestone
// drip drops the buyer has waiting. PackagesModule does NOT transitively
// import BuildWeekModule (its only import is NotificationsModule), so
// this introduces no new cycle.
@Module({
  imports: [AuthModule, PackagesModule],
  controllers: [BuildWeekController, CoachBuildWeekController],
  providers: [BuildWeekService],
  exports: [BuildWeekService],
})
export class BuildWeekModule {}
