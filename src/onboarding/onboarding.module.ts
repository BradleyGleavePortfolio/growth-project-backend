/**
 * OnboardingModule — R51 first-client nudge engine.
 *
 * Wires:
 *   - OnboardingNudgeService     — milestone detection, send pipeline.
 *   - OnboardingNudgeScheduler   — minute-tick cron (test=skipped via NODE_ENV).
 *   - OnboardingController       — coach-facing GET state + opt-out + share-templates.
 *
 * EmailService + NotificationsService are @Global (PrismaModule too),
 * so no explicit imports needed for those.  AnalyticsService is not
 * consumed yet — the analytics event for "first paid client within N
 * days" is owned by upstream payment code that calls
 * service.markFirstClient.
 */

import { Module } from '@nestjs/common';
import { OnboardingNudgeService } from './onboarding-nudge.service';
import { OnboardingNudgeScheduler } from './onboarding-nudge.scheduler';
import { OnboardingController } from './onboarding.controller';

@Module({
  controllers: [OnboardingController],
  providers: [OnboardingNudgeService, OnboardingNudgeScheduler],
  exports: [OnboardingNudgeService],
})
export class OnboardingModule {}
