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
import { RomanClientContextService } from './context/roman-client-context.service';
import { RomanContextController } from './context/roman-context.controller';

@Module({
  // R3: RomanClientContextService grounds every client-surface turn and
  // serves GET /roman/context/me (RomanContextController).
  controllers: [RomanController, RomanContextController],
  providers: [
    RomanService,
    RomanFeatureGuard,
    romanAnthropicClientProvider,
    RomanClientContextService,
  ],
  exports: [RomanService, RomanClientContextService],
})
export class RomanModule {}
