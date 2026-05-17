import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';
import { ClientMessagingController } from './client-messaging.controller';
import { CoachMessagingController } from './coach-messaging.controller';
import { MessagingService } from './messaging.service';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows the same pattern as
// InviteCodesModule — keeps this module independent of AuthModule's
// controller/provider graph and avoids the circular-import risk.
//
// NotificationsModule is imported so MessagingService can inject
// MessageReceivedEmitter and fire push notifications on every send. AuditModule
// is imported so OWNER-initiated sends/reads can be recorded.
// AiModule imported so MessagingService can call
// ClientAIContextService.invalidateForUser when a coach message is sent
// (M2 — bust the client's AI context cache).
@Module({
  imports: [NotificationsModule, AuditModule, AiModule],
  controllers: [CoachMessagingController, ClientMessagingController],
  providers: [MessagingService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [MessagingService],
})
export class MessagingModule {}
