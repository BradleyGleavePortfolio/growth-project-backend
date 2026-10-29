import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { CommunityRealtimeModule } from '../realtime/community-realtime.module';
import { CommunityLeaveMuteController } from './community-leave-mute.controller';
import { CommunityLeaveMuteService } from './community-leave-mute.service';

/** LEAVE-MUTE-BE (agent 176): leave a space, mute or leave a thread. A self-contained module registered as one
 *  line in CommunityModule.imports (the voice module's pattern). FR-1168R2 B2: the realtime module (the one
 *  shared broadcaster) for the ids-only ping on a leave or a join. */
@Module({
  imports: [AuthModule, CommunityRealtimeModule],
  controllers: [CommunityLeaveMuteController],
  providers: [CommunityLeaveMuteService, CommunityAccessService, CommunitySafetyService, CommunityFeatureFlagGuard],
})
export class CommunityLeaveMuteModule {}
