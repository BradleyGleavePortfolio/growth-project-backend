import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';
// Apple 1.2 — MessagingService consults MessagesSafetyService to filter
// blocked senders out of list/unread responses and to suppress push fanout
// when either party has blocked the other.
import { MessagesSafetyModule } from '../messages-safety/messages-safety.module';
import { ClientMessagingController } from './client-messaging.controller';
import { CoachMessagingController } from './coach-messaging.controller';
import { MessagingService } from './messaging.service';
// v3-3: the signed-upload helper extracted out of MessagingService. Provided
// here so production DI injects the shared, typed provider into MessagingService
// (the @Optional ctor param). SupabaseService is global, so no extra import.
import { VoiceUploadProvider } from '../community/voice/voice-upload.provider';

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
  imports: [NotificationsModule, AuditModule, AiModule, MessagesSafetyModule],
  controllers: [CoachMessagingController, ClientMessagingController],
  providers: [
    MessagingService,
    VoiceUploadProvider,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
