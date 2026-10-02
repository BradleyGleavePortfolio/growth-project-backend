import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { usableTimeZone } from './local-time';

// The time zone notification copy is written in, for one recipient
// (B-643-1). Order:
//   1. the recipient's stored NotificationPreferences.timezone (a stored
//      row only: getPreferences' in-memory default is not the person's zone);
//   2. the recipient's own CoachProfile.timezone (coach recipients);
//   3. the booking's zone: the session coach's CoachProfile.timezone, the
//      zone the coach published the bookable slots in.
// UTC aliases and invalid names are skipped (see usableTimeZone). Returns
// null when nothing usable is stored; callers then write copy without a
// clock time. Never throws: a lookup failure must not block a notification.

type TimeZoneReader = Pick<
  PrismaService,
  'notificationPreferences' | 'coachProfile' | 'coachingSession'
>;

const logger = new Logger('RecipientTimeZone');

export async function resolveRecipientTimeZone(
  prisma: TimeZoneReader | undefined,
  recipientUserId: string,
  sessionId?: string,
): Promise<string | null> {
  if (!prisma) return null;
  try {
    const prefs = await prisma.notificationPreferences.findUnique({
      where: { user_id: recipientUserId },
      select: { timezone: true },
    });
    const fromPrefs = usableTimeZone(prefs?.timezone);
    if (fromPrefs) return fromPrefs;

    const own = await prisma.coachProfile.findUnique({
      where: { user_id: recipientUserId },
      select: { timezone: true },
    });
    const fromOwnProfile = usableTimeZone(own?.timezone);
    if (fromOwnProfile) return fromOwnProfile;

    if (sessionId) {
      const session = await prisma.coachingSession.findUnique({
        where: { id: sessionId },
        select: { coach_id: true },
      });
      if (session && session.coach_id !== recipientUserId) {
        const coach = await prisma.coachProfile.findUnique({
          where: { user_id: session.coach_id },
          select: { timezone: true },
        });
        const fromBooking = usableTimeZone(coach?.timezone);
        if (fromBooking) return fromBooking;
      }
    }
    return null;
  } catch (err) {
    logger.warn(
      `time zone lookup failed for user=${recipientUserId}; writing copy without a clock time: ${(err as Error).name}`,
    );
    return null;
  }
}
