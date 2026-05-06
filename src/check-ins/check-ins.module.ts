import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { CheckInsService } from './check-ins.service';
import { ClientCheckInsController } from './client-check-ins.controller';
import { CoachCheckInsController } from './coach-check-ins.controller';
import { CoachModule } from '../coach/coach.module';

// PrismaService / SupabaseService are provided globally. Guards provided
// locally, matching the NudgesModule / MessagingModule pattern.
//
// Phase 6B: CoachModule imported so CheckInsService can inject
// CoachAlertsService for the consecutive_misses and streak_dropped alert
// emitters. CoachModule exports CoachAlertsService.
@Module({
  imports: [CoachModule],
  controllers: [ClientCheckInsController, CoachCheckInsController],
  providers: [CheckInsService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [CheckInsService],
})
export class CheckInsModule {}
