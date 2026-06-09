import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { CommunityRepository } from './community.repository';
import { CommunityFeatureFlagGuard } from './community-feature-flag.guard';
import {
  CommunityDmEnabledGuard,
  CommunityMessagesEnabledGuard,
  CommunityPostsEnabledGuard,
} from './community-write-flag.guard';
import { CommunityAccessService } from './community-access.service';
import { CommunityMessagesController } from './messages/community-messages.controller';
import { CommunityMessagesService } from './messages/community-messages.service';
import { CommunityMessagesRepository } from './messages/community-messages.repository';
import { CommunityPostsController } from './posts/community-posts.controller';
import { CommunityPostsService } from './posts/community-posts.service';
import { CommunityPostsRepository } from './posts/community-posts.repository';
import { CommunityReactionsController } from './reactions/community-reactions.controller';
import { CommunityReactionsService } from './reactions/community-reactions.service';
import { CommunityReactionsRepository } from './reactions/community-reactions.repository';
import { CommunityDmsController } from './dms/community-dms.controller';
import { CommunityDmsService } from './dms/community-dms.service';
import { CommunityDmsRepository } from './dms/community-dms.repository';
import { CommunityModerationController } from './moderation/community-moderation.controller';
import { CommunityModerationService } from './moderation/community-moderation.service';
import { CommunityModerationRepository } from './moderation/community-moderation.repository';
import { AuthModule } from '../auth/auth.module';
import { CommunityRealtimeModule } from './realtime/community-realtime.module';
import { CommunityNotificationsModule } from './notifications/community-notifications.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [AuthModule, CommunityRealtimeModule, CommunityNotificationsModule],
  controllers: [
    CommunityController,
    CommunityMessagesController,
    CommunityPostsController,
    CommunityReactionsController,
    CommunityDmsController,
    CommunityModerationController,
  ],
  providers: [
    CommunityService,
    CommunityRepository,
    CommunityFeatureFlagGuard,
    CommunityMessagesEnabledGuard,
    CommunityPostsEnabledGuard,
    CommunityDmEnabledGuard,
    CommunityAccessService,
    CommunityMessagesService,
    CommunityMessagesRepository,
    CommunityPostsService,
    CommunityPostsRepository,
    CommunityReactionsService,
    CommunityReactionsRepository,
    CommunityDmsService,
    CommunityDmsRepository,
    CommunityModerationService,
    CommunityModerationRepository,
  ],
  exports: [],
})
export class CommunityModule {}
