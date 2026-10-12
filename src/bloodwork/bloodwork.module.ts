import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { BloodworkService } from './bloodwork.service';
import { BloodworkStaleScheduler } from './bloodwork-stale.scheduler';

// PrismaService, AuditService, and ConsentService are global. Guards are
// provided locally, mirroring the CheckInsModule wiring.
@Module({
  // Routes off until Secure Form Submission (tgp-agent-context planning/V1_1_MUST_DO.md section 1).
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
