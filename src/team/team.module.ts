import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { ConnectModule } from '../connect/connect.module';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

// Phase 8 — Team module owns the /coach/team surface. Sub-coach
// management has its own SubCoachesModule; this module is the
// head-coach-side team record.
//
// AuditService is listed in providers (even though AuditModule is @Global)
// because TeamService declares it as a constructor dependency; the @Global
// export makes it resolvable here without importing AuditModule.
@Module({
  imports: [ConnectModule],
  controllers: [TeamController],
  providers: [
    TeamService,
    PrismaService,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
    NoActiveSubCoachGuard,
    AuditService,
  ],
  exports: [TeamService],
})
export class TeamModule {}
