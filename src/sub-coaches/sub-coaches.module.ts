import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { TeamModule } from '../team/team.module';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachInviteService } from './sub-coach-invite.service';
import { SubCoachInvitesPublicController } from './sub-coach-invites-public.controller';
import { SubCoachesController } from './sub-coaches.controller';
import { SubCoachesService } from './sub-coaches.service';
import { HeadCoachOnlyGuard } from './head-coach-only.guard';

// Phase 8 — /sub-coaches mobile surface. Imports TeamModule for
// counter refresh after a revoke. Reuses the same JwtAuthGuard +
// CoachGuard the rest of the /coach/* surface uses.
//
// M9 refactor: SubCoachesService is now a facade that delegates invite
// lifecycle to SubCoachInviteService and engagement analytics to
// SubCoachAnalyticsService. All three are provided here.
@Module({
  imports: [TeamModule],
  controllers: [SubCoachInvitesPublicController, SubCoachesController],
  providers: [
    SubCoachesService,
    SubCoachInviteService,
    SubCoachAnalyticsService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
    HeadCoachOnlyGuard,
  ],
  exports: [SubCoachesService],
})
export class SubCoachesModule {}
