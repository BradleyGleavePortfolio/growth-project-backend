import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AntiBotGate, AntiBotGuard } from './anti-bot/anti-bot.guard';
import { ANTI_BOT_SURFACES } from './anti-bot/anti-bot.types';
import {
  ApplyDto,
  MyApplicationsQueryDto,
  UpdateApplicantDto,
} from './apply.dto';
import { ApplyService } from './apply.service';

// TM-5 — Apply funnel + pre-coach account + applicant profile.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII BOUNDARY (the gate). Apply accepts identity (email, names) from an     ║
// ║ ANONYMOUS job-hunter and mints a lightweight pre-coach account — so it is  ║
// ║ deliberately UNAUTHENTICATED but sits behind the TM-6 anti-bot gate        ║
// ║ (@AntiBotGate(Apply) + AntiBotGuard) which is the abuse control for the    ║
// ║ account-create + apply surface. The profile/applications routes are        ║
// ║ JWT-gated and reads-own (service-layer owner-scope + TM-1 RLS). Every      ║
// ║ response is an explicit allow-list DTO — no raw entity is ever returned.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ LUXURY PAYLOAD CONTRACT (mobile TM-M5 ApplyFlow / TM-W5). 3-taps-to-apply: ║
// ║ minimum required fields (email + first/last name; Hick's law), one primary ║
// ║ CTA. Apply returns a DEFINITIVE confirmation (you're-in + application id + ║
// ║ celebratable status + one fit chip + what's-next) — never an empty 200.    ║
// ║ Two-way fit is ONE primary signal (a single chip), not a scorecard.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
@ApiTags('talent-marketplace')
@Controller('talent-marketplace')
export class ApplyController {
  constructor(private readonly apply: ApplyService) {}

  // Anonymous-friendly apply funnel — behind the TM-6 anti-bot gate (the abuse
  // control for the account-create + apply surface). Returns 201 with the full
  // confirmation payload.
  @Post('listings/:id/apply')
  @Public()
  @AntiBotGate(ANTI_BOT_SURFACES.Apply)
  @UseGuards(AntiBotGuard)
  @HttpCode(HttpStatus.CREATED)
  async applyToListing(
    @Param('id', ParseUUIDPipe) listingId: string,
    @Body() dto: ApplyDto,
  ) {
    return this.apply.apply(listingId, dto);
  }

  // The applicant's own pre-coach profile (reads-own).
  @Get('applicants/me')
  @Roles('student')
  @UseGuards(JwtAuthGuard)
  async getMyProfile(@Req() req: AuthedRequest) {
    return this.apply.getOwnProfile(req.user.id);
  }

  @Patch('applicants/me')
  @Roles('student')
  @UseGuards(JwtAuthGuard)
  async updateMyProfile(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateApplicantDto,
  ) {
    return this.apply.updateOwnProfile(req.user.id, dto);
  }

  // "My applications" — keyset tuple pagination, scoped to the caller.
  @Get('applicants/me/applications')
  @Roles('student')
  @UseGuards(JwtAuthGuard)
  async myApplications(
    @Req() req: AuthedRequest,
    @Query() query: MyApplicationsQueryDto,
  ) {
    return this.apply.myApplications(req.user.id, query);
  }
}
