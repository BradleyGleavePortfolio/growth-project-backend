import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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

  async updatePreferences(userId: string, data: any) {
    const existing = await this.prisma.notificationPreferences.findUnique({ where: { user_id: userId } });
    if (existing) {
      return this.prisma.notificationPreferences.update({ where: { user_id: userId }, data });
    }
    return this.prisma.notificationPreferences.create({ data: { user_id: userId, ...data } });
  }
}
