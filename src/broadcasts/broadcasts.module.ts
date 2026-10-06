import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BroadcastDispatcherService } from './broadcast-dispatcher.service';
import { BroadcastScopeService } from './broadcast-scope.service';
import { BroadcastsController } from './broadcasts.controller';
import { CoachBroadcastsEnabledGuard } from './broadcasts.feature';
import { BroadcastsService } from './broadcasts.service';
import { CardsService } from './cards.service';
import { ClientTagsService } from './client-tags.service';
import { SavedRepliesService } from './saved-replies.service';
import { SegmentResolverService } from './segment-resolver.service';

// A4-MSG-BROADCAST. PrismaService, SupabaseService and SubCoachScopeService
// are global. NotificationsModule provides MessageReceivedEmitter (the same
// push path a 1:1 coach message uses). Guards are provided locally, as in
// MessagingModule.
@Module({
  imports: [NotificationsModule, AuditModule],
  controllers: [BroadcastsController],
  providers: [
    BroadcastsService,
    BroadcastDispatcherService,
    BroadcastScopeService,
    SegmentResolverService,
    CardsService,
    SavedRepliesService,
    ClientTagsService,
    CoachBroadcastsEnabledGuard,
    JwtAuthGuard,
    CoachGuard,
    JwksVerifierService,
  ],
  exports: [CardsService, BroadcastScopeService],
})
export class BroadcastsModule {}
