/**
 * NOTIFYMOVE (owner 4, 137-8): when a client moves, the coach they left loses
 * every notification about them at once, and the client keeps their own.
 *
 * One table over every coach-facing notification type that names a client,
 * each written by its real writer at 23:00 in the coach's zone (so every push
 * waits in the outbox for 08:00, like the eating-disorder alert push), and
 * every path that serves it: the inbox list, its unread count, the badge,
 * mark read, mark all read, and the push at send time. The current coach gets
 * each one; after the client moves to another coach, the coach they left gets
 * 0 rows, a 404, and no push (the queued push is dropped as obsolete). Money
 * notices and digests name no client and stay.
 */
import { NotFoundException } from '@nestjs/common';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { NotificationKind, type NotificationKindValue } from '../src/notifications/notification-kind';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { CheckinSubmittedEmitter } from '../src/notifications/emitters/checkin-submitted.emitter';
import { MissedCheckinEmitter } from '../src/notifications/emitters/missed-checkin.emitter';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { alertCoachOfFlaggedJoinTx, type FlaggedJoinTx } from '../src/onboarding/flagged-join-alert';
import { PAYOUT_NOTICE_DEEP_LINK } from '../src/checkout/payout-notice.service';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { whereMatches } from './utils/notification-where';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const NIGHT = new Date('2026-06-02T03:00:00Z'); // 23:00 New York
const MORNING = new Date('2026-06-02T12:30:00Z'); // 08:30 New York
let clock = NIGHT;
class Clocked extends PushDeliveryService {
  protected now(): Date {
    return clock;
  }
}

type Row = Record<string, unknown> & { id: string; read_at: Date | null };

