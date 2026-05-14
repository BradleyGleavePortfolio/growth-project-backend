import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnthropicAdapter } from '../adapters/anthropic.adapter';
import { ClientContextService } from '../context/client-context.service';
import { CoachAIController } from './coach-ai.controller';
import { CoachAIService } from './coach-ai.service';
import { CoachAIStateService } from './coach-ai-state.service';
import { WeeklyInsightCron } from './weekly-insight.cron';
import { AuthModule } from '../../auth/auth.module';
import { MealPlansModule } from '../../meal-plans/meal-plans.module';
import { WorkoutBuilderModule } from '../../workout-builder/workout-builder.module';

// Coach AI v1 module.
//
// @Global so AnthropicAdapter and CoachAIStateService can be injected
// by sibling AI modules (e.g. AiService for the chat fallback rewire)
// without re-importing this module everywhere.
@Global()
@Module({
  imports: [ConfigModule, AuthModule, MealPlansModule, WorkoutBuilderModule],
  controllers: [CoachAIController],
  providers: [
    AnthropicAdapter,
    ClientContextService,
    CoachAIStateService,
    CoachAIService,
    WeeklyInsightCron,
  ],
  exports: [AnthropicAdapter, ClientContextService, CoachAIStateService, CoachAIService],
})
export class CoachAIModule {}
