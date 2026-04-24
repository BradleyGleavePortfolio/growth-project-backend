import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpdateNotificationPreferencesDto } from './notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async getPreferences(userId: string) {
    const prefs = await this.prisma.notificationPreferences.findUnique({ where: { user_id: userId } });
    if (!prefs) {
      // Return defaults
      return {
        user_id: userId,
        water_enabled: true,
        workout_enabled: true,
        eat_enabled: true,
        mindset_enabled: true,
        fasting_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '06:00',
        timezone: 'America/Los_Angeles',
      };
    }
    return prefs;
  }

  async updatePreferences(userId: string, data: UpdateNotificationPreferencesDto) {
    // Explicit field mapping — no spread. Previously both paths did
    // `data: { user_id, ...data }`, which would silently let a client provide
    // `user_id` (reassigning prefs). DTO + whitelisted ValidationPipe already
    // strips unknown fields; this is defense-in-depth.
    const fields = {
      water_enabled: data.water_enabled,
      workout_enabled: data.workout_enabled,
      eat_enabled: data.eat_enabled,
      mindset_enabled: data.mindset_enabled,
      fasting_enabled: data.fasting_enabled,
      quiet_hours_start: data.quiet_hours_start,
      quiet_hours_end: data.quiet_hours_end,
      timezone: data.timezone,
    };

    const existing = await this.prisma.notificationPreferences.findUnique({ where: { user_id: userId } });
    if (existing) {
      return this.prisma.notificationPreferences.update({ where: { user_id: userId }, data: fields });
    }
    return this.prisma.notificationPreferences.create({
      data: {
        user_id: userId,
        ...fields,
      },
    });
  }
}