function world() {
  clock = NIGHT;
  const users: Record<string, { role: string; coach_id: string | null }> = {
    'coach-1': { role: 'coach', coach_id: null },
    'coach-2': { role: 'coach', coach_id: null },
    'client-1': { role: 'student', coach_id: 'coach-1' },
  };
  const sessions = [{ id: 'sess-1', coach_id: 'coach-1', client_id: 'client-1', status: 'scheduled' }];
  const w = pushOutboxWorld({
    now: () => clock,
    tokens: { 'coach-1': TOKEN },
    prefs: { 'coach-1': { timezone: 'America/New_York', timezone_updated_at: NIGHT, muted: false } },
  });
  const inbox: Row[] = [];
  const hits = (where: unknown) => inbox.filter((r) => whereMatches(r, where));
  const notification = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { deep_link: null, payload: null, inbox_hidden: false, ...data, id: `n-${inbox.length + 1}`, read_at: null, created_at: new Date(Date.now() + inbox.length) };
      inbox.push(row);
      return row;
    }),
    findMany: jest.fn(async ({ where, take }: { where: unknown; take?: number }) => hits(where).reverse().slice(0, take)),
    findFirst: jest.fn(async ({ where }: { where: unknown }) => hits(where)[0] ?? null),
    findUnique: jest.fn(async () => null),
    count: jest.fn(async ({ where }: { where: unknown }) => hits(where).length),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(hits(where)[0], data)),
    updateMany: jest.fn(async ({ where, data }: { where: unknown; data: object }) => ({ count: hits(where).map((r) => Object.assign(r, data)).length })),
  };
  const db = {
    ...w.db,
    notification,
    user: {
      ...w.db.user,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ ...users[where.id], expo_push_token: where.id === 'coach-1' ? TOKEN : null })),
      findMany: jest.fn(async ({ where }: { where: { coach_id: string } }) =>
        Object.keys(users).filter((id) => users[id].coach_id === where.coach_id).map((id) => ({ id })),
      ),
    },
    coachingSession: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: { where: unknown }) => sessions.filter((s) => whereMatches(s, where))),
    },
  };
  const prisma = fakeOf<PrismaService>(Object.create(db));
  const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
  const delivery = new Clocked(prisma, { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(prisma, undefined, undefined, delivery);
  const flagTx = fakeOf<FlaggedJoinTx>({
    clientOnboardingIntake: { findUnique: async () => ({ completed_at: NIGHT, screening_flagged_at: NIGHT }) },
    notification,
  });
  const control = (kind: NotificationKindValue, deep_link?: string) =>
    notifications.createNotification({ user_id: 'coach-1', kind, body: 'A notice.', ...(deep_link ? { deep_link } : {}) });
  const move = () => {
    users['client-1'].coach_id = 'coach-2';
  };
  // The first payment is written inside the purchase transaction.
  const tx = fakeOf<Prisma.TransactionClient>(prisma);
  return { prisma, tx, notifications, delivery, send, flagTx, control, move, inbox, outbox: w.rows };
}
type World = ReturnType<typeof world>;

// Every coach-facing type that names a client: [type, has a push, its real writer].
const TYPES: Array<[string, boolean, (w: World) => Promise<unknown>]> = [
  ['coach alert (eating-disorder reply)', true, (w) =>
    new CoachAlertEmitter(w.notifications).emit({ coachId: 'coach-1', alertId: 'a-1', alertType: 'roman_eating_disorder_reply', severity: 'critical', message: 'A safety alert.', clientUserId: 'client-1' })],
  ['check-in submitted', true, (w) =>
    new CheckinSubmittedEmitter(w.notifications).emit({ coachId: 'coach-1', clientDisplayName: 'Jane Doe', clientUserId: 'client-1', streakDays: 3 })],
  ['missed check-in', true, (w) =>
    new MissedCheckinEmitter(w.notifications).emit({ daysMissed: 2, clientDisplayName: 'Jane Doe', coachId: 'coach-1', clientUserId: 'client-1' })],
  ['onboarding flag', false, (w) => alertCoachOfFlaggedJoinTx(w.flagTx, 'client-1', 'coach-1')],
  ['message received', true, (w) => new MessageReceivedEmitter(w.notifications).emit('coach-1', { senderName: 'Jane Doe', threadId: 'client-1' })],
  ['session booked', true, (w) =>
    new BookingEmitter(w.notifications, w.prisma).emitBooked({ sessionId: 'sess-1', coachUserId: 'coach-1', clientDisplayName: 'Jane Doe', scheduledAt: new Date('2026-06-09T15:00:00Z') })],
  ['first payment', false, (w) => new FirstPaymentEmitter(w.notifications).emit('coach-1', { amount: 5000, currency: 'usd', clientId: 'client-1' }, w.tx)],
];

const req = (id: string) => fakeOf<AuthedRequest>({ user: { id } });
const coach = req('coach-1');
const CONTROLS = 3;

async function setUp(write: (w: World) => Promise<unknown>, moved: boolean) {
  const w = world();
  await w.control(NotificationKind.COACH_ALERT, PAYOUT_NOTICE_DEEP_LINK);
  await w.control(NotificationKind.COACH_NEW_PURCHASE, 'tgp://coach/purchases/p-1');
  await w.control(NotificationKind.COACH_DIGEST);
  await write(w);
  // The rows the type wrote for the coach (a first payment adds a hidden push twin).
  const written = w.inbox.filter((r) => r.user_id === 'coach-1').slice(CONTROLS);
  const named = written.filter((r) => !r.inbox_hidden).map((r) => r.id);
  expect(named.length).toBeGreaterThan(0);
  expect(await w.delivery.drain()).toBe(0); // 23:00: every push waits for 08:00
  if (moved) w.move();
  clock = MORNING;
  await w.delivery.drain();
  const pushes = w.send.mock.calls.flatMap((c) => c[0]).filter((m) => m.to === TOKEN).length;
  return { w, named, written: written.length, pushes, inbox: new NotificationsController(w.notifications) };
}

describe('NOTIFYMOVE: a moved client\'s notifications leave the coach they left', () => {
  const opened = async (ids: string[], c: NotificationsController) => {
    let n = 0;
    for (const id of ids) n += await c.markRead(id, coach).then(() => 1, (e: unknown) => (e instanceof NotFoundException ? 0 : Promise.reject(e)));
    return n;
  };
  type S = Awaited<ReturnType<typeof setUp>>;
  // [path, what it serves, what the current coach gets; the coach they left gets the controls only].
  const PATHS: Array<[string, (s: S) => Promise<number>, (s: S, push: boolean) => number, number]> = [
    ['GET /notifications (rows)', async (s) => (await s.inbox.listNotifications(coach, {})).items.length, (s) => s.named.length + CONTROLS, CONTROLS],
    ['GET /notifications (unread count)', async (s) => (await s.inbox.listNotifications(coach, {})).unreadCount, (s) => s.named.length + CONTROLS, CONTROLS],
    ['GET /notifications/unread-count (badge)', async (s) => (await s.inbox.getUnreadCount(coach)).count, (s) => s.named.length + CONTROLS, CONTROLS],
    ['POST /notifications/:id/read', (s) => opened(s.named, s.inbox), (s) => s.named.length, 0],
    ['POST /notifications/mark-all-read', async (s) => (await s.inbox.markAllRead(coach)).updated, (s) => s.written + CONTROLS, CONTROLS],
    ['push at send time (08:00)', async (s) => s.pushes, (_s, push) => (push ? 1 : 0), 0],
  ];
  describe.each(TYPES)('%s', (_type, push, write) => {
    it.each(PATHS)('%s: the current coach gets it; the coach they left gets nothing', async (_path, read, current, left) => {
      const before = await setUp(write, false);
      const after = await setUp(write, true);
      expect(await read(before)).toBe(current(before, push));
      expect(await read(after)).toBe(left);
      if (push) expect(after.w.outbox.filter((r) => r.user_id === 'coach-1').map((r) => r.result_code)).toEqual(['obsolete']);
    });
  });

  it('the client keeps their own history after the move', async () => {
    const { w } = await setUp((x) => new MissedCheckinEmitter(x.notifications).emit({ daysMissed: 2, clientDisplayName: 'Jane Doe', coachId: 'coach-1', clientUserId: 'client-1' }), true);
    await new MessageReceivedEmitter(w.notifications).emit('client-1', { senderName: 'Coach K', threadId: 'client-1' });
    const own = await new NotificationsController(w.notifications).listNotifications(req('client-1'), {});
    expect(own.items.map((r) => r.kind).sort()).toEqual([NotificationKind.MESSAGE_RECEIVED, NotificationKind.MISSED_CHECKIN]);
  });
});
