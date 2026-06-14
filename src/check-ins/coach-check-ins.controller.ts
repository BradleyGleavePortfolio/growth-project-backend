import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ListCheckInsQueryDto } from './check-ins.dto';
import { CheckInsService } from './check-ins.service';

// Coach-authenticated check-in reads. Mounted under /coach so it sits next
// to the existing coach routes without modifying CoachController (same
// separation-of-concerns pattern as CoachNudgesController).
@ApiTags('check-ins')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachCheckInsController {
  constructor(private checkIns: CheckInsService) {}

  @Get('clients/:client_id/check-ins')
  async list(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Query() query: ListCheckInsQueryDto,
  ) {
    return this.checkIns.listForClientByCoach(req.user.id, clientId, query);
  }

  // ED.6 — coach marks a single check-in reviewed. Mirrors the messaging
  // `POST clients/:client_id/messages/read` shape: an explicit acknowledgement
  // the coach app already calls when the coach opens a check-in detail. Flips
  // the long-standing `reviewed_by_coach` flag and (only when
  // FEATURE_ROMAN_COACH_REVIEWED_AT is ON) re-stamps `coach_reviewed_at`, which
  // the client CompetencePill reads. 200 (acknowledgement, not creation); 404
  // when the check-in is missing or belongs to another coach (no probing).
  @Post('clients/:client_id/check-ins/:check_in_id/reviewed')
  @HttpCode(200)
  async markReviewed(
    @Request() req: AuthedRequest,
    @Param('check_in_id') checkInId: string,
  ) {
    return this.checkIns.markReviewedByCoach(req.user.id, checkInId);
  }
}
