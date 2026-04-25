import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { CheckInsService } from './check-ins.service';
import { ClientCheckInsController } from './client-check-ins.controller';
import { CoachCheckInsController } from './coach-check-ins.controller';

// PrismaService / SupabaseService are provided globally. Guards provided
// locally, matching the NudgesModule / MessagingModule pattern.
@Module({
  controllers: [ClientCheckInsController, CoachCheckInsController],
  providers: [CheckInsService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [CheckInsService],
})
export class CheckInsModule {}
