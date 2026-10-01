/**
 * /me/ai-consent — the consent record the mobile sheet reads and writes
 * (PLAN_roman_intelligence §6.2, slice R2).
 *
 *   GET    /me/ai-consent             {roman: {granted, version, granted_at, revoked_at, current_version,
 *                                      needs_reconsent, waiver_version, waiver_accepted_at, waiver_current_version},
 *                                      copy: {version, text, sha256, processor, data_categories}}
 *   POST   /me/ai-consent/onboarding  {ai_consent_version, waiver_version, copy_sha256?, platform?, app_version?, locale?}
 *                                      — the single onboarding "I agree" box (ruling #5)
 *   POST   /me/ai-consent/roman       {version, copy_sha256?, platform?, app_version?, locale?} — re-consent sheet
 *   DELETE /me/ai-consent/roman       revoke (idempotent)
 *
 * Subject is always req.user.id. Behind JwtAuthGuard + RolesGuard ONLY.
 * Deliberately NOT behind RomanFeatureGuard (Sol audit of #601, finding B1):
 * a user must be able to read and WITHDRAW consent whether or not Roman chat
 * is switched on, and onboarding records the grant before the chat flag is
 * flipped at go/no-go. Chat itself stays dark while the flag is off.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/auth.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GrantOnboardingConsentDto, GrantRomanConsentDto } from './roman-consent.dto';
import { RomanConsentService } from './roman-consent.service';

@Controller('me/ai-consent')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RomanConsentController {
  constructor(private readonly consent: RomanConsentService) {}

  @Get()
  @Roles('student', 'coach', 'owner')
  async get(@Req() req: AuthedRequest) {
    return this.consent.getStatus(req.user.id);
  }

  /** The single onboarding "I agree" box: AI processing grant + PT waiver. */
  @Post('onboarding')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async grantOnboarding(
    @Req() req: Request & AuthedRequest,
    @Body() dto: GrantOnboardingConsentDto,
  ) {
    return this.consent.grantOnboarding(req.user.id, dto, {
      actorRole: req.user.role,
      ip: req.ip ?? null,
      userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  }

  @Post('roman')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async grant(@Req() req: Request & AuthedRequest, @Body() dto: GrantRomanConsentDto) {
    return this.consent.grant(req.user.id, dto, {
      actorRole: req.user.role,
      ip: req.ip ?? null,
      userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  }

  @Delete('roman')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async revoke(@Req() req: Request & AuthedRequest) {
    return this.consent.revoke(req.user.id, {
      actorRole: req.user.role,
      ip: req.ip ?? null,
      userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  }
}
