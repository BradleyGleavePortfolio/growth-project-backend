import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { WearableInsightsService } from './wearable-insights.service';
import { WearableInsightsController } from './wearable-insights.controller';
import { InsightCacheService } from './insight-cache.service';

/**
 * PR-HK-4 — embedded AI insights module (backend, no UI).
 *
 * Wires the dual-role wearable insight surface:
 *   - {@link WearableInsightsService} — bucket+audience prompt selection,
 *     strict Zod output validation + single repair retry, no-medicalize
 *     guardrails, 30s timeout with graceful degradation, dual-role schema
 *     projection.
 *   - {@link InsightCacheService} — 6h TTL read/write over the PR-HK-0
 *     WearableInsightCache table (sync-driven invalidation is a row delete,
 *     performed by PR-HK-0's IngestionService — not edited here).
 *   - {@link WearableInsightsController} — coach + client GET endpoints plus
 *     the HK-6a coach approval POST endpoint.
 *
 * PR-HK-6 (HK-6a): the controller additionally injects AiApprovalService
 * (exported from the @Global AiGatewayModule) and PrismaService (global) for
 * the approve endpoint. Neither requires an import here — AiGatewayModule's
 * @Global registration provides AiApprovalService app-wide, and PrismaModule
 * is global too. No provider/import change is needed.
 *
 * REUSE, no edits:
 *   - AiGatewayService (src/ai/gateway) is injected directly — the
 *     AiGatewayModule is @Global, so it provides the single LLM seam
 *     (provider resolution, redaction, AiRequestAudit write, CoachAIBudget
 *     rate-limit + cost-cap) without this module importing it.
 *   - PrismaService is global (@Global PrismaModule) — injected without import.
 *
 * AuthModule is imported because the controller relies on the
 * JwtAuthGuard / CoachGuard / RolesGuard wiring (same pattern as the AI
 * gateway controller).
 */
@Module({
  imports: [AuthModule],
  controllers: [WearableInsightsController],
  providers: [WearableInsightsService, InsightCacheService],
  exports: [WearableInsightsService, InsightCacheService],
})
export class InsightsModule {}
