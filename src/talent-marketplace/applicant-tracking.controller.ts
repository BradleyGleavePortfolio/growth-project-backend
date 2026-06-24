// TM-8 — Hirer applicant tracking (8a). Per-listing applicant pipeline scoped
// to the owning hirer. PII gate: CandidateCard projection is PII-stripped;
// full detail is identity-redacted (email → domain only). Hirer authorization
// is the JWT + coach-role + verified-hirer stack; per-listing ownership is
// enforced in the service via Application.hirer_id = caller.
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { HirerVerifiedGuard } from './hirer-verified.guard';
import { ApplicantTrackingService } from './applicant-tracking.service';
import {
  AppendNoteDto,
  ApplicantQueueQueryDto,
  MoveStageDto,
} from './applicant-tracking.dto';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace')
@Roles('coach')
@UseGuards(JwtAuthGuard, RolesGuard, HirerVerifiedGuard)
export class ApplicantTrackingController {
  constructor(private readonly tracking: ApplicantTrackingService) {}

  @Get('listings/:id/applicants')
  async listApplicants(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) listingId: string,
    @Query() query: ApplicantQueueQueryDto,
  ) {
    return this.tracking.listApplicants(req.user.id, listingId, query);
  }

  @Get('applicants/:applicantId')
  async getApplicant(
    @Req() req: AuthedRequest,
    @Param('applicantId', ParseUUIDPipe) applicationId: string,
  ) {
    return this.tracking.getApplicantDetail(req.user.id, applicationId);
  }

  @Patch('applicants/:applicantId/stage')
  async moveStage(
    @Req() req: AuthedRequest,
    @Param('applicantId', ParseUUIDPipe) applicationId: string,
    @Body() dto: MoveStageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.tracking.moveStage(
      req.user.id,
      applicationId,
      dto.stage,
      idempotencyKey,
    );
  }

  // 8b surfaces — wired now so the route contract is stable, but the persistence
  // (hirer-private notes / shortlist flag) lands in TM-8b with its own RLS. The
  // service returns 501 until then. See follow-up issue TM-8b.
  @Post('applicants/:applicantId/notes')
  async appendNote(
    @Param('applicantId', ParseUUIDPipe) _applicationId: string,
    @Body() _dto: AppendNoteDto,
  ) {
    return this.tracking.appendNote();
  }

  @Post('applicants/:applicantId/shortlist')
  async toggleShortlist(
    @Param('applicantId', ParseUUIDPipe) _applicationId: string,
  ) {
    return this.tracking.toggleShortlist();
  }
}
