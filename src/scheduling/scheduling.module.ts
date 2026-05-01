import { Module } from '@nestjs/common';
import { CalendarSyncJob } from './jobs/calendar-sync.job';
import { SessionReminderJob } from './jobs/reminder.job';
import { GoogleCalendarAdapter } from './providers/google-calendar.adapter';
import { GoogleMeetAdapter } from './providers/google-meet.adapter';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import { StubCalendarAdapter } from './providers/stub-calendar.adapter';
import { StubVideoAdapter } from './providers/stub-video.adapter';
import { ZoomVideoAdapter } from './providers/zoom-video.adapter';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { SchedulingWebhookController } from './scheduling-webhook.controller';

// PrismaService and AuditService are provided globally (PrismaModule
// and AuditModule, both @Global()), so this module needs no imports.
//
// Provider adapters are registered eagerly so the registry can pull
// them via constructor injection. The webhook controller lives in this
// module because its lifecycle and provider env-flag wiring share fate
// with the rest of scheduling.
@Module({
  controllers: [SchedulingController, SchedulingWebhookController],
  providers: [
    SchedulingService,
    SchedulingProviderRegistry,
    StubCalendarAdapter,
    StubVideoAdapter,
    GoogleCalendarAdapter,
    GoogleMeetAdapter,
    ZoomVideoAdapter,
    SessionReminderJob,
    CalendarSyncJob,
  ],
  exports: [SchedulingService],
})
export class SchedulingModule {}
