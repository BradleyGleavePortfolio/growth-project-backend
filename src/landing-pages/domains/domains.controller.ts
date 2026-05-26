/**
 * Coach custom-domain endpoints — R49 Phase 4.
 *
 * Routes are gated by @Roles('coach','owner') + the global JwtAuthGuard.
 * Tight surface: create, list, instructions, verify-now, revoke.
 *
 * Mounted under /api/v1/coach/landing-pages/:landingPageId/domains —
 * extends the existing landing-pages prefix so we do not introduce a
 * new top-level route family.
 */

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
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { CoachDomainsService } from './domains.service';

interface CreateDomainBody {
  domain: string;
}

@ApiTags('landing-pages-domains')
@Roles('coach', 'owner')
// Mutations are rare (a coach claims one or two domains, ever) so a
// generous bucket suffices; the worker tick polls DB, not this API.
@Throttle({ default: { ttl: 60_000, limit: 20 } })
@Controller('v1/coach/landing-pages/:landingPageId/domains')
export class CoachDomainsController {
  constructor(private readonly service: CoachDomainsService) {}

  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('landingPageId') landingPageId: string,
    @Body() body: CreateDomainBody,
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({ error: 'INVALID_BODY' });
    }
    return this.service.create(req.user.id, landingPageId, body.domain);
  }

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Param('landingPageId') landingPageId: string,
  ) {
    return this.service.listForPage(req.user.id, landingPageId);
  }

  @Get(':domainId/instructions')
  async instructions(
    @Request() req: AuthedRequest,
    @Param('landingPageId') landingPageId: string,
    @Param('domainId') domainId: string,
  ) {
    return this.service.getInstructions(req.user.id, landingPageId, domainId);
  }

  @Post(':domainId/verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Request() req: AuthedRequest,
    @Param('landingPageId') landingPageId: string,
    @Param('domainId') domainId: string,
  ) {
    return this.service.verifyNow(req.user.id, landingPageId, domainId);
  }

  @Delete(':domainId')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Request() req: AuthedRequest,
    @Param('landingPageId') landingPageId: string,
    @Param('domainId') domainId: string,
  ) {
    return this.service.revoke(req.user.id, landingPageId, domainId);
  }
}
