import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { CommunityLeaveMuteController } from './community-leave-mute.controller';
import { CommunityLeaveMuteService } from './community-leave-mute.service';

/** LEAVE-MUTE-BE (agent 176): leave a space, mute or leave a thread. A self-contained module registered as one
 *  line in CommunityModule.imports (the voice module's pattern). */
@Module({
  imports: [AuthModule],
  controllers: [CommunityLeaveMuteController],
  providers: [CommunityLeaveMuteService, CommunityAccessService, CommunitySafetyService, CommunityFeatureFlagGuard],
})
export class CommunityLeaveMuteModule {}
