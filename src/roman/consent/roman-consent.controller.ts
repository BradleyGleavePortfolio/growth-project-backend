/**
 * /me/ai-consent — the consent record the mobile sheet reads and writes
 * (PLAN_roman_intelligence §6.2, slice R2).
 *
 *   GET    /me/ai-consent          {roman: {granted, version, granted_at, revoked_at, current_version, needs_reconsent}}
 *   POST   /me/ai-consent/roman    {version, copy_sha256?, platform?, app_version?, locale?}
 *   DELETE /me/ai-consent/roman    revoke (idempotent)
 *
 * Subject is always req.user.id. Behind JwtAuthGuard + RolesGuard +
 * RomanFeatureGuard: the routes are 404 while FEATURE_ROMAN_CHAT_ENABLED is
 * OFF, the same dark-by-default posture as every /roman route.
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
import { RomanFeatureGuard } from '../roman-feature.guard';
import { GrantRomanConsentDto } from './roman-consent.dto';
import { RomanConsentService } from './roman-consent.service';

@Controller('me/ai-consent')
@UseGuards(JwtAuthGuard, RolesGuard, RomanFeatureGuard)
export class RomanConsentController {
  constructor(private readonly consent: RomanConsentService) {}

  @Get()
  @Roles('student', 'coach', 'owner')
  async get(@Req() req: AuthedRequest) {
    return this.consent.getStatus(req.user.id);
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
