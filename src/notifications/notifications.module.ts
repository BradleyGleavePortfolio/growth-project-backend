import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { DigestService } from './digest.service';
import { DigestScheduler } from './digest.scheduler';
import { AuthModule } from '../auth/auth.module';
import { MilestoneReachedEmitter } from './emitters/milestone-reached.emitter';
import { MessageReceivedEmitter } from './emitters/message-received.emitter';
import { MissedCheckinEmitter } from './emitters/missed-checkin.emitter';
import { WeightTrendAlertEmitter } from './emitters/weight-trend-alert.emitter';
import { CheckinSubmittedEmitter } from './emitters/checkin-submitted.emitter';
import { BuildWeekDayUnlockedEmitter } from './emitters/build-week-day-unlocked.emitter';
import { CoachAlertEmitter } from './emitters/coach-alert.emitter';

// PrismaService is provided globally via PrismaModule.
//
// Phase 6B: NotificationsService is exported so CoachModule can inject it
// into CoachAlertsService for push delivery. The export does not change
// the existing /notifications/* HTTP surface.
//
// Phase 9: All emitters + DigestService + DigestScheduler are also exported
// so other modules (check-ins, weight, build-week, messaging, PTM) can
// inject individual emitters without circular dependencies.
@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    DigestService,
    DigestScheduler,
    MilestoneReachedEmitter,
    MessageReceivedEmitter,
    MissedCheckinEmitter,
    WeightTrendAlertEmitter,
    CheckinSubmittedEmitter,
    BuildWeekDayUnlockedEmitter,
    CoachAlertEmitter,
  ],
  exports: [
    NotificationsService,
    DigestService,
    MilestoneReachedEmitter,
    MessageReceivedEmitter,
    MissedCheckinEmitter,
    WeightTrendAlertEmitter,
    CheckinSubmittedEmitter,
    BuildWeekDayUnlockedEmitter,
    CoachAlertEmitter,
  ],
})
export class NotificationsModule {}
