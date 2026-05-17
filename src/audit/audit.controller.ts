import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditService } from './audit.service';

// OWNER-only audit log read surface at GET /admin/audit/log.
//
// This controller is registered inside AuditModule so it is self-contained.
// The original GET /admin/audit-log path on AdminController continues to
// work — this path adds a second canonical entry point at /admin/audit/log
// which aligns with the Phase 10 spec.
//
// Access control: @Roles('owner') + RolesGuard. The global JwtAuthGuard
// already enforces authentication; RolesGuard additionally checks that
// the authenticated user carries the 'owner' role. Any non-owner request
// gets a 403 before the query runs.
@Controller('admin/audit')
@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard)
@Roles('owner')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  // GET /admin/audit/log
  //
  // Query params (all optional):
  //   action          — exact action string match (e.g. "auth.login")
  //   target_user_id  — scope to a single target user
  //   tenant_coach_id — scope to a single coach's tenant
  //   before          — ISO 8601 cursor: return rows with created_at < before
  //   limit           — page size; server clamps to [1, 200], defaults to 50
  //
  // Returns: array of AuditLog rows ordered by created_at desc (newest first).
  // Cursor pagination: use the `created_at` of the last row as the next
  // `before` value to page backward through history.
  @Get('log')
  async listAuditLog(
    @Query('action') action?: string,
    @Query('target_user_id') targetUserId?: string,
    @Query('tenant_coach_id') tenantCoachId?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list({
      action,
      targetUserId,
      tenantCoachId,
      before: before ? new Date(before) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
