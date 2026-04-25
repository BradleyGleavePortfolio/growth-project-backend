import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { ClientMessagingController } from './client-messaging.controller';
import { CoachMessagingController } from './coach-messaging.controller';
import { MessagingService } from './messaging.service';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows the same pattern as
// InviteCodesModule — keeps this module independent of AuthModule's
// controller/provider graph and avoids the circular-import risk.
@Module({
  controllers: [CoachMessagingController, ClientMessagingController],
  providers: [MessagingService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [MessagingService],
})
export class MessagingModule {}
