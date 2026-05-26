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
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateInviteCodeDto } from './invite-codes.dto';
import { BulkInviteDto } from './bulk-invite.dto';
import { SendOneInviteDto } from './dto/send-one-invite.dto';
import { InviteCodesService } from './invite-codes.service';

// Coach-authenticated endpoints for managing invite codes. Mounted under
// /coach/invite-codes to sit alongside the existing coach routes.
@ApiTags('invite-codes')
@Controller()
export class InviteCodesController {
  constructor(private inviteCodes: InviteCodesService) {}

  // ----- existing legacy InviteCode CRUD (unchanged) -----------------
  @Post('coach/invite-codes')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
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

  // Phase 8 — invite-code redeemer drilldown. Returns every user who
  // signed up under the calling coach (or one of their sub-coaches)
  // within the invite code's effective window. The mobile contract
  // shape is `{ redeemers: [{user_id, name, email, redeemed_at, last_active_at}] }`.
  //
  // C5 PR-A audit: this route was an orphan vs roles-enforced.spec.ts — the
  // sibling InviteCodes handlers are on the legacy allowlist (per-handler
  // JwtAuthGuard+CoachGuard), but the static analyser requires an explicit
  // @Roles() declaration on every non-Public route. Coach inspects the
  // redeemer list of an invite they own — scoped by `req.user.id` below.
  @Roles('coach', 'owner')
  @Get('coach/invite-codes/:id/redeemers')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async redeemers(@Request() req: AuthedRequest, @Param('id') id: string) {
    const rows = await this.inviteCodes.listRedeemersForCoach(req.user.id, id);
    return { redeemers: rows };
  }

  // Sprint B — Bulk invite. Accepts a structured array of recipients
  // and generates one single-use, 14-day code per row. Throttled to
  // make a malicious coach unable to flood the table; legit coaches
  // rarely need >100 invites per minute.
  @Post('coach/invite-codes/bulk')
  @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  async bulk(
    @Request() req: AuthedRequest,
    @Body() body: BulkInviteDto,
  ) {
    return this.inviteCodes.bulkInvite(req.user.id, body.rows);
  }

  // POST /coach/invite-codes/:id/send — re-deliver the email for an
  // already-created invite-code row to a specified recipient. Used when:
  //   * the coach typed the wrong email and corrects it after creating
  //     the code, or
  //   * the mobile UI surfaces a "resend" button next to a row whose
  //     bulk-send email_status came back as 'failed'.
  // Idempotency is keyed on the invite_code_id, so retries are safe.
  //
  // C5 PR-A audit: orphan vs roles-enforced.spec.ts. Coach re-sends an
  // invite they own; `req.user.id` is the authorising key inside
  // sendInviteEmailForCode — a coach cannot resend another coach's invite.
  @Roles('coach', 'owner')
  @Post('coach/invite-codes/:id/send')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async sendOne(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: SendOneInviteDto,
  ) {
    return this.inviteCodes.sendInviteEmailForCode(req.user.id, id, body.email, {
      recipientName: body.name,
      personalNote: body.note,
    });
  }

  // POST /coach/invite-codes/bulk/parse — server-side parser for the
  // mobile paste box. Lets the mobile UI render a preview without
  // duplicating the parsing rules. Pure function; no DB writes.
  @Post('coach/invite-codes/bulk/parse')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @HttpCode(HttpStatus.OK)
  parseBulk(
    @Request() _req: AuthedRequest,
    @Body() body: { input: string },
  ) {
    if (typeof body.input !== 'string') return { rows: [] };
    return { rows: this.inviteCodes.parsePasted(body.input, 100) };
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
      url: `${process.env.PUBLIC_INVITE_BASE_URL || 'https://app.trygrowthproject.com/join'}/${profile.invite_code}`,
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
      url: `${process.env.PUBLIC_INVITE_BASE_URL || 'https://app.trygrowthproject.com/join'}/${profile.invite_code}`,
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

  // ----- C3: public accept-by-token -----------------------------------
  //
  // PUBLIC endpoint used by the mobile deep-link / landing page flow.
  // Accepts a token (= invite code) and returns a structured result so
  // the client can navigate to signup or show a friendly error — never
  // a 4xx for a known-invalid code. Throttled to prevent brute-force
  // enumeration of the 30-bit code space.
  @Public()
  @Post('invites/accept/:token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async acceptInviteToken(
    @Param('token') token: string,
    @Body() _body: Record<string, unknown>,
  ) {
    return this.inviteCodes.acceptByToken(token);
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
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
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
