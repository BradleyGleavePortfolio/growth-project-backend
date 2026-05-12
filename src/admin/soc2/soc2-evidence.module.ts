import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RolesGuard } from '../../auth/roles.guard';
import { Soc2EvidenceController } from './soc2-evidence.controller';
import { Soc2EvidenceService } from './soc2-evidence.service';

// SOC 2 evidence module — OWNER-only admin surface for compliance reviews
// and auditor walk-throughs. Exposes one endpoint:
//
//   GET /admin/soc2/evidence-snapshot
//
// which emits a JSON bundle of Fly.io config, Prisma schema hash, role-
// decorated route list, redacted audit log sample, and deployment history.
//
// AuthModule import wires JwtAuthGuard + JwksVerifierService into DI scope.
// RolesGuard is provided locally (consistent with AdminModule pattern).
//
// This module is imported by AdminModule so the endpoint resolves under
// the same guard context as all other /admin/* routes.
@Module({
  imports: [AuthModule],
  controllers: [Soc2EvidenceController],
  providers: [Soc2EvidenceService, RolesGuard],
  exports: [Soc2EvidenceService],
})
export class Soc2EvidenceModule {}
