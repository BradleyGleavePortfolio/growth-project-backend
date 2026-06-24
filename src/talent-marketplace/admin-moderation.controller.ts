// TM-7a — Admin listing moderation (owner-only).
//
// The whole surface is platform-admin: OwnerGuard (src/common/guards) gates
// every route on req.user.role === 'owner'. We reuse the existing OwnerGuard
// rather than redefining an owner predicate (no closer OwnerOnlyGuard exists).
// Review POSTs are idempotent via the TM-4 ledger keyed on the authed owner +
// an optional Idempotency-Key header, so a double-tapped decision replays.
//
// The applicant-review half ships in TM-7b (admin-applications.controller.ts),
// stacked on this PR; the shared cursor + ledger helpers live here and are
// imported there.
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
import { ReviewDecisionDto, ReviewQueueQueryDto, type ListingStatus } from './admin-moderation.dto';
import { AdminModerationService } from './admin-moderation.service';
import { ParseListingStatusPipe } from './admin-moderation.pipes';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/admin')
@Roles('owner')
@UseGuards(JwtAuthGuard, OwnerGuard)
export class AdminModerationController {
  constructor(private readonly moderation: AdminModerationService) {}

  // `status` is parsed by ParseListingStatusPipe so an unknown value returns a
  // 400 carrying the stable `code: 'invalid_listing_status'` (B-P2-6) instead
  // of class-validator's generic 400; cursor/limit still flow through the
  // global ValidationPipe via the DTO. @IsIn(LISTING_STATUS) is kept on the DTO
  // for OpenAPI + class-validator metadata.
  @Get('listings')
  async listings(
    @Query() query: ReviewQueueQueryDto,
    @Query('status', ParseListingStatusPipe) status?: ListingStatus,
  ) {
    // Re-pin the pipe-validated status onto the query the service consumes (the
    // global ValidationPipe leaves the raw string on `query.status`; the pipe is
    // the authoritative parse). Omit the key entirely when no filter was given
    // so the service's `if (query.status)` short-circuits cleanly.
    return this.moderation.listListings(status === undefined ? query : { ...query, status });
  }

  // Review is an idempotent state transition, not a resource creation: a first
  // decision and a replay both return 200, never Nest's default 201 Created.
  @Post('listings/:id/review')
  @HttpCode(HttpStatus.OK)
  async reviewListing(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDecisionDto,
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    return this.moderation.reviewListing(req.user.id, id, withKey(dto, idemHeader));
  }
}

// Prefer an explicit body idempotency_key; otherwise fall back to the standard
// Idempotency-Key header so callers using either convention dedupe correctly.
export function withKey(dto: ReviewDecisionDto, header?: string): ReviewDecisionDto {
  if (dto.idempotency_key || !header) return dto;
  return { ...dto, idempotency_key: header };
}
