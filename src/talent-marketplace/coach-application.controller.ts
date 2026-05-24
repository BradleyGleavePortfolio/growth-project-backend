/**
 * CoachApplicationController — Phase 11 / Track 8
 *
 * Routes:
 *   POST   /apply/coach                        — public submit (no auth)
 *   GET    /applications/me                    — authenticated applicant
 *   GET    /admin/applications                 — owner admin list
 *   PATCH  /admin/applications/:id/review      — owner admin review
 *
 * Note: the public-facing marketing-site application form (HTML/web) is
 * out of scope for this PR and will be built as a separate marketing-site
 * feature. This endpoint is the backend receiver for that form. Until the
 * marketing-site form ships, the endpoint is testable via curl / Postman.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { CoachApplicationService } from './coach-application.service';
import { TalentPoolService } from './talent-pool.service';
import { ConnectAccountService } from './connect-account.service';
import { CoachOfferService } from './coach-offer.service';
import { MarketplaceIdempotencyService } from './marketplace-idempotency.service';
import {
  SubmitCoachApplicationDto,
  ReviewCoachApplicationDto,
  ListApplicationsQueryDto,
} from './coach-application.dto';
import { CreateOfferDto, AcceptRejectOfferDto, SearchPoolQueryDto } from './coach-offer.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuidIdempotencyHeader(header: string | undefined): string {
  if (!header || !UUID_RE.test(header.trim())) {
    throw new BadRequestException(
      'Idempotency-Key header is required and must be a UUID.',
    );
  }
  return header.trim();
}

@ApiTags('talent-marketplace')
@Controller()
export class CoachApplicationController {
  constructor(
    private readonly applicationService: CoachApplicationService,
    private readonly poolService: TalentPoolService,
    private readonly connectService: ConnectAccountService,
    private readonly offerService: CoachOfferService,
    private readonly idempotency: MarketplaceIdempotencyService,
  ) {}

  // ─── Public: Submit Application ───────────────────────────────────────────

  @Public()
  @Post('apply/coach')
  @ApiOperation({ summary: 'Submit a public coach application (no auth required)' })
  submitApplication(
    @Body() dto: SubmitCoachApplicationDto,
    @Request() req: { user?: AuthedRequest['user'] },
  ) {
    // If the caller happens to be authenticated (signed-in user applying),
    // the guard will have populated req.user; we pass the id as the FK.
    // For anonymous submissions req.user is undefined.
    return this.applicationService.submitApplication(dto, req.user?.id);
  }

  // ─── Authenticated Applicant ───────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('applications/me')
  @ApiOperation({ summary: 'Get my coach applications' })
  getMyApplications(@Request() req: AuthedRequest) {
    return this.applicationService.getMyApplications(req.user.id);
  }

  // ─── Admin: Review Queue ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner')
  @Get('admin/applications')
  @ApiOperation({ summary: 'Admin: list coach applications' })
  listApplications(@Query() query: ListApplicationsQueryDto) {
    return this.applicationService.listApplications(query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner')
  @Patch('admin/applications/:id/review')
  @ApiOperation({ summary: 'Admin: review and advance an application' })
  async reviewApplication(
    @Param('id') id: string,
    @Body() dto: ReviewCoachApplicationDto,
    @Request() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
  ) {
    const idempotencyKey = requireUuidIdempotencyHeader(idempotencyHeader);
    const replay = await this.idempotency.findReplay(
      req.user.id,
      'admin.application.review',
      idempotencyKey,
    );
    if (replay) return replay;

    const result = await this.applicationService.reviewApplication(
      id,
      dto,
      req.user.id,
    );
    return this.idempotency.record(
      req.user.id,
      'admin.application.review',
      idempotencyKey,
      result,
    );
  }

  // ─── Talent Pool: Scale+ Head-Coach Search ────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Get('talent/pool')
  @ApiOperation({
    summary:
      'Search talent pool (Scale+ head-coaches only). Browse UI is deferred to Track 8.5.',
  })
  searchPool(
    @Query() query: SearchPoolQueryDto,
    @Request() req: AuthedRequest,
  ) {
    return this.poolService.searchPool(query, req.user.id);
  }

  // ─── Connect Account ──────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('talent/connect/onboarding-link')
  @ApiOperation({ summary: 'Request a Stripe Connect Express onboarding URL' })
  async getOnboardingLink(
    @Request() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
  ) {
    const idempotencyKey = requireUuidIdempotencyHeader(idempotencyHeader);
    const replay = await this.idempotency.findReplay<{ url: string }>(
      req.user.id,
      'talent.connect.onboarding-link',
      idempotencyKey,
    );
    if (replay) return replay;

    const result = await this.connectService.createOnboardingLink(
      req.user.id,
      idempotencyKey,
    );
    return this.idempotency.record(
      req.user.id,
      'talent.connect.onboarding-link',
      idempotencyKey,
      result,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('talent/connect/status')
  @ApiOperation({ summary: 'Get Stripe Connect account status' })
  getConnectStatus(@Request() req: AuthedRequest) {
    return this.connectService.getAccountStatus(req.user.id);
  }

  // ─── Offers ───────────────────────────────────────────────────────────────

  // Only head-coaches (and OWNER via RolesGuard's hierarchy bypass) can extend
  // offers. The service still re-checks subscription entitlement so a coach
  // without an active Scale+ subscription is blocked at the data layer too.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Post('talent/offers')
  @ApiOperation({ summary: 'Head-coach extends an offer to a pool applicant' })
  createOffer(
    @Body() dto: CreateOfferDto,
    @Request() req: AuthedRequest,
  ) {
    return this.offerService.createOffer(dto, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('talent/offers/:id/accept')
  @ApiOperation({ summary: 'Accept an offer (applicant)' })
  acceptOffer(
    @Param('id') id: string,
    @Body() dto: AcceptRejectOfferDto,
    @Request() req: AuthedRequest,
  ) {
    return this.offerService.acceptOffer(id, req.user.id, dto.idempotency_key);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('talent/offers/:id/reject')
  @ApiOperation({ summary: 'Reject an offer (applicant)' })
  rejectOffer(
    @Param('id') id: string,
    @Body() dto: AcceptRejectOfferDto,
    @Request() req: AuthedRequest,
  ) {
    return this.offerService.rejectOffer(id, req.user.id, dto.idempotency_key);
  }
}
