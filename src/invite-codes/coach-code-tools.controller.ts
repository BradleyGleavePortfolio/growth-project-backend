import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CoachCodeSignupsQueryDto,
  CreateCoachCodeDto,
  RotateCoachCodeDto,
} from './coach-code-tools.dto';
import { assertCoachCodeToolsEnabled } from './coach-code-tools.feature';
import { CoachCodeToolsService } from './coach-code-tools.service';

function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const ip = xff.split(',')[0]?.trim() || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? (uaRaw[0] ?? null) : (uaRaw ?? null);
  return { ip: ip || null, userAgent: userAgent || null };
}

function actorOf(req: AuthedRequest) {
  return { id: req.user.id, role: req.user.role, email: req.user.email ?? null };
}

/**
 * A2 coach code tools. Every route: JwtAuthGuard + CoachGuard (coach or
 * owner), tenancy from req.user.id only, kill switch FEATURE_COACH_CODE_TOOLS
 * (default OFF → 404 `coach_code_tools_disabled`). `:id` is an InviteCode id
 * or the literal `coach-link` for the coach's permanent link code.
 */
@ApiTags('coach-code-tools')
@Controller('coach/codes')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachCodeToolsController {
  constructor(private readonly tools: CoachCodeToolsService) {}

  @ApiOperation({ summary: 'List my shareable codes with usage, QR payload and status' })
  @Roles('coach', 'owner')
  @Get()
  async list(@Request() req: AuthedRequest) {
    assertCoachCodeToolsEnabled();
    return this.tools.list(req.user.id);
  }

  @ApiOperation({ summary: 'Daily signups per code and package in my time zone' })
  @Roles('coach', 'owner')
  @Get('signups')
  async signups(@Request() req: AuthedRequest, @Query() query: CoachCodeSignupsQueryDto) {
    assertCoachCodeToolsEnabled();
    return this.tools.signups(req.user.id, query.days);
  }

  @ApiOperation({
    summary: 'Create a GP- code (Idempotency-Key header makes a retry return the first code)',
  })
  @ApiResponse({ status: 201, description: 'Created (or the replayed first code, replayed=true).' })
  @Roles('coach', 'owner')
  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async create(
    @Request() req: AuthedRequest,
    @Body() body: CreateCoachCodeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    assertCoachCodeToolsEnabled();
    return this.tools.create(actorOf(req), body, idempotencyKey ?? null, auditContext(req));
  }

  @ApiOperation({
    summary:
      'Rotate: new code with the same settings; the old one turns off now or after a grace period',
  })
  @Roles('coach', 'owner')
  @Post(':id/rotate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async rotate(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RotateCoachCodeDto,
  ) {
    assertCoachCodeToolsEnabled();
    return this.tools.rotate(
      actorOf(req),
      id,
      body?.grace_hours,
      auditContext(req),
      body?.expected_code,
    );
  }

  @ApiOperation({ summary: 'Revoke (turn off) a code. Clients who already joined stay with you.' })
  @Roles('coach', 'owner')
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async revoke(@Request() req: AuthedRequest, @Param('id') id: string) {
    assertCoachCodeToolsEnabled();
    return this.tools.revoke(actorOf(req), id, auditContext(req));
  }
}
