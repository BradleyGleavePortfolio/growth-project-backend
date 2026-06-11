import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { AnalyticsModule } from '../../analytics/analytics.module';
import { EmailModule } from '../../email/email.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { VoiceModule } from '../../roman/voice/voice.module';
import { DunningEscalationClassifier } from './dunning-escalation.classifier';
import { DunningLockoutGuard } from './dunning-lockout.guard';
import { DunningLockoutScheduler } from './dunning-lockout.scheduler';
import { DunningV2Dispatcher } from './dunning-v2.dispatcher';
import { DunningV2Renderer } from './dunning-v2.renderer';
import { DunningV2Service } from './dunning-v2.service';
import { DunningV2Telemetry } from './dunning-v2.telemetry';

/**
 * B3 Smart Dunning v2 module (spec PR #6).
 *
 * Wires the v2 gap services ALONGSIDE the v1 CheckoutModule — it does not
 * touch v1 wiring. Everything it provides is a no-op while FEATURE_DUNNING_V2
 * is OFF (the services and guard check the flag internally), so importing this
 * module in app.module is safe ahead of the operator flip: no v2 surface fires
 * until the flag is `true`.
 *
 * Exports the guard + service + dispatcher so the webhook handler shim
 * (recovery / late-reversal) and any controller that wants the lockout guard
 * can consume them.
 */
@Module({
  // Phase 2: VoiceModule supplies VoicePolicyService so the dispatcher routes
  // the Day 0/1/3/7 in-app client copy through the Roman Option-3 source of
  // truth (FEATURE_ROMAN_COPY_V2-gated; no-op while OFF).
  imports: [AnalyticsModule, EmailModule, NotificationsModule, VoiceModule],
  providers: [
    PrismaService,
    DunningEscalationClassifier,
    DunningV2Renderer,
    DunningV2Telemetry,
    DunningV2Service,
    DunningV2Dispatcher,
    DunningLockoutGuard,
    DunningLockoutScheduler,
  ],
  exports: [
    DunningV2Service,
    DunningV2Dispatcher,
    DunningEscalationClassifier,
    DunningV2Renderer,
    DunningV2Telemetry,
    DunningLockoutGuard,
  ],
})
export class DunningV2Module {}
