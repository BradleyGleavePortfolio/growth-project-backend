/**
 * RomanModule — Phase 1 chat MVP wiring (brief §1.2).
 *
 * The module is ALWAYS imported by AppModule (so the module-graph cycle guard
 * keeps exercising it), but the surface is dark by default: RomanFeatureGuard
 * returns 404 on every route while FEATURE_ROMAN_CHAT_ENABLED is OFF, and
 * RomanService re-checks the flag before any Anthropic call. This mirrors the
 * DunningV2Module / PayoutsV2Module posture (mount-then-self-gate) rather than
 * a conditional import, which keeps the dependency graph static and testable.
 *
 * PrismaService is provided by its @Global module. Roman owns its OWN Anthropic
 * client behind ROMAN_ANTHROPIC_CLIENT (brief §4) to keep a clean blast radius
 * away from the churned src/ai/* coach-AI adapter.
 */

import { Module } from '@nestjs/common';
import { RomanController } from './roman.controller';
import { RomanService } from './roman.service';
import { RomanFeatureGuard } from './roman-feature.guard';
import { romanAnthropicClientProvider } from './anthropic-client.provider';
import { RomanModelHealthService } from './model/roman-model-health.service';
import { RomanHealthController } from './model/roman-health.controller';

@Module({
  // RomanHealthController serves GET /health/roman (@Public, no feature gate)
  // so the operator and the deploy smoke can see model health while the chat
  // surface itself stays dark behind RomanFeatureGuard.
  controllers: [RomanController, RomanHealthController],
  providers: [
    RomanService,
    RomanFeatureGuard,
    romanAnthropicClientProvider,
    RomanModelHealthService,
  ],
  exports: [RomanService, RomanModelHealthService],
})
export class RomanModule {}
