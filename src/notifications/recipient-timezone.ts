import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { usableTimeZone } from './local-time';

// The time zone notification copy (and quiet hours) use for one recipient
// (B-643-1; Opus B-647-1, Sol B-647-2: zone provenance). Order:
//   1. the zone the recipient actually supplied: NotificationPreferences
//      .timezone, but ONLY when timezone_updated_at is set (the mobile app's
//      device zone, or an explicit settings write). The column has a schema
//      default (America/Los_Angeles) and a row is created by any preference
//      toggle, so an unstamped row is not the person's zone and is ignored;
//   2. the recipient's own CoachProfile.timezone (coach recipients);
//   3. the booking's zone: the session coach's CoachProfile.timezone, the
//      zone the coach published the bookable slots in;
//   4. for a client outside a booking: their coach's CoachProfile.timezone.
// UTC aliases and invalid names are skipped (see usableTimeZone). Returns
// null when nothing usable is known; callers then write copy without a
// clock time and do not apply quiet hours. Never a silent Pacific default.
// Never throws: a lookup failure must not block a notification.

type TimeZoneReader = Pick<
  PrismaService,
  'notificationPreferences' | 'coachProfile' | 'coachingSession' | 'user'
>;

export type RecipientTimeZoneSource =
  | 'recipient'
  | 'own_coach_profile'
  | 'booking_coach'
  | 'assigned_coach';

export interface RecipientTimeZone {
  timeZone: string;
  source: RecipientTimeZoneSource;
}

const logger = new Logger('RecipientTimeZone');

async function coachProfileZone(
  prisma: TimeZoneReader,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const profile = await prisma.coachProfile.findUnique({
    where: { user_id: userId },
    select: { timezone: true },
  });
  return usableTimeZone(profile?.timezone);
}

export async function resolveRecipientTimeZoneWithSource(
  prisma: TimeZoneReader | undefined,
  recipientUserId: string,
  sessionId?: string,
): Promise<RecipientTimeZone | null> {
  if (!prisma) return null;
  try {
    const prefs = await prisma.notificationPreferences.findUnique({
      where: { user_id: recipientUserId },
      select: { timezone: true, timezone_updated_at: true },
    });
    if (prefs?.timezone_updated_at) {
      const supplied = usableTimeZone(prefs.timezone);
      if (supplied) return { timeZone: supplied, source: 'recipient' };
    }

    const own = await coachProfileZone(prisma, recipientUserId);
    if (own) return { timeZone: own, source: 'own_coach_profile' };

    if (sessionId) {
      const session = await prisma.coachingSession.findUnique({
        where: { id: sessionId },
        select: { coach_id: true },
      });
      if (session && session.coach_id !== recipientUserId) {
        const booking = await coachProfileZone(prisma, session.coach_id);
        if (booking) return { timeZone: booking, source: 'booking_coach' };
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: recipientUserId },
      select: { coach_id: true },
    });
    if (user?.coach_id && user.coach_id !== recipientUserId) {
      const assigned = await coachProfileZone(prisma, user.coach_id);
      if (assigned) return { timeZone: assigned, source: 'assigned_coach' };
    }
    return null;
  } catch (err) {
    logger.warn(
      `time zone lookup failed for user=${recipientUserId}; writing copy without a clock time: ${(err as Error).name}`,
    );
    return null;
  }
}

export async function resolveRecipientTimeZone(
  prisma: TimeZoneReader | undefined,
  recipientUserId: string,
  sessionId?: string,
): Promise<string | null> {
  const resolved = await resolveRecipientTimeZoneWithSource(prisma, recipientUserId, sessionId);
  return resolved?.timeZone ?? null;
}
