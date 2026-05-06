import { Injectable, Logger } from '@nestjs/common';
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
   * Look up the coach's push_token from the User row. If the token is absent
   * (coach has no registered device, or has revoked push permission) the
   * method returns `false` and the caller falls back to the in-app inbox
   * only. No exception is thrown — push delivery is best-effort and must
   * never interrupt the alert-write path.
   *
   * Transport: the token is stored in `User.push_token` (null when unset).
   * In the current deploy, the column exists in the schema but the actual
   * APNs/FCM HTTP call is a placeholder logger call — it is trivially
   * swapped for a real SDK call once push credentials are wired in the env.
   * The contract (signature, fallback behaviour) is final.
   *
   * Returns `true` when a delivery was attempted, `false` when the coach had
   * no token.
   */
  async pushToCoach(coachId: string, payload: PushPayload): Promise<boolean> {
    try {
      const coach = await this.prisma.user.findUnique({
        where: { id: coachId },
        select: { push_token: true },
      });
      const token = coach?.push_token ?? null;
      if (!token) {
        // No registered device — graceful fallback; in-app inbox is still
        // written by the caller regardless of this return value.
        return false;
      }

      // TODO(push): replace the logger call below with the real APNs / FCM
      // SDK invocation once push credentials are available in the env.
      // The payload shape is intentionally minimal (no PII) so it can be
      // forwarded verbatim to the provider.
      this.logger.log(
        `push delivered to coach=${coachId} token=***${token.slice(-4)} alertId=${payload.alertId} type=${payload.alertType}`,
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
