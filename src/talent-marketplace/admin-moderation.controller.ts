// TM-7 — Admin listing moderation + applicant review (owner-only).
//
// The whole surface is platform-admin: OwnerGuard (src/common/guards) gates
// every route on req.user.role === 'owner'. We reuse the existing OwnerGuard
// rather than redefining an owner predicate (no closer OwnerOnlyGuard exists).
// Review POSTs are idempotent via the TM-4 ledger keyed on the authed owner +
// an optional Idempotency-Key header, so a double-tapped decision replays.
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
import {
  ReviewDecisionDto,
  ReviewQueueQueryDto,
} from './admin-moderation.dto';
import { AdminModerationService } from './admin-moderation.service';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/admin')
@Roles('owner')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminModerationController {
  constructor(private readonly moderation: AdminModerationService) {}

  @Get('listings')
  async listings(@Query() query: ReviewQueueQueryDto) {
    return this.moderation.listListings(query);
  }

  @Post('listings/:id/review')
  async reviewListing(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDecisionDto,
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    return this.moderation.reviewListing(req.user.id, id, withKey(dto, idemHeader));
  }

  @Get('applications')
  async applications(@Query() query: ReviewQueueQueryDto) {
    return this.moderation.listApplications(query);
  }

  @Post('applications/:id/review')
  async reviewApplication(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDecisionDto,
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    return this.moderation.reviewApplication(
      req.user.id,
      id,
      withKey(dto, idemHeader),
    );
  }
}

// Prefer an explicit body idempotency_key; otherwise fall back to the standard
// Idempotency-Key header so callers using either convention dedupe correctly.
function withKey(dto: ReviewDecisionDto, header?: string): ReviewDecisionDto {
  if (dto.idempotency_key || !header) return dto;
  return { ...dto, idempotency_key: header };
}
