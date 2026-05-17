import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { GoogleCalendarWebhookController } from './google-calendar/google-calendar-webhook.controller';
import { GoogleCalendarService } from './google-calendar/google-calendar.service';
import { GoogleOAuthController } from './google-oauth/google-oauth.controller';
import { GoogleOAuthService } from './google-oauth/google-oauth.service';
import { CalendarSyncJob } from './jobs/calendar-sync.job';
import { SessionReminderJob } from './jobs/reminder.job';
import { GoogleCalendarAdapter } from './providers/google-calendar.adapter';
import { GoogleMeetAdapter } from './providers/google-meet.adapter';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import { StubCalendarAdapter } from './providers/stub-calendar.adapter';
import { StubVideoAdapter } from './providers/stub-video.adapter';
import { ZoomVideoAdapter } from './providers/zoom-video.adapter';
import { SchedulingAvailabilityService } from './scheduling-availability.service';
import { SchedulingController } from './scheduling.controller';
import { SchedulingOpenSlotsService } from './scheduling-open-slots.service';
import { SchedulingService } from './scheduling.service';
import { SchedulingSessionLifecycleService } from './scheduling-session-lifecycle.service';
import { SchedulingWebhookController } from './scheduling-webhook.controller';

// PrismaService and AuditService are provided globally (PrismaModule
// and AuditModule, both @Global()), so this module needs no imports.
//
// Provider adapters are registered eagerly so the registry can pull
// them via constructor injection. The webhook controller lives in this
// module because its lifecycle and provider env-flag wiring share fate
// with the rest of scheduling.
//
// Concierge (PR #142) additions: GoogleOAuthController/Service handle
// the Calendar API code-exchange + refresh flow. They live in this
// module so the OAuth wiring shares fate with the GoogleCalendarAdapter.
@Module({
  imports: [NotificationsModule],
  controllers: [
    SchedulingController,
    SchedulingWebhookController,
    GoogleOAuthController,
    // Google Calendar Push Notifications receiver (#142 follow-up).
    GoogleCalendarWebhookController,
  ],
  providers: [
    SchedulingService,
    // M9 refactor — focused services that SchedulingService delegates to.
    SchedulingSessionLifecycleService,
    SchedulingOpenSlotsService,
    SchedulingAvailabilityService,
    SchedulingProviderRegistry,
    StubCalendarAdapter,
    StubVideoAdapter,
    GoogleCalendarAdapter,
    GoogleMeetAdapter,
    ZoomVideoAdapter,
    SessionReminderJob,
    CalendarSyncJob,
    GoogleOAuthService,
    // Real Google Calendar REST client. Stubbed adapter
    // (GoogleCalendarAdapter above) remains for the Provider registry
    // until the registry is migrated to consume this service directly.
    GoogleCalendarService,
    // Local guards mirror the pattern in MacrosModule / TeamModeModule:
    // provide the JwtAuthGuard + JwksVerifierService locally rather
    // than importing AuthModule (avoids the circular-import risk).
    JwtAuthGuard,
    JwksVerifierService,
  ],
  exports: [SchedulingService, GoogleOAuthService, GoogleCalendarService],
})
export class SchedulingModule {}
