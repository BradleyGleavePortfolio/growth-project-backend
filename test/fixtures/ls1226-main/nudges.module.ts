// LS-1226 baseline snapshot: main 1bef2db66111c9e4bf8acd39d4159a114a7bccd5.
// Only import paths are relocated for the independent contract proof.
import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../../src/auth/auth.guard';
import { CoachGuard } from '../../../src/auth/coach.guard';
import { JwksVerifierService } from '../../../src/auth/jwks.service';
import { ClientNudgesController } from '../../../src/nudges/client-nudges.controller';
import { CoachNudgesController } from '../../../src/nudges/coach-nudges.controller';
import { NudgesService } from './nudges.service';

// PrismaService / SupabaseService are provided globally. Providing the guards
// locally (rather than `imports: [AuthModule]`) follows the same pattern as
// MessagingModule and InviteCodesModule — keeps this module independent of
// AuthModule's controller/provider graph and avoids the circular-import risk.
@Module({
  controllers: [CoachNudgesController, ClientNudgesController],
  providers: [NudgesService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [NudgesService],
})
export class NudgesModule {}
