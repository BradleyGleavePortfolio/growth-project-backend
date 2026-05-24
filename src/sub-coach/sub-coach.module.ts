import { Module } from '@nestjs/common';
import { SubCoachController } from './sub-coach.controller';
import { SubCoachAssignmentService } from './sub-coach-assignment.service';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachReassignService } from './sub-coach-reassign.service';
import { SubCoachIdempotencyService } from './sub-coach-idempotency.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

/**
 * SubCoachModule
 *
 * Provides the full sub-coach management surface: roster listing, capacity
 * enforcement, engagement analytics, idempotent mutation handling, and
 * atomic client reassignment.
 *
 * Depends on:
 *   - PrismaModule   (global — no explicit import needed)
 *   - AuditModule    — SubCoachReassignService writes audit logs
 *   - AuthModule     — JwtAuthGuard + CoachGuard
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SubCoachController],
  providers: [
    SubCoachAssignmentService,
    SubCoachAnalyticsService,
    SubCoachCapacityService,
    SubCoachReassignService,
    SubCoachIdempotencyService,
  ],
  exports: [
    SubCoachAssignmentService,
    SubCoachAnalyticsService,
    SubCoachCapacityService,
    SubCoachReassignService,
    SubCoachIdempotencyService,
  ],
})
export class SubCoachModule {}
