import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityCoachInboxRepository } from '../inbox/community-coach-inbox.repository';
import { AiTriageController } from './ai-triage.controller';
import { AiTriageFeatureFlagGuard } from './ai-triage-flag.guard';
import { AiTriageService } from './ai-triage.service';
import { TriageCacheService } from './triage-cache.service';

/**
 * v2-4 community AI inbox-triage module.
 *
 * Wires the read-only triage generation endpoint. The pieces, and why each is
 * sourced the way it is:
 *   - AuthModule supplies JwtAuthGuard / RolesGuard — the same import every
 *     other community surface uses (mirrors AckModule).
 *   - CommunityCoachInboxRepository is the v1-6 tenant-scoped candidate source
 *     (coachedCohortIds + unansweredMessages/Posts). We REUSE it rather than
 *     re-deriving the tenant boundary, so triage can only ever read cohorts the
 *     requesting coach actually coaches.
 *   - TriageCacheService is the in-process freshness cache (R69: no new Prisma
 *     table — triage is derived on read and cached with invalidation keyed off
 *     the candidate set fingerprint).
 *   - AiGatewayService is exported from the @Global AiGatewayModule, so it
 *     needs no explicit import here (same as the wearables insights module).
 *
 * No messaging service, materialiser, or AiApprovalService is provided here:
 * triage is CLASSIFY-only and has no write/send path by construction (the
 * "no autonomous send" invariant is structural, not a runtime check).
 */
@Module({
  imports: [AuthModule],
  controllers: [AiTriageController],
  providers: [
    AiTriageService,
    TriageCacheService,
    CommunityCoachInboxRepository,
    CommunityAccessService,
    AiTriageFeatureFlagGuard,
    CommunityFeatureFlagGuard,
  ],
  exports: [AiTriageService, TriageCacheService],
})
export class AiTriageModule {}
