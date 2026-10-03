import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { MessagesSafetyModule } from '../messages-safety/messages-safety.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CoachWelcomeService } from './coach-welcome.service';
import { WelcomeSettingsController } from './welcome-settings.controller';
import { WorkoutReminderService } from './workout-reminder.service';

// C05 items 6-7 — clinic engagement: the coach welcome message (13 minutes
// after onboarding completes) and workout reminders on plan days. Both are
// @Cron + Postgres claim-by-write jobs; see docs/clinic-engagement.md.
// PrismaService and AuditService are provided globally.
@Module({
  imports: [AuthModule, MessagingModule, MessagesSafetyModule, NotificationsModule],
  controllers: [WelcomeSettingsController],
  providers: [CoachWelcomeService, WorkoutReminderService],
  exports: [CoachWelcomeService, WorkoutReminderService],
})
export class EngagementModule {}
