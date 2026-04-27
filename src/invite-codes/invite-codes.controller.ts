import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Public } from '../common/decorators/public.decorator';
import { CreateInviteCodeDto } from './invite-codes.dto';
import { InviteCodesService } from './invite-codes.service';

// Coach-authenticated endpoints for managing invite codes. Mounted under
// /coach/invite-codes to sit alongside the existing coach routes.
@Controller()
export class InviteCodesController {
  constructor(private inviteCodes: InviteCodesService) {}

  // ----- existing legacy InviteCode CRUD (unchanged) -----------------
  @Post('coach/invite-codes')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async create(
    @Request() req: AuthedRequest,
    @Body() body: CreateInviteCodeDto,
  ) {
    return this.inviteCodes.createForCoach(req.user.id, body);
  }

  @Get('coach/invite-codes')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async list(@Request() req: AuthedRequest) {
    return this.inviteCodes.listForCoach(req.user.id);
  }

  @Delete('coach/invite-codes/:id')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async revoke(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.inviteCodes.revokeForCoach(req.user.id, id);
  }

  // ----- Phase 1C: per-coach default invite link --------------------
  //
  // GET /coaches/me/invite-link returns the coach's default link
  // (lazy-create if missing). POST .../regenerate rotates it. Both are
  // CoachGuard-gated so OWNERs can hit them too (CoachGuard widens to
  // OWNER in Phase 1B).
  @Get('coaches/me/invite-link')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async getMyInviteLink(@Request() req: AuthedRequest) {
    const profile = await this.inviteCodes.getOrCreateDefaultForCoach(
      req.user.id,
    );
    return {
      code: profile.invite_code,
      url: `${process.env.PUBLIC_INVITE_BASE_URL || 'https://app.tgp.com/join'}/${profile.invite_code}`,
    };
  }

  @Post('coaches/me/invite-link/regenerate')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @HttpCode(HttpStatus.OK)
  async regenerateMyInviteLink(@Request() req: AuthedRequest) {
    const profile = await this.inviteCodes.regenerateDefaultForCoach(
      req.user.id,
    );
    return {
      code: profile.invite_code,
      url: `${process.env.PUBLIC_INVITE_BASE_URL || 'https://app.tgp.com/join'}/${profile.invite_code}`,
    };
  }

  // ----- Phase 1C: public preview --------------------------------
  //
  // PUBLIC route used by the mobile signup screen + the /join landing
  // page. Returns a coach card (name, business name, branding) for a
  // valid code; `{valid:false}` otherwise. Throttled to make
  // brute-force enumeration of the 30-bit code space pointless.
  @Public()
  @Get('invite/:code/preview')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async previewInvite(@Param('code') code: string) {
    return this.inviteCodes.previewCode(code);
  }

  // ----- Phase 1C: attach existing user to a coach via code ----------
  //
  // Used after Google OAuth (the OAuth roundtrip cannot carry the
  // coach's invite code): the mobile client signs in, then submits the
  // code from the in-app post-OAuth screen. Also reachable for any
  // already-existing student who later acquires a code.
  //
  // Hidden behind COACH_CODE_GATE_ENABLED so the backend can ship this
  // additively; flag flip enables the gate without a new release.
  @Post('auth/attach-coach-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async attachCoachCode(
    @Request() req: AuthedRequest,
    @Body() body: { code: string },
  ) {
    return this.inviteCodes.attachUserToCoachByCode(req.user.id, body.code);
  }
}
