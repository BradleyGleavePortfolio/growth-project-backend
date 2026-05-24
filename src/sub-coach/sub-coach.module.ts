import { Global, Module } from '@nestjs/common';
import { SubCoachController } from './sub-coach.controller';
import { SubCoachAssignmentService } from './sub-coach-assignment.service';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachReassignService } from './sub-coach-reassign.service';
import { SubCoachIdempotencyService } from './sub-coach-idempotency.service';
import { SubCoachScopeService } from './sub-coach-scope.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

/**
 * SubCoachModule
 *
 * Provides the full sub-coach management surface: roster listing, capacity
 * enforcement, engagement analytics, idempotent mutation handling, and
 * atomic client reassignment.
 *
 * @Global so SubCoachScopeService can be injected into coach/messaging/v1
 * services without each importing this module — that helper is the single
 * source of truth for "which clients can this coach see" and needs to be
 * reachable everywhere.
 *
 * Depends on:
 *   - PrismaModule   (global — no explicit import needed)
 *   - AuditModule    — SubCoachReassignService writes audit logs
 *   - AuthModule     — JwtAuthGuard + CoachGuard
 */
@Global()
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SubCoachController],
  providers: [
    SubCoachAssignmentService,
    SubCoachAnalyticsService,
    SubCoachCapacityService,
    SubCoachReassignService,
    SubCoachIdempotencyService,
    SubCoachScopeService,
  ],
  exports: [
    SubCoachAssignmentService,
    SubCoachAnalyticsService,
    SubCoachCapacityService,
    SubCoachReassignService,
    SubCoachIdempotencyService,
    SubCoachScopeService,
  ],
})
export class SubCoachModule {}
