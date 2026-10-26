/**
 * NOTIFYMOVE (owner 4, 137-8): when a client moves, the coach they left loses
 * every notification about them at once, and the client keeps their own. A
 * coach who is still authorised for the client (their direct coach, or the
 * sub-coach the head coach delegated them to) keeps every one.
 *
 * One table over every coach-facing notification type that names a client,
 * each written by its real writer at 23:00 in the reader's zone (so every push
 * waits in the outbox for 08:00, like the eating-disorder alert push), every
 * path that serves it (the inbox list, its unread count, the badge, mark read,
 * mark all read, and the push at send time), and every reader: the current
 * direct coach and the current delegated sub-coach get each one; a sub-coach
 * whose delegation ended, the old coach and the old sub-coach of a client who
 * moved, and an unrelated coach get 0 rows, a 404, and no push (the queued
 * push is dropped as obsolete). Money notices and digests name no client and
 * stay.
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
const table = <T extends object>(rows: T[]) => ({
  findFirst: jest.fn(async ({ where }: { where: unknown }) => rows.find((r) => whereMatches(r, where)) ?? null),
  findMany: jest.fn(async ({ where }: { where: unknown }) => rows.filter((r) => whereMatches(r, where))),
});

// client-1 (and any more of the roster) belongs to head coach-1, who delegated
// them to sub-1 (Team Mode data the app keeps serving today); coach-2 is the
// coach client-1 moves to.
function world(reader: string, roster = 1) {
  clock = NIGHT;
  const person = (id: string, role: string, coach_id: string | null) => ({ id, role, coach_id, deleted_at: null });
  const people = [
    person('coach-1', 'coach', null),
    person('sub-1', 'coach', 'coach-1'),
    person('coach-2', 'coach', null),
    person('coach-3', 'coach', null),
  ];
  const clients = Array.from({ length: roster }, (_, i) => `client-${i + 1}`);
  people.push(...clients.map((id) => person(id, 'student', 'coach-1')));
  const seats = [{ head_coach_id: 'coach-1', sub_coach_id: 'sub-1', archived_at: null }];
  const delegations = clients.map((client_id) => ({ client_id, head_coach_id: 'coach-1', sub_coach_id: 'sub-1', unassigned_at: null as Date | null }));
  const sessions = clients.map((client_id, i) => ({ id: `sess-${i + 1}`, coach_id: reader, client_id, status: 'scheduled' }));
  const w = pushOutboxWorld({
    now: () => clock,
    tokens: { [reader]: TOKEN },
    prefs: { [reader]: { timezone: 'America/New_York', timezone_updated_at: NIGHT, muted: false } },
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
      ...table(people),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ ...people.find((u) => u.id === where.id), expo_push_token: w.tokens[where.id] ?? null })),
    },
    teamSubCoachAssignment: table(seats),
    subCoachAssignment: table(delegations),
    coachingSession: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: { where: unknown }) =>
        sessions.map((s) => ({ ...s, client: people.find((u) => u.id === s.client_id) })).filter((s) => whereMatches(s, where)),
      ),
    },
  };
  const prisma = fakeOf<PrismaService>(Object.create(db));
  // Every read of the tables that decide who still coaches whom.
  const reads = () =>
    [db.user, db.teamSubCoachAssignment, db.subCoachAssignment, db.coachingSession]
      .flatMap((t) => Object.values(t))
      .reduce((n, f) => n + (jest.isMockFunction(f) ? f.mock.calls.length : 0), 0);
  const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
  const delivery = new Clocked(prisma, { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(prisma, undefined, undefined, delivery);
  const flagTx = fakeOf<FlaggedJoinTx>({
    clientOnboardingIntake: { findUnique: async () => ({ completed_at: NIGHT, screening_flagged_at: NIGHT }) },
    notification,
  });
  const control = (kind: NotificationKindValue, deep_link?: string) =>
    notifications.createNotification({ user_id: reader, kind, body: 'A notice.', ...(deep_link ? { deep_link } : {}) });
  const move = () => {
    people[4].coach_id = 'coach-2';
  };
  const undelegate = () => {
    delegations[0].unassigned_at = NIGHT;
  };
  // The first payment is written inside the purchase transaction.
  const tx = fakeOf<Prisma.TransactionClient>(prisma);
  return { reader, prisma, tx, notifications, delivery, send, flagTx, control, move, undelegate, inbox, outbox: w.rows, reads };
}
type World = ReturnType<typeof world>;

// Every coach-facing type that names a client: [type, has a push, its real writer].
const TYPES: Array<[string, boolean, (w: World) => Promise<unknown>]> = [
  ['coach alert (eating-disorder reply)', true, (w) =>
    new CoachAlertEmitter(w.notifications).emit({ coachId: w.reader, alertId: 'a-1', alertType: 'roman_eating_disorder_reply', severity: 'warning', message: 'A safety alert.', clientUserId: 'client-1' })],
  ['check-in submitted', true, (w) =>
    new CheckinSubmittedEmitter(w.notifications).emit({ coachId: w.reader, clientDisplayName: 'Jane Doe', clientUserId: 'client-1', streakDays: 3 })],
  ['missed check-in', true, (w) =>
    new MissedCheckinEmitter(w.notifications).emit({ daysMissed: 2, clientDisplayName: 'Jane Doe', coachId: w.reader, clientUserId: 'client-1' })],
  ['onboarding flag', false, (w) => alertCoachOfFlaggedJoinTx(w.flagTx, 'client-1', w.reader)],
  ['message received', true, (w) => new MessageReceivedEmitter(w.notifications).emit(w.reader, { senderName: 'Jane Doe', threadId: 'client-1' })],
  ['session booked', true, (w) =>
    new BookingEmitter(w.notifications, w.prisma).emitBooked({ sessionId: 'sess-1', coachUserId: w.reader, clientDisplayName: 'Jane Doe', scheduledAt: new Date('2026-06-09T15:00:00Z') })],
  ['session cancelled (the shared session link)', true, (w) =>
    new BookingEmitter(w.notifications, w.prisma).emitCancelled({ sessionId: 'sess-1', recipientUserId: w.reader, recipientRole: 'coach', cancellingPartyDisplayName: 'Jane Doe', scheduledAt: new Date('2026-06-09T15:00:00Z'), cancelReason: null })],
  ['first payment', true, (w) => new FirstPaymentEmitter(w.notifications).emit(w.reader, { amount: 5000, currency: 'usd', clientId: 'client-1' }, w.tx)],
];

// Every reader: [who, the change while the push waits for 08:00, keeps everything].
const READERS: Array<[string, string, ((w: World) => void) | null, boolean]> = [
  ['the current direct coach', 'coach-1', null, true],
  ['the current delegated sub-coach', 'sub-1', null, true],
  ['a sub-coach whose delegation ended', 'sub-1', (w) => w.undelegate(), false],
  ['the old coach of a client who moved', 'coach-1', (w) => w.move(), false],
  ['the old sub-coach of a client who moved', 'sub-1', (w) => w.move(), false],
  ['an unrelated coach', 'coach-3', null, false],
];

const req = (id: string) => fakeOf<AuthedRequest>({ user: { id } });
const CONTROLS = 3;

async function setUp(write: (w: World) => Promise<unknown>, reader: string, change: ((w: World) => void) | null) {
  const w = world(reader);
  await w.control(NotificationKind.COACH_ALERT, PAYOUT_NOTICE_DEEP_LINK);
  await w.control(NotificationKind.COACH_NEW_PURCHASE, 'tgp://coach/purchases/p-1');
  await w.control(NotificationKind.COACH_DIGEST);
  await write(w);
  // The rows the type wrote for the reader (a first payment adds a hidden push twin).
  const written = w.inbox.filter((r) => r.user_id === reader).slice(CONTROLS);
  const named = written.filter((r) => !r.inbox_hidden).map((r) => r.id);
  expect(named.length).toBeGreaterThan(0);
  expect(await w.delivery.drain()).toBe(0); // 23:00: every push waits for 08:00
  change?.(w);
  clock = MORNING;
  await w.delivery.drain();
  const pushes = w.send.mock.calls.flatMap((c) => c[0]).filter((m) => m.to === TOKEN).length;
  return { w, me: req(reader), named, written: written.length, pushes, inbox: new NotificationsController(w.notifications) };
}

describe('NOTIFYMOVE: a client\'s notifications stay with every coach still authorised for them, and only them', () => {
  const opened = async (ids: string[], s: S) => {
    let n = 0;
    for (const id of ids) n += await s.inbox.markRead(id, s.me).then(() => 1, (e: unknown) => (e instanceof NotFoundException ? 0 : Promise.reject(e)));
    return n;
  };
  type S = Awaited<ReturnType<typeof setUp>>;
  // [path, what it serves, what a reader who keeps everything gets; everyone else gets the controls only].
  const PATHS: Array<[string, (s: S) => Promise<number>, (s: S, push: boolean) => number, number]> = [
    ['GET /notifications (rows)', async (s) => (await s.inbox.listNotifications(s.me, {})).items.length, (s) => s.named.length + CONTROLS, CONTROLS],
    ['GET /notifications (unread count)', async (s) => (await s.inbox.listNotifications(s.me, {})).unreadCount, (s) => s.named.length + CONTROLS, CONTROLS],
    ['GET /notifications/unread-count (badge)', async (s) => (await s.inbox.getUnreadCount(s.me)).count, (s) => s.named.length + CONTROLS, CONTROLS],
    ['POST /notifications/:id/read', (s) => opened(s.named, s), (s) => s.named.length, 0],
    ['POST /notifications/mark-all-read', async (s) => (await s.inbox.markAllRead(s.me)).updated, (s) => s.written + CONTROLS, CONTROLS],
    ['push at send time (08:00)', async (s) => s.pushes, (_s, push) => (push ? 1 : 0), 0],
  ];
  describe.each(TYPES)('%s', (_type, push, write) => {
    describe.each(READERS)('%s', (_who, reader, change, keeps) => {
      it.each(PATHS)('%s', async (_path, read, all, controls) => {
        const s = await setUp(write, reader, change);
        expect(await read(s)).toBe(keeps ? all(s, push) : controls);
        if (push) expect(s.w.outbox.filter((r) => r.user_id === reader).map((r) => r.result_code)).toEqual([keeps ? 'sent' : 'obsolete']);
      });
    });
  });

  it('the client keeps their own history after the move', async () => {
    const { w } = await setUp((x) => new MissedCheckinEmitter(x.notifications).emit({ daysMissed: 2, clientDisplayName: 'Jane Doe', coachId: 'coach-1', clientUserId: 'client-1' }), 'coach-1', (x) => x.move());
    await new MessageReceivedEmitter(w.notifications).emit('client-1', { senderName: 'Coach K', threadId: 'client-1' });
    const own = await new NotificationsController(w.notifications).listNotifications(req('client-1'), {});
    expect(own.items.map((r) => r.kind).sort()).toEqual([NotificationKind.MESSAGE_RECEIVED, NotificationKind.MISSED_CHECKIN]);
  });

  // Sol B1 (fix round 2): authorising the inbox, the badge and every push
  // costs a fixed, small number of reads, whatever the size of the roster.
  it('the inbox, the badge and a push cost the same reads for 1 or 12 delegated clients; a client pays one', async () => {
    const cost = async (roster: number) => {
      const w = world('sub-1', roster);
      await new BookingEmitter(w.notifications, w.prisma).emitBooked({ sessionId: 'sess-1', coachUserId: 'sub-1', clientDisplayName: 'Jane Doe', scheduledAt: new Date('2026-06-09T15:00:00Z') });
      const inbox = new NotificationsController(w.notifications);
      const spent = async (run: () => Promise<unknown>) => {
        const before = w.reads();
        await run();
        return w.reads() - before;
      };
      const paid = [
        await spent(() => inbox.listNotifications(req('sub-1'), {})),
        await spent(() => inbox.getUnreadCount(req('sub-1'))),
        await spent(() => inbox.listNotifications(req('client-1'), {})),
        await spent(() => inbox.getUnreadCount(req('client-1'))),
        await spent(async () => {
          clock = MORNING;
          await w.delivery.drain();
        }),
      ];
      expect(w.outbox.filter((r) => r.user_id === 'sub-1').map((r) => r.result_code)).toEqual(['sent']);
      return paid;
    };
    const one = await cost(1);
    expect(one.slice(0, 4)).toEqual([9, 9, 1, 1]);
    expect(await cost(12)).toEqual(one);
  });
});
