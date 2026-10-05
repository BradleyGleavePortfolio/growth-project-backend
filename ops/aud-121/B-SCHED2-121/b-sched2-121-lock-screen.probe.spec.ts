/**
 * FAILING-BEFORE PROBE (B-SCHED2-121, agent 121, never merge). Imports only
 * what exists at #653 9a23e3b2, so it is red there on behavior, not on types.
 * B-714-1 / B-653-1: a booking push never puts a display name
 * or coach-written text on the lock screen. Every BookingEmitter method is
 * driven with canary names, a canary session type name and canary notes and
 * reasons; the push title and body must be the fixed per-kind line (a
 * reminder keeps only its time), while the in-app row keeps the full detail.
 */
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

const NAME = 'Jamie Canary-Person';
const TYPE = 'Canary Type Name';
const NOTE = 'canary private note';
const AT = new Date('2026-10-06T17:00:00Z'); // Tue Oct 6, 10:00 AM PDT
const LATER = new Date('2026-10-07T18:30:00Z');
const CANARIES = [NAME, TYPE, NOTE, 'Jamie', 'Canary'];

function build(timeZone: string | null = 'America/Los_Angeles') {
  const rows: CreateNotificationInput[] = [];
  const pushes: Array<{ kind: unknown; title: string; body: string }> = [];
  const fake = {
    createNotification: jest.fn(async (input: CreateNotificationInput) => {
      rows.push(input);
      return { id: `n-${rows.length}` };
    }),
    getPreferences: jest.fn(async (user_id: string) => ({
      user_id,
      booking_push: true,
      muted: false,
    })),
    pushToUser: jest.fn(
      async (_u: string, title: string, body: string, data?: Record<string, unknown>) => {
        pushes.push({ kind: data?.kind, title, body });
        return { delivered: true, code: 'delivered' as const };
      },
    ),
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    notificationPreferences: {
      findUnique: async () =>
        timeZone
          ? {
              timezone: timeZone,
              timezone_source: 'device',
              timezone_updated_at: new Date('2026-09-01T00:00:00Z'),
            }
          : null,
    },
    coachProfile: { findUnique: async () => null },
    coachingSession: { findUnique: async () => null },
    user: { findUnique: async () => null },
  });
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    prisma,
  );
  return { emitter, rows, pushes };
}

async function emitAll(emitter: BookingEmitter): Promise<void> {
  const base = { sessionId: 's-1', sessionTypeName: TYPE };
  await emitter.emitRequested({
    ...base, coachUserId: 'coach', clientDisplayName: NAME, requestedAt: AT, scheduledAt: AT, notes: NOTE,
  });
  await emitter.emitBooked({ ...base, coachUserId: 'coach', clientDisplayName: NAME, scheduledAt: AT });
  await emitter.emitConfirmed({ ...base, clientUserId: 'client', coachDisplayName: NAME, scheduledAt: AT });
  await emitter.emitConfirmed({
    ...base, clientUserId: 'client', coachDisplayName: NAME, scheduledAt: AT, instant: true,
  });
  await emitter.emitDeclined({
    ...base, clientUserId: 'client', coachDisplayName: NAME, requestedAt: AT, scheduledAt: AT, declineReason: NOTE,
  });
  await emitter.emitCancelled({
    ...base, recipientUserId: 'client', recipientRole: 'client', cancellingPartyDisplayName: NAME,
    scheduledAt: AT, cancelReason: NOTE,
  });
  await emitter.emitRescheduled({
    ...base, recipientUserId: 'coach', recipientRole: 'coach', reschedulerDisplayName: NAME,
    oldScheduledAt: AT, newScheduledAt: LATER,
  });
  await emitter.emitMoveRequested({
    ...base, coachUserId: 'coach', clientDisplayName: NAME, oldScheduledAt: AT, newScheduledAt: LATER,
  });
  await emitter.emitReminder24h({
    ...base, recipientUserId: 'client', recipientRole: 'client', otherPartyDisplayName: NAME, scheduledAt: AT,
  });
  await emitter.emitReminder1h({
    ...base, recipientUserId: 'coach', recipientRole: 'coach', otherPartyDisplayName: NAME,
    scheduledAt: AT, hasMeetingLink: false,
  });
  await emitter.emitLinkNeeded({ ...base, coachUserId: 'coach', clientDisplayName: NAME, scheduledAt: AT });
  await emitter.emitLinkReady({ ...base, clientUserId: 'client', coachDisplayName: NAME, scheduledAt: AT });
  await emitter.emitRequestExpired({
    ...base, recipientUserId: 'client', recipientRole: 'client', otherPartyDisplayName: NAME, scheduledAt: AT,
  });
  await emitter.emitRequestExpired({
    ...base, recipientUserId: 'coach', recipientRole: 'coach', otherPartyDisplayName: NAME, scheduledAt: AT,
  });
}

describe('B-SCHED2-121 probe: no canary text on any booking lock screen', () => {
  it('all 14 booking pushes are free of names, type names, notes and reasons', async () => {
    const { emitter, pushes } = build();
    await emitAll(emitter);
    expect(pushes).toHaveLength(14);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(pushes, null, 1));
    const leaked = pushes.filter((p) => CANARIES.some((c) => `${p.title} ${p.body}`.includes(c)));
    expect(leaked).toEqual([]);
  });
});
