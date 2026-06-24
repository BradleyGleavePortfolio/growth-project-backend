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
} from './admin-applications.dto';
import { AdminApplicationsService } from './admin-applications.service';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/admin')
@Roles('owner')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminApplicationsController {
  constructor(private readonly applications: AdminApplicationsService) {}

  @Get('applications')
  async list(@Query() query: ReviewQueueQueryDto) {
    return this.applications.listApplications(query);
  }

  @Post('applications/:id/review')
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
