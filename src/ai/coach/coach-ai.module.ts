import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnthropicAdapter } from '../adapters/anthropic.adapter';
import { ClientContextService } from '../context/client-context.service';
import { CoachAIController } from './coach-ai.controller';
import { CoachAIService } from './coach-ai.service';
import { CoachAIStateService } from './coach-ai-state.service';
import { WeeklyInsightCron } from './weekly-insight.cron';
import { AuthModule } from '../../auth/auth.module';
import { BillingModule } from '../../billing/billing.module';
import { MealPlansModule } from '../../meal-plans/meal-plans.module';
import { WorkoutBuilderModule } from '../../workout-builder/workout-builder.module';
// Stream 2 — coach-side gateway-backed AI execution endpoints.
import { CoachAIExecutionController } from './coach-ai-execution.controller';
import { RomanModule } from '../../roman/roman.module';
import { RomanConsentService } from '../../roman/consent/roman-consent.service';
import { AI_SUBJECT_CONSENT_GATE } from '../adapters/ai-subject-consent.gate';

// Coach AI v1 module.
//
// @Global so AnthropicAdapter and CoachAIStateService can be injected
// by sibling AI modules (e.g. AiService for the chat fallback rewire)
// without re-importing this module everywhere.
@Global()
@Module({
  // RomanModule supplies RomanConsentService, bound here as the data-subject
  // consent gate the AnthropicAdapter consults before every client-data
  // request (R2 / Sol A2). RomanModule imports nothing, so no cycle.
  imports: [
    ConfigModule,
    AuthModule,
    BillingModule,
    MealPlansModule,
    WorkoutBuilderModule,
    RomanModule,
  ],
  controllers: [CoachAIController, CoachAIExecutionController],
  providers: [
    { provide: AI_SUBJECT_CONSENT_GATE, useExisting: RomanConsentService },
    AnthropicAdapter,
    ClientContextService,
    CoachAIStateService,
    CoachAIService,
    WeeklyInsightCron,
  ],
  exports: [AnthropicAdapter, ClientContextService, CoachAIStateService, CoachAIService],
})
export class CoachAIModule {}
