import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { ConsentService } from './consent.service';
import { CoachSharingNoticeDto, GrantConsentDto, RevokeConsentDto } from './consent.dto';
import { CoachSharingFirstSignInService } from './coach-sharing-first-sign-in.service';

// Client-facing consent surface. Mounted at /consent/* so the mobile app
// has one path prefix to learn. Every route requires a logged-in user;
// the caller is always treated as the client (clients grant/revoke for
// themselves).
@ApiTags('consent')
@Controller('consent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly firstSignInSharing: CoachSharingFirstSignInService,
  ) {}

  // GET /consent/scopes — static list of canonical scope strings, so the
  // mobile UI can render a toggle per scope without hard-coding them.
  @Get('scopes')
  listScopes() {
    return { scopes: ConsentService.listScopes() };
  }

  // GET /consent/me?coach_id=... — full per-scope state for one coach
  // (defaults to the caller's primary coach). Returns every scope, with
  // unset scopes flagged `granted: false`, and `owner_access` (true when
  // that coach is the platform owner account, which sees client data
  // without a consent row; see ConsentService.myConsentView).
  @Get('me')
  async getMyConsent(
    @Request() req: AuthedRequest,
    @Query('coach_id') coachIdRaw?: string,
  ) {
    const coachId = coachIdRaw ?? req.user.coach_id ?? null;
    if (!coachId) {
      throw new BadRequestException(
        'No coach_id supplied and caller has no primary coach',
      );
    }
    const { consents, owner_access } = await this.consent.myConsentView(req.user.id, coachId);
    return { client_id: req.user.id, coach_id: coachId, consents, owner_access };
  }

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  async grant(@Request() req: AuthedRequest, @Body() body: GrantConsentDto) {
    return this.consent.grant(
      req.user.id,
      body.coach_id,
      body.scope,
      auditContext(req),
    );
  }

  // GET /consent/coach-sharing-notice — whether the first onboarding screen
  // prints the coach-sharing sentence (an account linked outside the app,
  // e.g. a share-link buyer, that has not decided sharing yet) and the coach
  // it names. POST records the four fitness grants when the client taps
  // Continue under it. See coach-sharing-first-sign-in.service.ts.
  @Get('coach-sharing-notice')
  async getCoachSharingNotice(@Request() req: AuthedRequest) {
    return this.firstSignInSharing.view(req.user.id);
  }

  @Post('coach-sharing-notice')
  @HttpCode(HttpStatus.OK)
  async acceptCoachSharingNotice(@Request() req: AuthedRequest, @Body() body: CoachSharingNoticeDto) {
    return this.firstSignInSharing.accept(req.user.id, body.coach_sharing_notice);
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Request() req: AuthedRequest, @Body() body: RevokeConsentDto) {
    return this.consent.revoke(
      req.user.id,
      body.coach_id,
      body.scope,
      auditContext(req),
    );
  }

  // Coach-side read: a coach can ask "do I have access to client X for
  // scope Y?" without first calling listForClient on someone else's
  // behalf. Returns { granted: boolean }. Callers other than the
  // referenced coach get a 403 surface via the standard guard chain at
  // the higher level — here we just answer for the authenticated caller.
  @Get('check/:client_id/:scope')
  async check(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('scope') scope: string,
  ) {
    const granted = await this.consent.coachCanAccess(
      req.user.id,
      clientId,
      scope,
      req.user.role,
    );
    return { coach_id: req.user.id, client_id: clientId, scope, granted };
  }
}

// Best-effort extraction of remote IP + User-Agent for audit-log context.
// Mirrors helpers in coach.controller.ts and admin.controller.ts.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
