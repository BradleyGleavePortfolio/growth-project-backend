import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';
import { PromoteUserDto } from './admin.dto';

// Phase 1A/1B: OWNER-only platform admin surface. Every route here is
// gated by JwtAuthGuard + RolesGuard with @Roles('owner') so a coach or
// student hitting these gets a clean 403, not a leak.
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminController {
  constructor(
    private admin: AdminService,
    private metrics: MetricsService,
  ) {}

  // OWNER-only platform metrics. Counters are derived from Postgres rows
  // we have actually written — no synthetic revenue, no fabricated MAU.
  // Stripe-sourced money figures come from the Invoice mirror table.
  // Window defaults to 30 days; clamp to a sane range to keep the query
  // cheap and bounded.
  @Get('metrics')
  async getMetrics(@Query('since_days') sinceDaysRaw?: string) {
    const parsed = sinceDaysRaw ? parseInt(sinceDaysRaw, 10) : NaN;
    const sinceDays =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30;
    return this.metrics.getOverview({ sinceDays });
  }

  @Get('coaches')
  async listCoaches() {
    return this.admin.listCoaches();
  }

  @Get('coaches/:id')
  async getCoach(@Param('id') id: string) {
    return this.admin.getCoachDetail(id);
  }

  @Get('users')
  async listUsers(
    @Query('role') role?: 'owner' | 'coach' | 'student',
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.listUsers({
      role,
      q,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('users/:id/promote')
  async promoteUser(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: PromoteUserDto,
  ) {
    return this.admin.promoteUser(
      req.user.id,
      id,
      body.role,
      {
        business_name: body.business_name,
        bio: body.bio,
        timezone: body.timezone,
      },
      auditContext(req as any),
    );
  }

  // OWNER-only audit-log read surface. Filters cover the common forensic
  // queries (by action, target user, tenant coach) plus a `before` cursor
  // for pagination.
  @Get('audit-log')
  async listAuditLog(
    @Query('action') action?: string,
    @Query('target_user_id') targetUserId?: string,
    @Query('tenant_coach_id') tenantCoachId?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.listAuditLog({
      action,
      targetUserId,
      tenantCoachId,
      before,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}

// Best-effort extraction of remote IP + User-Agent from the express request,
// used as audit-log context. Handles the common `x-forwarded-for` chain set
// by Fly.io's edge proxy. Returns nulls when fields are absent — callers
// already accept null.
function auditContext(req: any): { ip: string | null; userAgent: string | null } {
  const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const userAgent = (req?.headers?.['user-agent'] || null) as string | null;
  return { ip: ip || null, userAgent: userAgent || null };
}
