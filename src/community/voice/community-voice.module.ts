import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityRealtimeModule } from '../realtime/community-realtime.module';
import { CommunityVoiceController } from './community-voice.controller';
import { CommunityVoiceEnabledGuard } from './community-voice-flag.guard';
import { CommunityVoiceRepository } from './community-voice.repository';
import { CommunityVoiceService } from './community-voice.service';
import { VoiceUploadProvider } from './voice-upload.provider';

/**
 * v3-3 community voice-notes module — audio attachments into cohort /
 * workspace-hall channels and DM threads.
 *
 * A SELF-CONTAINED module (mirrors CommunityClassroomModule / AiTriageModule /
 * AckModule) registered as a single line at the BOTTOM of
 * CommunityModule.imports. Keeping the slice's wiring in one file is the
 * brief's coordination rule: v3-2 added one import line, v3-3 adds its own line
 * below it, so the rebase against main stays a clean 3-way merge.
 *
 * The pieces, and why each is sourced the way it is:
 *   - AuthModule supplies JwtAuthGuard / RolesGuard — the same import every
 *     other community surface uses (mirrors CommunityClassroomModule).
 *   - CommunityRealtimeModule provides + exports CommunityRealtimeService for
 *     the best-effort post-insert ping. We REUSE the existing closed
 *     postCreated broadcast contract rather than widening the closed payload
 *     union, so no realtime-types change is needed (R77 scope).
 *   - CommunityAccessService is the shared v1-3 tenancy resolver
 *     (findWorkspace / findCohort / isWorkspaceCoach / canAccess* /
 *     listAccessibleCohortIds). Provided here so the slice owns its instance,
 *     matching how CommunityClassroomModule provides the services it needs.
 *   - VoiceUploadProvider is the extracted signed-upload / signed-download
 *     helper (lifted out of messaging.service.ts). It injects SupabaseService,
 *     which is exported by the @Global SupabaseModule, so it needs no explicit
 *     import here.
 *   - CommunityFeatureFlagGuard is the master kill-switch guard; the slice
 *     CommunityVoiceEnabledGuard is the FEATURE_COMMUNITY_VOICE_NOTES flag
 *     guard. Both are referenced by the controller.
 *   - AnalyticsService (telemetry) and SupabaseService come from their @Global
 *     modules and need no explicit import.
 */
@Module({
  imports: [AuthModule, CommunityRealtimeModule],
  controllers: [CommunityVoiceController],
  providers: [
    CommunityVoiceService,
    CommunityVoiceRepository,
    CommunityVoiceEnabledGuard,
    CommunityAccessService,
    CommunityFeatureFlagGuard,
    VoiceUploadProvider,
  ],
  exports: [CommunityVoiceService],
})
export class CommunityVoiceModule {}
