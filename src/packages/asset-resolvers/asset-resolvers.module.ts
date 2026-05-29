import { Global, Module } from '@nestjs/common';
import { MessagingModule } from '../../messaging/messaging.module';
import { WorkoutBuilderModule } from '../../workout-builder/workout-builder.module';
import { RealMealPlansModule } from '../../real-meal-plans/real-meal-plans.module';
import {
  ASSIGNABLE_ASSET_RESOLVERS,
  AssignableAssetResolverRegistry,
} from './assignable-asset-resolver.registry';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import { WorkoutAssetResolver } from './workout.resolver';
import { MealPlanAssetResolver } from './meal-plan.resolver';
import { AutoMessageAssetResolver } from './auto-message.resolver';
import { MediaAssetResolver } from './media-asset.resolver';

// PR-7 — wiring for the AssignableAssetResolver registry.
//
// Mirrors AiGatewayModule's CapabilityMaterializerRegistry wiring
// (src/ai/gateway/ai-gateway.module.ts:60-83):
//   - Each resolver is provided as a concrete class.
//   - A multi-provider entry under `ASSIGNABLE_ASSET_RESOLVERS` enumerates
//     them so the registry can iterate without importing each class.
//   - The registry itself is the public export.
//
// Imports:
//   - MessagingModule supplies MessagingService for auto_message.
//   - WorkoutBuilderModule supplies WorkoutBuilderService for workout_*.
//   - RealMealPlansModule supplies RealMealPlansService for meal_plan.
//   - SubCoachScopeService comes via the @Global SubCoachModule, so no
//     explicit import here.
//   - PrismaService comes via the global PrismaModule.
//
// Exports the registry + the ResolverSubCoachScope helper for downstream
// PRs (PR-9 fan-out, PR-10 drip cron, PR-12 media upload pipeline) to
// reuse without re-wiring.
//
// @Global so PR-9/PR-10/PR-12 can inject AssignableAssetResolverRegistry
// from anywhere (the drip cron lives outside the packages module). Also
// avoids creating a new module cycle: PackagesModule is itself imported
// transitively from AuthModule via the BillingModule chain, and routing
// the resolver wiring through PackagesModule would loop back through
// MessagingModule → AuditModule → AuthModule.

@Global()
@Module({
  imports: [MessagingModule, WorkoutBuilderModule, RealMealPlansModule],
  providers: [
    ResolverSubCoachScope,
    WorkoutAssetResolver,
    MealPlanAssetResolver,
    AutoMessageAssetResolver,
    MediaAssetResolver,
    {
      provide: ASSIGNABLE_ASSET_RESOLVERS,
      useFactory: (
        workout: WorkoutAssetResolver,
        mealPlan: MealPlanAssetResolver,
        autoMessage: AutoMessageAssetResolver,
        media: MediaAssetResolver,
      ) => [workout, mealPlan, autoMessage, media],
      inject: [
        WorkoutAssetResolver,
        MealPlanAssetResolver,
        AutoMessageAssetResolver,
        MediaAssetResolver,
      ],
    },
    AssignableAssetResolverRegistry,
  ],
  exports: [AssignableAssetResolverRegistry, ResolverSubCoachScope],
})
export class AssignableAssetResolversModule {}
