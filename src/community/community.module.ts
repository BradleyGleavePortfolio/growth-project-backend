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
// v1-6 coach-community empty-state copy (Roman face+voice contract).
import { CommunityCoachEmptyStatesController } from './inbox/community-coach-empty-states.controller';
// v3-1 challenges: join, progress, opt-in leaderboard, comments, coach CRUD.
import { CommunityChallengesController } from './challenges/community-challenges.controller';
import { CommunityChallengesService } from './challenges/community-challenges.service';
import { CommunityChallengesRepository } from './challenges/community-challenges.repository';
import { CommunityChallengesEnabledGuard } from './challenges/community-challenges-flag.guard';
import { VoicePolicyService } from '../roman/voice/voice-policy.service';
import { AuthModule } from '../auth/auth.module';
import { CommunityRealtimeModule } from './realtime/community-realtime.module';
import { CommunityNotificationsModule } from './notifications/community-notifications.module';
// v2-1 plan-context tags: read-only resolve surface + PlanContextService
// (consumed by CommunityMessagesService on send to validate an attached tag).
import { PlanContextModule } from './plan-context/plan-context.module';
// v2-2 coach ack signals: transition surface + AckService (consumed by the
// messages/inbox read surfaces to enrich responses with the ack envelope when
// FEATURE_COMMUNITY_ACKS is on). Module exports AckService for that reuse.
import { AckModule } from './ack/ack.module';
// v2-3 event objects: five-state lifecycle, RSVP, coach CRUD, transition cron.
import { CommunityEventsController } from './events/community-events.controller';
import { CommunityEventsService } from './events/community-events.service';
import { CommunityEventsRepository } from './events/community-events.repository';
import { CommunityEventsScheduler } from './events/community-events.scheduler';
import { CommunityEventsEnabledGuard } from './events/community-events-flag.guard';
// v2-4 community AI inbox triage: read-only generation surface
// (GET /community/ai-triage). Self-contained module; no Prisma diff.
import { AiTriageModule } from './ai-triage/ai-triage.module';
// v3-2 classroom posts: coach-authored, media-backed lessons. Self-contained
// module (mirrors AiTriageModule); registered last in imports for a clean v3-3
// voice rebase.
import { CommunityClassroomModule } from './classroom/community-classroom.module';
// v3-3 voice notes: audio attachments into cohort / workspace-hall channels and
// DM threads. Self-contained module (mirrors CommunityClassroomModule);
// registered LAST in imports so the slice stays a clean single-line add below
// v3-2's line (the brief's rebase-coordination rule).
import { CommunityVoiceModule } from './voice/community-voice.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [
    AckModule,
    AiTriageModule,
    AuthModule,
    CommunityRealtimeModule,
    CommunityNotificationsModule,
    PlanContextModule,
    CommunityClassroomModule,
    CommunityVoiceModule,
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
    CommunityCoachEmptyStatesController,
    CommunityChallengesController,
    CommunityEventsController,
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
    VoicePolicyService,
    CommunityChallengesService,
    CommunityChallengesRepository,
    CommunityChallengesEnabledGuard,
    CommunityEventsService,
    CommunityEventsRepository,
    CommunityEventsScheduler,
    CommunityEventsEnabledGuard,
  ],
  exports: [],
})
export class CommunityModule {}
