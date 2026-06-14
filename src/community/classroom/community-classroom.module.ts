import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityClassroomController } from './community-classroom.controller';
import { CommunityClassroomEnabledGuard } from './community-classroom-flag.guard';
import { CommunityClassroomRepository } from './community-classroom.repository';
import { CommunityClassroomService } from './community-classroom.service';

/**
 * v3-2 community classroom-posts module — media-backed lessons.
 *
 * A SELF-CONTAINED module (mirrors AiTriageModule / AckModule) registered as a
 * single line in CommunityModule.imports, rather than inlining its providers
 * into community.module.ts. This keeps the v3-2 slice's wiring in one file and
 * makes the v3-3 voice rebase a clean 3-way merge (the brief's coordination
 * rule: v3-2 adds ONE import line at the BOTTOM of the imports array, v3-3 adds
 * its own line below that).
 *
 * The pieces, and why each is sourced the way it is:
 *   - AuthModule supplies JwtAuthGuard / RolesGuard — the same import every
 *     other community surface uses (mirrors AckModule / AiTriageModule).
 *   - CommunityAccessService is the shared v1-3 tenancy resolver
 *     (findWorkspace / findCohort / isWorkspaceCoach / canAccess* /
 *     listAccessibleCohortIds). Provided here so the slice owns its instance,
 *     matching how AiTriageModule provides the services it needs.
 *   - CommunityFeatureFlagGuard is the master kill-switch guard the read +
 *     write handlers both reference.
 *   - The StorageProvider the service injects (STORAGE_PROVIDER) is exported by
 *     the @Global CoachMediaModule, so it needs no explicit import here — the
 *     same way AiGatewayService is consumed from its @Global module.
 *   - ConfigService (signed-URL TTL) comes from the @Global ConfigModule.
 *
 * No realtime/notifications wiring: the classroom feed rides the 60s REST poll
 * floor (the documented best-effort doctrine in community-events.ts). Adding a
 * realtime broadcast would require a new payload type in the closed
 * CommunityBroadcastPayload union (out of this lane's OWNS), so it is
 * intentionally deferred — see the PR "Declared deviations" entry.
 */
@Module({
  imports: [AuthModule],
  controllers: [CommunityClassroomController],
  providers: [
    CommunityClassroomService,
    CommunityClassroomRepository,
    CommunityClassroomEnabledGuard,
    CommunityAccessService,
    CommunityFeatureFlagGuard,
  ],
  exports: [CommunityClassroomService],
})
export class CommunityClassroomModule {}
