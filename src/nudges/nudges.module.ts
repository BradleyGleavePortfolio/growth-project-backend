import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { ClientNudgesController } from './client-nudges.controller';
import { CoachNudgesController } from './coach-nudges.controller';
import { NudgesService } from './nudges.service';
import { NotificationsModule } from '../notifications/notifications.module';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows the same pattern as
// MessagingModule and InviteCodesModule — keeps this module independent of
// AuthModule's controller/provider graph and avoids the circular-import risk.
// NUDGE-REACH-BE: NotificationsModule for the nudge's push (NudgesService).
@Module({
  imports: [NotificationsModule],
  controllers: [CoachNudgesController, ClientNudgesController],
  providers: [NudgesService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [NudgesService],
})
export class NudgesModule {}
