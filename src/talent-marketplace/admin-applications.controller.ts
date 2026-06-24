// TM-7b — Admin applicant review (owner-only). Mirrors the TM-7a listing
// controller: OwnerGuard gates every route on req.user.role === 'owner', and
// review POSTs are idempotent via the TM-4 ledger keyed on the authed owner +
// an optional Idempotency-Key header. The header-fold helper is shared with
// the listing controller.
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { OwnerGuard } from '../common/guards/owner.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { withKey } from './admin-moderation.controller';
import {
  ReviewDecisionDto,
  ReviewQueueQueryDto,
  type ApplicationStatus,
} from './admin-applications.dto';
import { AdminApplicationsService } from './admin-applications.service';
import { ParseApplicationStatusPipe } from './admin-applications.pipes';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/admin')
@Roles('owner')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminApplicationsController {
  constructor(private readonly applications: AdminApplicationsService) {}

  // `status` is parsed by ParseApplicationStatusPipe so an unknown value returns
  // a 400 carrying the stable `code: 'invalid_application_status'` instead of
  // class-validator's generic 400; cursor/limit still flow through the global
  // ValidationPipe via the DTO. @IsIn(APPLICATION_STATUS) is kept on the DTO for
  // OpenAPI + class-validator metadata.
  @Get('applications')
  async list(
    @Query() query: ReviewQueueQueryDto,
    @Query('status', ParseApplicationStatusPipe) status?: ApplicationStatus,
  ) {
    // Re-pin the pipe-validated status onto the query the service consumes (the
    // global ValidationPipe leaves the raw string on `query.status`; the pipe is
    // the authoritative parse). Omit the key entirely when no filter was given
    // so the service's `if (query.status)` short-circuits cleanly.
    return this.applications.listApplications(
      status === undefined ? query : { ...query, status },
    );
  }

  // Review is an idempotent state transition, not a resource creation: a first
  // decision and a replay both return 200, never Nest's default 201 Created.
  @Post('applications/:id/review')
  @HttpCode(HttpStatus.OK)
  async review(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDecisionDto,
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    // Forward the request-scoped correlation id (set by RequestIdMiddleware) so
    // the moderation_decision audit event self-correlates with the request /
    // error / Sentry trail (B-P2-7). Omitted downstream when absent.
    return this.applications.reviewApplication(
      req.user.id,
      id,
      withKey(dto, idemHeader),
      req.requestId,
    );
  }
}
