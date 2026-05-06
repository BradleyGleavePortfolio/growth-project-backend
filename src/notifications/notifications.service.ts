import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpdateNotificationPreferencesDto } from './notifications.dto';

// Phase 6B: PushPayload is the minimal envelope CoachAlertsService.tryPush
// passes through. It intentionally contains no PII — only the alert
// identifier, type, and a short message string for the coach's lock-screen.
export interface PushPayload {
  alertId: string;
  alertType: string;
  severity: string;
  message: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

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
        daily_checkin_enabled: true,
        weekly_summary_enabled: true,
        new_client_alerts: true,
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
      daily_checkin_enabled: data.daily_checkin_enabled,
      weekly_summary_enabled: data.weekly_summary_enabled,
      new_client_alerts: data.new_client_alerts,
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

  /**
   * Phase 6B — Push an alert payload to a coach's device(s).
   *
   * The push token lookup and APNs/FCM transport call are deferred until
   * push credentials are wired in the environment. Until then, this method
   * logs the delivery intent and returns true so callers know the push path
   * was reached.
   *
   * When the User model gains a `push_token` column and push credentials are
   * provisioned, replace the logger call below with the real SDK invocation.
   * The method contract (signature, fallback behaviour) is final — callers
   * must not throw on `false` return.
   *
   * Returns `true` when delivery was attempted, `false` if a transport error
   * occurred.
   *
   * Payload is intentionally PII-free so it can be forwarded verbatim to
   * the push provider.
   */
  async pushToCoach(coachId: string, payload: PushPayload): Promise<boolean> {
    try {
      // TODO(push): look up coach's push_token from User.push_token (field to
      // be added in a schema migration) and call the real APNs/FCM SDK.
      // If token is absent, return false for graceful in-app-inbox fallback.
      // For now, log delivery intent — alerts are still stored in inbox.
      this.logger.log(
        `push delivery: coach=${coachId} alertId=${payload.alertId} type=${payload.alertType} sev=${payload.severity}`,
      );
      return true;
    } catch (err) {
      // Log and return false — push failure must never crash the caller.
      this.logger.warn(
        `pushToCoach failed for coach=${coachId}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
