/**
 * Custom-domain admin routes for a landing page (CNAME Phase 4).
 *
 * Mounted under `/api/v1/coach/landing-pages/:id/custom-domain`.  Auth
 * is the global JwtAuthGuard; `@Roles('coach','owner')` is the
 * authoritative gate (matches LandingPageController's pattern).
 *
 * Endpoints
 *   POST   /:id/custom-domain          — claim a domain (race-safe; 409 on collision)
 *   POST   /:id/custom-domain/verify   — resolve CNAME with 3s hard timeout
 *   DELETE /:id/custom-domain          — release the binding
 *
 * Throttle: 10/min/user — claim/verify is cheap but DNS-bound; this stops
 * a coach from drowning our resolver in retries.
 */

import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { CustomDomainService } from './custom-domain.service';

export class ClaimCustomDomainDto {
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain!: string;
}

@ApiTags('landing-pages-custom-domain')
@Roles('coach', 'owner')
@Throttle({ default: { ttl: 60_000, limit: 10 } })
@Controller('v1/coach/landing-pages/:id/custom-domain')
export class CustomDomainController {
  constructor(private readonly service: CustomDomainService) {}

  /**
   * Bind a custom domain to a page. Race-safe: two simultaneous claims
   * for the same domain result in exactly one 200 + one 409.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async claim(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ClaimCustomDomainDto,
  ) {
    return this.service.claim(req.user.id, id, dto.domain);
  }

  /**
   * Resolve the bound domain's CNAME with a hard 3s timeout.
   * Always returns 200 with a structured outcome — never hangs.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.verify(req.user.id, id);
  }

  /** Remove the binding. Idempotent. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  async release(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.service.release(req.user.id, id);
  }
}
