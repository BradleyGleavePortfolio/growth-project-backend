import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { StripeApiService } from '../billing/stripe-api.service';
import { PrismaService } from '../prisma.service';
import { HeadCoachOnlyGuard } from '../sub-coaches/head-coach-only.guard';
import { TeamModeController } from './team-mode.controller';
import { TeamModeService } from './team-mode.service';
import { TeamModeTierResolverService } from './tier-resolver.service';

// Mirrors MacrosModule / RealMealPlansModule in providing JwtAuthGuard,
// CoachGuard, and JwksVerifierService locally rather than importing
// AuthModule. PrismaService is global. StripeApiService has no
// dependencies beyond env so it self-instantiates.
@Module({
  controllers: [TeamModeController],
  providers: [
    TeamModeService,
    TeamModeTierResolverService,
    StripeApiService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
    HeadCoachOnlyGuard,
  ],
  exports: [TeamModeService, TeamModeTierResolverService],
})
export class TeamModeModule {}
