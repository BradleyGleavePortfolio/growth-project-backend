import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { ServiceTokenGuard } from '../../auth/service-token.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Soc2EvidenceService } from './soc2-evidence.service';

// OWNER-only SOC 2 evidence snapshot surface. Every route is gated by
// JwtAuthGuard + RolesGuard with @Roles('owner') — coaches and students
// get a clean 403.
//
// The evidence-snapshot endpoint emits a JSON bundle useful for auditor
// walk-throughs and quarterly compliance reviews. It contains no PII —
// audit log actor emails are redacted to the first 2 chars + domain and
// no health / biometric data is included. See Soc2EvidenceService for
// the exact redaction rules.
//
// Docs: docs/soc2/controls/evidence-collection.md
@ApiTags('admin-soc2')
@Controller('admin/soc2')
@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard)
@Roles('owner')
export class Soc2EvidenceController {
  constructor(private soc2: Soc2EvidenceService) {}

  // GET /admin/soc2/evidence-snapshot
  //
  // Returns a JSON bundle of:
  //   - flyConfig      — current Fly.io app config (env, regions, services)
  //   - schemaHash     — SHA-256 of prisma/schema.prisma at deploy time
  //   - roleDecoratedRoutes — list of every controller route with @Roles()
  //   - auditLogSample — last 100 AuditLog entries (redacted)
  //   - deploymentHistory — last 20 Fly.io releases
  //   - snapshotAt     — ISO-8601 timestamp
  @Get('evidence-snapshot')
  async evidenceSnapshot() {
    return this.soc2.buildSnapshot();
  }
}
