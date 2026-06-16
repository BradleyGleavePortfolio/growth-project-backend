import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { InsightsModule } from '../../wearables/insights/insights.module';
import { SamplesModule } from '../../wearables/samples/samples.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityWearablePromptsController } from './wearable-prompts.controller';
import { CommunityWearablePromptsEnabledGuard } from './wearable-prompts-flag.guard';
import { DegradedConnectorFallbackService } from './degraded-connector-fallback.service';
import { PromptGeneratorService } from './prompt-generator.service';
import { WearablePromptsRepository } from './wearable-prompts.repository';
import {
  CLOCK,
  defaultClock,
  WearablePromptsService,
} from './wearable-prompts.service';

/**
 * v3-4 wearable-aware coaching-prompts module (COACH-ONLY).
 *
 * A SELF-CONTAINED module (mirrors CommunitySearchModule / CommunityVoiceModule)
 * registered as a single line in CommunityModule.imports so the merge against
 * main stays a clean 3-way merge (R77 coordination rule).
 *
 *   - AuthModule supplies JwtAuthGuard / RolesGuard.
 *   - InsightsModule exports WearableInsightsService (the single source of truth
 *     for the coach-owns-client relationship via assertCoachOwnsClient) — we
 *     CONSUME it, never re-implement it (R77 scope).
 *   - SamplesModule exports WearableSamplesService, which PromptGeneratorService
 *     reads the trend series from.
 *   - CommunityAccessService is the shared v1-3 tenancy resolver; provided here
 *     so the slice owns its instance.
 *   - ConsentService comes from the @Global ConsentModule (the live consent
 *     re-check at generation time); PrismaService + AnalyticsService likewise
 *     come from their @Global modules — none are re-provided here.
 *
 * NOTE: this slice does NOT wire any producer/cron that auto-generates prompts.
 * Generation is coach-initiated through the controller only (R77 — the v3-4
 * lane ships the surface + defenses, not a background producer).
 */
@Module({
  imports: [AuthModule, InsightsModule, SamplesModule],
  controllers: [CommunityWearablePromptsController],
  providers: [
    WearablePromptsService,
    WearablePromptsRepository,
    // Injectable wall-clock seam for the 24h cooldown gate (PR #405 N3).
    { provide: CLOCK, useValue: defaultClock },
    CommunityWearablePromptsEnabledGuard,
    CommunityAccessService,
    CommunityFeatureFlagGuard,
    DegradedConnectorFallbackService,
    PromptGeneratorService,
  ],
})
export class CommunityWearablePromptsModule {}
