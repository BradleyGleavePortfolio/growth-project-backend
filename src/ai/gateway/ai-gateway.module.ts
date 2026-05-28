import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MessagingModule } from '../../messaging/messaging.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { AiGatewayController } from './ai-gateway.controller';
import { AiGatewayService } from './ai-gateway.service';
import { AiGatewayConfig } from './ai-gateway.config';
import { AiRedactionService } from './ai-redaction.service';
import { AiApprovalService } from './ai-approval.service';
import { PrivateContextService } from './private-context.service';
import { AiProviderRegistry } from './providers/provider-registry';
import { StubProviderAdapter } from './providers/stub-provider.adapter';
import { AnthropicProviderAdapter } from './providers/anthropic-provider.adapter';
import {
  CAPABILITY_MATERIALIZERS,
  CapabilityMaterializerRegistry,
} from './materialisers/capability-materialiser.registry';
import { CoachMessageMaterializer } from './materialisers/coach-message.materialiser';
// Stream 2 — AI execution capability materialisers.
import { AssignWorkoutMaterializer } from './materialisers/assign-workout.materialiser';
import { AssignMealPlanMaterializer } from './materialisers/assign-meal-plan.materialiser';
import { SendNotificationMaterializer } from './materialisers/send-notification.materialiser';

// @Global so feature services (coach messaging, meal-plan AI suggestions,
// finance proof drafts, …) can inject AiGatewayService without first
// importing this module from every feature module.
//
// AuditModule + PrismaModule are already global; AuthModule is imported
// because the controller relies on JwtAuthGuard / RolesGuard wiring.
// PR AI-3 (PRODUCT-1): MessagingModule is imported so the
// CoachMessageMaterializer can inject MessagingService and complete the
// approval -> send loop that was previously silently broken. There is no
// circular dependency: MessagingModule depends on AiModule (not
// AiGatewayModule), and AiGatewayModule does not feed any provider that
// MessagingModule consumes.
@Global()
@Module({
  // Stream 2 — NotificationsModule supplies NotificationsService for the
  // new materialisers (assign_workout, assign_meal_plan dispatch pushes
  // through it). send_notification writes Notification rows directly via
  // Prisma so it does NOT need the service, but the others do.
  imports: [AuthModule, MessagingModule, NotificationsModule],
  controllers: [AiGatewayController],
  providers: [
    AiGatewayConfig,
    AiRedactionService,
    StubProviderAdapter,
    // Coach AI v1 — real Claude Sonnet adapter for the gateway path.
    // CoachAIModule is @Global so it can inject AnthropicAdapter +
    // CoachAIStateService into this provider.
    AnthropicProviderAdapter,
    AiProviderRegistry,
    PrivateContextService,
    AiGatewayService,
    AiApprovalService,
    // PR AI-3 (PRODUCT-1): capability materialisation registry. Each
    // materialiser is provided as a concrete class AND as an entry in the
    // multi-injection array bound to CAPABILITY_MATERIALIZERS; the registry
    // pulls the array out and dispatches by capability string.
    CoachMessageMaterializer,
    // Stream 2 — AI execution capabilities. Each is registered as a
    // concrete provider AND added to CAPABILITY_MATERIALIZERS so the
    // registry can resolve by capability string. Mirrors the round-1
    // pattern used for CoachMessageMaterializer.
    AssignWorkoutMaterializer,
    AssignMealPlanMaterializer,
    SendNotificationMaterializer,
    {
      provide: CAPABILITY_MATERIALIZERS,
      useFactory: (
        coachMessage: CoachMessageMaterializer,
        assignWorkout: AssignWorkoutMaterializer,
        assignMealPlan: AssignMealPlanMaterializer,
        sendNotification: SendNotificationMaterializer,
      ) => [coachMessage, assignWorkout, assignMealPlan, sendNotification],
      inject: [
        CoachMessageMaterializer,
        AssignWorkoutMaterializer,
        AssignMealPlanMaterializer,
        SendNotificationMaterializer,
      ],
    },
    CapabilityMaterializerRegistry,
  ],
  exports: [
    AiGatewayService,
    AiApprovalService,
    AiGatewayConfig,
    AiRedactionService,
    PrivateContextService,
    CapabilityMaterializerRegistry,
  ],
})
export class AiGatewayModule {}
