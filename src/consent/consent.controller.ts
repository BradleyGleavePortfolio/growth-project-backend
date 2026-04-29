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
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { ConsentService } from './consent.service';
import { GrantConsentDto, RevokeConsentDto } from './consent.dto';

// Client-facing consent surface. Mounted at /consent/* so the mobile app
// has one path prefix to learn. Every route requires a logged-in user;
// the caller is always treated as the client (clients grant/revoke for
// themselves).
@ApiTags('consent')
@Controller('consent')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  // GET /consent/scopes — static list of canonical scope strings, so the
  // mobile UI can render a toggle per scope without hard-coding them.
  @Get('scopes')
  listScopes() {
    return { scopes: ConsentService.listScopes() };
  }

  // GET /consent/me?coach_id=... — full per-scope state for one coach
  // (defaults to the caller's primary coach). Returns every scope, with
  // unset scopes flagged `granted: false`.
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
    const consents = await this.consent.listForClient(req.user.id, coachId);
    return { client_id: req.user.id, coach_id: coachId, consents };
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
