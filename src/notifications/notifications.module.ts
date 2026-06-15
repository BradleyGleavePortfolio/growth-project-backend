import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { DigestService } from './digest.service';
import { DigestScheduler } from './digest.scheduler';
import { MilestoneReachedEmitter } from './emitters/milestone-reached.emitter';
import { MessageReceivedEmitter } from './emitters/message-received.emitter';
import { MissedCheckinEmitter } from './emitters/missed-checkin.emitter';
import { WeightTrendAlertEmitter } from './emitters/weight-trend-alert.emitter';
import { CheckinSubmittedEmitter } from './emitters/checkin-submitted.emitter';
import { BuildWeekDayUnlockedEmitter } from './emitters/build-week-day-unlocked.emitter';
import { CoachAlertEmitter } from './emitters/coach-alert.emitter';
import { BookingEmitter } from './emitters/booking.emitter';
// Roman P4 (Option C) — first-payment exactly-once primitive + emitter.
import { FirstPaymentEmitter } from './emitters/first-payment.emitter';
import { CoachFirstPaymentService } from './coach-first-payment.service';
// NUDGE-V1 — behavioral re-engagement subsystem.
import { NudgeEngineService } from './nudges/nudge-engine.service';
import { NudgeDetectorService } from './nudges/nudge-detector.service';
import { NudgeScheduler } from './nudges/nudge.scheduler';
// Phase 2: VoiceModule supplies VoicePolicyService for the empty-list copy.
// VoiceModule has no module dependencies, so it cannot reopen the documented
// BillingModule → CheckoutModule → NotificationsModule cycle.
import { VoiceModule } from '../roman/voice/voice.module';

// PrismaService is provided globally via PrismaModule.
//
// Phase 6B: NotificationsService is exported so CoachModule can inject it
// into CoachAlertsService for push delivery. The export does not change
// the existing /notifications/* HTTP surface.
//
// Phase 9: All emitters + DigestService + DigestScheduler are also exported
// so other modules (check-ins, weight, build-week, messaging, PTM) can
// inject individual emitters without circular dependencies.
//
// A276-P0-2 (refix) — AuthModule import removed. NotificationsController's
// `@UseGuards(JwtAuthGuard, RolesGuard)` resolves through the @Global
// SecurityGuardsModule (see src/common/security/security-guards.module.ts
// and the doc-comment in src/auth/auth.module.ts). NotificationsService
// itself has no AuthService dependency. Removing the stale AuthModule edge
// closes the BillingModule → CheckoutModule → NotificationsModule →
// AuthModule → InviteCodesModule → BillingModule cycle that the new
// CheckoutModule → NotificationsModule edge would otherwise open, and
// aligns NotificationsModule with the post-hotfix-#243 architecture that
// every other feature module already follows.
@Module({
  // NUDGE-V1: EmailService comes from the @Global EmailModule — no
  // import required. NudgeEngineService injects it as Optional.
  imports: [ConfigModule, VoiceModule],
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
    BookingEmitter,
    // Roman P4 (Option C) — exported below so CheckoutModule can inject the
    // service into the webhook handler (gated on FEATURE_ROMAN_FIRST_PAYMENT).
    FirstPaymentEmitter,
    CoachFirstPaymentService,
    // NUDGE-V1 providers.
    NudgeEngineService,
    NudgeDetectorService,
    NudgeScheduler,
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
    BookingEmitter,
    FirstPaymentEmitter,
    CoachFirstPaymentService,
    NudgeEngineService,
    NudgeDetectorService,
  ],
})
export class NotificationsModule {}
