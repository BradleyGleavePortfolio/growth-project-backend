/**
 * community-notifications.module.ts — wires the v1-4 Community push wrapper.
 *
 * Imports NotificationsModule to get the existing NotificationsService (the
 * Expo transport + inbox writer we delegate to — never re-implement). Prisma
 * is global; AnalyticsService comes from the @Global() AnalyticsModule.
 */

import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { CommunityNotificationsService } from './community-notifications.service';

@Module({
  imports: [NotificationsModule],
  providers: [CommunityNotificationsService],
  exports: [CommunityNotificationsService],
})
export class CommunityNotificationsModule {}
