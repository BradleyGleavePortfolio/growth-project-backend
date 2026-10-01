/**
 * GET /health/roman — unauthenticated, PII-free Roman model health
 * (PLAN_roman_intelligence §3, slice R1).
 *
 * Returns `{status, enabled, primary_model, fallback_model, probed_at}`.
 *   200  ready | degraded | unprobed, or any state while the feature flag is
 *        OFF (a dark surface is not a deploy failure);
 *   503  down | unconfigured while FEATURE_ROMAN_CHAT_ENABLED=true, so a
 *        deploy smoke that curls this path fails when Roman cannot answer.
 *
 * Lives beside /health/deep (HealthDeepController) rather than inside
 * RomanController: the Roman controller is behind JwtAuthGuard +
 * RomanFeatureGuard (404 while dark), and a health probe must be reachable by
 * the operator regardless.
 */

import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { isRomanChatEnabled } from '../roman.feature';
import { RomanModelHealthService } from './roman-model-health.service';

@ApiExcludeController()
@Public()
@Controller('health')
export class RomanHealthController {
  constructor(private readonly health: RomanModelHealthService) {}

  @Get('roman')
  @Header('Cache-Control', 'no-store')
  roman(@Res({ passthrough: true }) res: Response) {
    const s = this.health.getStatus();
    const enabled = isRomanChatEnabled();
    const failing = s.status === 'down' || s.status === 'unconfigured';
    if (enabled && failing) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: s.status,
      enabled,
      primary_model: s.primary_model,
      fallback_model: s.fallback_model,
      primary_ok: s.primary_ok,
      fallback_ok: s.fallback_ok,
      probed_at: s.probed_at,
      ...(s.reason ? { reason: s.reason } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}
