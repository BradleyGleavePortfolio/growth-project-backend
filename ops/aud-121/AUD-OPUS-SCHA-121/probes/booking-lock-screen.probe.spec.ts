/**
 * AUD-OPUS-SCHA-121 probe P-714-1 (agent 121, never merge).
 * Rule under test: a lock-screen push never carries a display name or a
 * free-form session type name (A6.5 "reminder pushes show no name"; the push
 * stack's B-692-1 fixed per-kind lock-screen copy for every BOOKING_* kind).
 * Expected at #714 55dfbdce: RED (the push body is the in-app body).
 */
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

const NAME = 'Jamie Canary-Person';
const TYPE = 'Canary Type Name';
const AT = new Date('2026-10-06T17:00:00Z');

function build() {
  const pushes: Array<{ title: string; body: string }> = [];
  const fake = {
    createNotification: jest.fn(async () => ({ id: 'n-1' })),
    getPreferences: jest.fn(async (user_id: string) => ({
      user_id,
      booking_push: true,
      muted: false,
    })),
    pushToUser: jest.fn(async (_u: string, title: string, body: string) => {
      pushes.push({ title, body });
      return { delivered: true, code: 'delivered' };
    }),
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    notificationPreferences: {
      findUnique: async () => ({
        timezone: 'America/Los_Angeles',
        timezone_source: 'device',
        timezone_updated_at: new Date('2026-09-01T00:00:00Z'),
      }),
    },
    coachProfile: { findUnique: async () => null },
    coachingSession: { findUnique: async () => null },
    user: { findUnique: async () => null },
  });
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    prisma,
  );
  return { emitter, pushes };
}

describe('P-714-1 booking pushes keep names off the lock screen', () => {
  it('no booking push title/body contains the other party name or the type name', async () => {
    const { emitter, pushes } = build();
    await emitter.emitRequested({
      coachUserId: 'c', clientDisplayName: NAME, sessionId: 's', sessionTypeName: TYPE,
      requestedAt: AT, scheduledAt: AT, notes: null,
    } as never);
    await emitter.emitConfirmed({
      clientUserId: 'u', coachDisplayName: NAME, sessionId: 's', sessionTypeName: TYPE,
      scheduledAt: AT, instant: true,
    } as never);
    await emitter.emitCancelled({
      recipientUserId: 'u', cancellingPartyDisplayName: NAME, sessionId: 's',
      sessionTypeName: TYPE, scheduledAt: AT, cancelReason: null,
    } as never);
    await emitter.emitReminder24h({
      recipientUserId: 'u', otherPartyDisplayName: NAME, sessionId: 's', sessionTypeName: TYPE,
      scheduledAt: AT,
    } as never);
    await emitter.emitReminder1h({
      recipientUserId: 'u', otherPartyDisplayName: NAME, sessionId: 's', sessionTypeName: TYPE,
      scheduledAt: AT,
    } as never);
    expect(pushes.length).toBe(5);
    const leaked = pushes.filter(
      (p) => `${p.title} ${p.body}`.includes(NAME) || `${p.title} ${p.body}`.includes(TYPE),
    );
    // Print what reaches the lock screen so the verdict can quote it.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(pushes, null, 1));
    expect(leaked).toEqual([]);
  });
});
