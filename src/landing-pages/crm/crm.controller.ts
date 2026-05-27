/**
 * Coach CRM management endpoints.
 *
 * All routes are gated by the global JwtAuthGuard + RolesGuard.  @Roles
 * binds to coach + owner (owner can manage any coach's integration via
 * Healthie-style bypass — see RolesGuard).
 *
 * Routes:
 *   POST   /api/v1/coach/landing-pages/crm
 *   GET    /api/v1/coach/landing-pages/crm
 *   DELETE /api/v1/coach/landing-pages/crm/:provider
 *   POST   /api/v1/coach/landing-pages/crm/:provider/test
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
import type { CrmProvider } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { CoachCrmService } from './crm.service';

const ALLOWED_PROVIDERS: ReadonlyArray<CrmProvider> = [
  'hubspot',
  'gohighlevel',
  'mailchimp',
  'activecampaign',
  'webhook',
];

function assertProvider(raw: string): CrmProvider {
  if (!ALLOWED_PROVIDERS.includes(raw as CrmProvider)) {
    throw new BadRequestException({ error: 'INVALID_PROVIDER', provider: raw });
  }
  return raw as CrmProvider;
}

interface UpsertBody {
  provider: string;
  config: Record<string, string>;
}

@ApiTags('landing-pages-crm')
@Roles('coach', 'owner')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
@Controller('v1/coach/landing-pages/crm')
export class CrmController {
  constructor(private readonly service: CoachCrmService) {}

  @Post()
  async upsert(@Request() req: AuthedRequest, @Body() body: UpsertBody) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({ error: 'INVALID_BODY' });
    }
    const provider = assertProvider(body.provider);
    return this.service.upsert(req.user.id, provider, body.config ?? {});
  }

  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.service.list(req.user.id);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: AuthedRequest, @Param('provider') provider: string) {
    await this.service.remove(req.user.id, assertProvider(provider));
  }

  @Post(':provider/test')
  @HttpCode(HttpStatus.OK)
  async test(@Request() req: AuthedRequest, @Param('provider') provider: string) {
    return this.service.testPush(req.user.id, assertProvider(provider));
  }
}
