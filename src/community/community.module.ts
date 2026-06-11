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
// v1-6 coach admin: cohort write, membership administration, coach inbox.
import { CommunityCohortWriteController } from './cohorts/community-cohort-write.controller';
import { CommunityCohortWriteService } from './cohorts/community-cohort-write.service';
import { CommunityCohortWriteRepository } from './cohorts/community-cohort-write.repository';
import { CommunityCohortMembersController } from './cohorts/community-cohort-members.controller';
import { CommunityCohortMembersService } from './cohorts/community-cohort-members.service';
import { CommunityCohortMembersRepository } from './cohorts/community-cohort-members.repository';
import { CommunityCoachInboxController } from './inbox/community-coach-inbox.controller';
import { CommunityCoachInboxService } from './inbox/community-coach-inbox.service';
import { CommunityCoachInboxRepository } from './inbox/community-coach-inbox.repository';
import { AuthModule } from '../auth/auth.module';
import { CommunityRealtimeModule } from './realtime/community-realtime.module';
import { CommunityNotificationsModule } from './notifications/community-notifications.module';
// v2-1 plan-context tags: read-only resolve surface + PlanContextService
// (consumed by CommunityMessagesService on send to validate an attached tag).
import { PlanContextModule } from './plan-context/plan-context.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [
    AuthModule,
    CommunityRealtimeModule,
    CommunityNotificationsModule,
    PlanContextModule,
  ],
  controllers: [
    CommunityController,
    CommunityMessagesController,
    CommunityPostsController,
    CommunityReactionsController,
    CommunityDmsController,
    CommunityModerationController,
    CommunityCohortWriteController,
    CommunityCohortMembersController,
    CommunityCoachInboxController,
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
    CommunityCohortWriteService,
    CommunityCohortWriteRepository,
    CommunityCohortMembersService,
    CommunityCohortMembersRepository,
    CommunityCoachInboxService,
    CommunityCoachInboxRepository,
  ],
  exports: [],
})
export class CommunityModule {}
