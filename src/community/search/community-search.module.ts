import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySearchController } from './community-search.controller';
import { CommunitySearchEnabledGuard } from './community-search-flag.guard';
import { CommunitySearchRepository } from './community-search.repository';
import { CommunitySearchService } from './community-search.service';
import { SearchIndexerListener } from './search-indexer.listener';
import { SearchIndexerService } from './search-indexer.service';

/**
 * v3-4 community search module — full-text search across posts / classroom
 * lessons / voice-note transcripts / events, RLS-scoped to the caller's
 * visible cohorts + role.
 *
 * A SELF-CONTAINED module (mirrors CommunityVoiceModule / CommunityClassroom-
 * Module), registered as a single line in CommunityModule.imports so the rebase
 * against main stays a clean 3-way merge (R77 coordination rule).
 *
 *   - AuthModule supplies JwtAuthGuard / RolesGuard (same as every community
 *     surface).
 *   - CommunityAccessService is the shared v1-3 tenancy resolver (membership /
 *     cohort visibility); provided here so the slice owns its instance.
 *   - SearchIndexerService + SearchIndexerListener write PII-stripped search
 *     rows on a producer's create/update/soft-delete. They are EXPORTED so a
 *     future producer lane (posts / voice / events) can inject the listener and
 *     call it after its durable insert — the v3-4 lane does NOT edit those
 *     producers itself (R77 scope).
 *   - PrismaService + AnalyticsService come from their @Global modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [CommunitySearchController],
  providers: [
    CommunitySearchService,
    CommunitySearchRepository,
    CommunitySearchEnabledGuard,
    CommunityAccessService,
    CommunityFeatureFlagGuard,
    SearchIndexerService,
    SearchIndexerListener,
  ],
  exports: [SearchIndexerService, SearchIndexerListener],
})
export class CommunitySearchModule {}
