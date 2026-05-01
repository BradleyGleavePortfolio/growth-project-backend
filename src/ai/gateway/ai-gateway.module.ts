import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AiGatewayController } from './ai-gateway.controller';
import { AiGatewayService } from './ai-gateway.service';
import { AiGatewayConfig } from './ai-gateway.config';
import { AiRedactionService } from './ai-redaction.service';
import { AiApprovalService } from './ai-approval.service';
import { PrivateContextService } from './private-context.service';
import { AiProviderRegistry } from './providers/provider-registry';
import { StubProviderAdapter } from './providers/stub-provider.adapter';

// @Global so feature services (coach messaging, meal-plan AI suggestions,
// finance proof drafts, …) can inject AiGatewayService without first
// importing this module from every feature module.
//
// AuditModule + PrismaModule are already global; AuthModule is imported
// because the controller relies on JwtAuthGuard / RolesGuard wiring.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AiGatewayController],
  providers: [
    AiGatewayConfig,
    AiRedactionService,
    StubProviderAdapter,
    AiProviderRegistry,
    PrivateContextService,
    AiGatewayService,
    AiApprovalService,
  ],
  exports: [
    AiGatewayService,
    AiApprovalService,
    AiGatewayConfig,
    AiRedactionService,
    PrivateContextService,
  ],
})
export class AiGatewayModule {}
