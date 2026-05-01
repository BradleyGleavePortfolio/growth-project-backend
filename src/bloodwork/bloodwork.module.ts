import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { BloodworkService } from './bloodwork.service';
import { BloodworkStaleScheduler } from './bloodwork-stale.scheduler';
import { ClientBloodworkController } from './client-bloodwork.controller';
import { CoachBloodworkController } from './coach-bloodwork.controller';

// PrismaService, AuditService, and ConsentService are global. Guards are
// provided locally, mirroring the CheckInsModule wiring.
@Module({
  controllers: [ClientBloodworkController, CoachBloodworkController],
  providers: [
    BloodworkService,
    BloodworkStaleScheduler,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [BloodworkService],
})
export class BloodworkModule {}
