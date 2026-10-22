/**
 * /me/ai-consent — box 2 of the onboarding consent screen and the
 * Settings > Privacy "Roman and AI" row (D2 contract, R2a).
 *
 *   GET    /me/ai-consent        -> ClientAiConsentStatus (state + copy text + sha256)
 *          ?variant=coach_free   -> the coach-free copies (a client with no coach, owner 62)
 *          ?variant=safety_exception -> the coached client-ai-v6 / v7 copies (owner 57c)
 *          ?variant=crisis_alert -> client-ai-v8 / v9 (v6 / v7 + the crisis sentence) while
 *                                   FEATURE_ROMAN_CRISIS_ALERT is on, v6 / v7 while it is off
 *          ?variant=health_notes -> as crisis_alert, but every copy names the Health-page
 *                                   notes (owner #162-6): memory client-ai-v10 / v11, base v12 / v13
 *   POST   /me/ai-consent/roman  {version, copy_sha256?, platform?, app_version?, locale?}
 *                                -> grant (idempotent); 409 CONSENT_VERSION_MISMATCH; a client
 *                                   with no coach is recorded the same way (W-CONSENT)
 *   DELETE /me/ai-consent/roman  -> withdraw (idempotent)
 *   POST and DELETE take the same ?variant= for the status they return; without one it reads
 *   the copies on file (installed builds).
 *   GET    /me/ai-consent/coach          -> CoachAiConsentStatus (the coach's own grant, coach-ai-v1)
 *   POST   /me/ai-consent/coach          {version, copy_sha256, ...} -> grant (Allow)
 *   POST   /me/ai-consent/coach/decline  {version, copy_sha256, ...} -> "Not now"
 *   DELETE /me/ai-consent/coach          -> withdraw (the Settings switch). Coach and owner only.
 *
 * The subject is always req.user.id. Guards: JwtAuthGuard + RolesGuard +
 * AiConsentLedgerGuard (503 AI_CONSENT_UNAVAILABLE while
 * FEATURE_AI_CONSENT_LEDGER_ENABLED is off). Deliberately NOT behind
 * RomanFeatureGuard or any entitlement guard (Sol B1 on #601): reading and
 * withdrawing must not depend on Roman chat being switched on.
 *
 * Every response is `Cache-Control: no-store` (a device must never show a
 * cached "allowed" after a withdraw; the global interceptor would otherwise
 * mark the GET `private, max-age=60`).
 */
import {
  CanActivate,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  AI_CONSENT_ACTION_DECLINE,
  AI_CONSENT_ACTION_GRANT,
  AI_CONSENT_ACTION_WITHDRAW,
  AI_CONSENT_ERROR_UNAVAILABLE,
  isAiConsentLedgerEnabled,
} from './ai-consent.constants';
import { GrantClientAiConsentDto } from './ai-consent.dto';
import {
  AiConsentService,
  type ClientAiConsentAsk,
  type ClientAiConsentStatus,
  type CoachAiConsentStatus,
} from './ai-consent.service';
import { AllowBeforeAgeConfirmed } from '../auth/client-age';

/** 503 on every ledger route while the flag is off (runs before body validation). */
@Injectable()
export class AiConsentLedgerGuard implements CanActivate {
  canActivate(): boolean {
    if (!isAiConsentLedgerEnabled()) {
      throw new ServiceUnavailableException({
        code: AI_CONSENT_ERROR_UNAVAILABLE,
        message: 'This choice is unavailable right now.',
      });
    }
    return true;
  }
}

/**
 * ?variant= as the copies the app shows, read the same way on GET, POST and DELETE, so every
 * response offers them (owner 57c, CONSENTV7, CRISIS-APP-COPY). Any other value (or none) reads the
 * copies a plain GET offers, as before. A client with a coach never reads a coach-free grant as live
 * (owner 62).
 */
function askOf(req: AuthedRequest, variant: unknown): ClientAiConsentAsk {
  const hasCoach = typeof req.user.coach_id === 'string' && req.user.coach_id.length > 0;
  return {
    hasCoach,
    coachFree: variant === 'coach_free',
    safetyException: variant === 'safety_exception',
    crisisAlert: variant === 'crisis_alert' || variant === 'health_notes',
    healthNotes: variant === 'health_notes',
  };
}

@Controller('me/ai-consent')
@UseGuards(JwtAuthGuard, RolesGuard, AiConsentLedgerGuard)
@AllowBeforeAgeConfirmed()
export class AiConsentController {
  constructor(private readonly consent: AiConsentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles('student', 'coach', 'owner')
  async get(
    @Req() req: AuthedRequest,
    @Query('variant') variant?: unknown,
  ): Promise<ClientAiConsentStatus> {
    return this.consent.getStatus(req.user.id, askOf(req, variant));
  }

  @Post('roman')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async grant(
    @Req() req: AuthedRequest,
    @Body() dto: GrantClientAiConsentDto,
    @Query('variant') variant?: unknown,
  ): Promise<ClientAiConsentStatus> {
    // W-CONSENT: a client with no coach is asked once and the grant is kept like a coached one;
    // Roman and every AI route still answer 403 ROMAN_REQUIRES_COACH until a coach is linked.
    const ask = variant === undefined ? undefined : askOf(req, variant);
    return this.consent.grant(req.user.id, dto, {}, ask);
  }

  @Delete('roman')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async withdraw(
    @Req() req: AuthedRequest,
    @Query('variant') variant?: unknown,
  ): Promise<ClientAiConsentStatus> {
    const ask = variant === undefined ? undefined : askOf(req, variant);
    return this.consent.withdraw(req.user.id, {}, ask);
  }

  // COACH-AI-CONSENT (owner ruling op 2): the one-time ask reads `asked`, so it shows once per account.
  @Get('coach')
  @Header('Cache-Control', 'no-store')
  @Roles('coach', 'owner')
  async getCoach(@Req() req: AuthedRequest): Promise<CoachAiConsentStatus> {
    return this.consent.getCoachStatus(req.user.id);
  }

  @Post('coach')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('coach', 'owner')
  async grantCoach(
    @Req() req: AuthedRequest,
    @Body() dto: GrantClientAiConsentDto,
  ): Promise<CoachAiConsentStatus> {
    return this.consent.decideCoach(req.user.id, AI_CONSENT_ACTION_GRANT, dto);
  }

  @Post('coach/decline')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('coach', 'owner')
  async declineCoach(
    @Req() req: AuthedRequest,
    @Body() dto: GrantClientAiConsentDto,
  ): Promise<CoachAiConsentStatus> {
    return this.consent.decideCoach(req.user.id, AI_CONSENT_ACTION_DECLINE, dto);
  }

  @Delete('coach')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('coach', 'owner')
  async withdrawCoach(@Req() req: AuthedRequest): Promise<CoachAiConsentStatus> {
    return this.consent.decideCoach(req.user.id, AI_CONSENT_ACTION_WITHDRAW);
  }
}
