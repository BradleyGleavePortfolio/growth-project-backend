import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { TeamModule } from '../team/team.module';
import { SubCoachInvitesPublicController } from './sub-coach-invites-public.controller';
import { SubCoachesController } from './sub-coaches.controller';
import { SubCoachesService } from './sub-coaches.service';

// Phase 8 — /sub-coaches mobile surface. Imports TeamModule for
// counter refresh after a revoke. Reuses the same JwtAuthGuard +
// CoachGuard the rest of the /coach/* surface uses.
@Module({
  imports: [TeamModule],
  controllers: [SubCoachInvitesPublicController, SubCoachesController],
  providers: [
    SubCoachesService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [SubCoachesService],
})
export class SubCoachesModule {}
