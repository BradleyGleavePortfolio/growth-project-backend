/**
 * /me/ai-consent — box 2 of the onboarding consent screen and the
 * Settings > Privacy "Roman and AI" row (D2 contract, R2a).
 *
 *   GET    /me/ai-consent        -> ClientAiConsentStatus (state + copy text + sha256)
 *   POST   /me/ai-consent/roman  {version, copy_sha256?, platform?, app_version?, locale?}
 *                                -> grant (idempotent); 409 CONSENT_VERSION_MISMATCH
 *   DELETE /me/ai-consent/roman  -> withdraw (idempotent)
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
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AI_CONSENT_ERROR_UNAVAILABLE, isAiConsentLedgerEnabled } from './ai-consent.constants';
import { GrantClientAiConsentDto } from './ai-consent.dto';
import { AiConsentService, type ClientAiConsentStatus } from './ai-consent.service';

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

@Controller('me/ai-consent')
@UseGuards(JwtAuthGuard, RolesGuard, AiConsentLedgerGuard)
export class AiConsentController {
  constructor(private readonly consent: AiConsentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles('student', 'coach', 'owner')
  async get(@Req() req: AuthedRequest): Promise<ClientAiConsentStatus> {
    return this.consent.getStatus(req.user.id);
  }

  @Post('roman')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async grant(
    @Req() req: AuthedRequest,
    @Body() dto: GrantClientAiConsentDto,
  ): Promise<ClientAiConsentStatus> {
    return this.consent.grant(req.user.id, dto);
  }

  @Delete('roman')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async withdraw(@Req() req: AuthedRequest): Promise<ClientAiConsentStatus> {
    return this.consent.withdraw(req.user.id);
  }
}
