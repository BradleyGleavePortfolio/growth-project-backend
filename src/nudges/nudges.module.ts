import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ClientNudgesController } from './client-nudges.controller';
import { CoachNudgesController } from './coach-nudges.controller';
import { NudgesService } from './nudges.service';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows the same pattern as
// MessagingModule and InviteCodesModule — keeps this module independent of
// AuthModule's controller/provider graph and avoids the circular-import risk.
@Module({
  controllers: [CoachNudgesController, ClientNudgesController],
  providers: [NudgesService, JwtAuthGuard, CoachGuard],
  exports: [NudgesService],
})
export class NudgesModule {}
