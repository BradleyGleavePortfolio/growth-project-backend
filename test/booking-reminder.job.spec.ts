/**
 * Unit tests for SessionReminderJob — the 24h + 1h booking reminder
 * sweep cron. Asserts:
 *
 *   - the right sessions are picked up for each window
 *   - canceled / declined / no_show / completed / requested sessions
 *     are NOT picked up
 *   - both coach AND client are notified
 *   - NotificationDeliveryLog idempotency means re-runs do not
 *     double-send (unique-violation = skip)
 *
 * The test uses a minimal in-memory fake for PrismaService and a
 * jest-mocked BookingEmitter.
 */

import { SessionReminderJob } from '../src/scheduling/jobs/reminder.job';
import { NotificationKind } from '../src/notifications/notification-kind';

interface FakeSession {
  id: string;
  coach_id: string;
  client_id: string | null;
  status: string;
  start_at: Date;
  end_at: Date;
}

interface FakeLog {
  session_id: string;
  user_id: string;
  kind: string;
}

function buildPrismaFake(sessions: FakeSession[]) {
  const logs: FakeLog[] = [];
  const users = new Map<string, { name: string }>();
  users.set('coach-1', { name: 'Coach K' });
  users.set('client-1', { name: 'Jamie' });
  users.set('client-2', { name: 'Sam' });

  return {
    _logs: logs,
    coachingSession: {
      findMany: jest.fn(async (args: { where: { status: string; start_at: { gte: Date; lte: Date } } }) => {
        const lower = args.where.start_at.gte;
        const upper = args.where.start_at.lte;
        return sessions.filter(
          (s) =>
            s.status === args.where.status &&
            s.start_at >= lower &&
            s.start_at <= upper,
        );
      }),
    },
    notificationDeliveryLog: {
      create: jest.fn(async (args: { data: FakeLog }) => {
        const dup = logs.find(
          (l) =>
            l.session_id === args.data.session_id &&
            l.user_id === args.data.user_id &&
            l.kind === args.data.kind,
        );
        if (dup) {
          throw new Error('unique violation');
        }
        logs.push(args.data);
        return { id: `log-${logs.length}` };
      }),
    },
    user: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        const u = users.get(args.where.id);
        return u ? { name: u.name } : null;
      }),
    },
  };
}

function buildBookingEmitter() {
  return {
    emitRequested: jest.fn(),
    emitConfirmed: jest.fn(),
    emitDeclined: jest.fn(),
    emitCancelled: jest.fn(),
    emitRescheduled: jest.fn(),
    emitReminder24h: jest.fn().mockResolvedValue(undefined),
    emitReminder1h: jest.fn().mockResolvedValue(undefined),
  };
}

function session(
  overrides: Partial<FakeSession> & { id: string; startsInMinutes: number },
): FakeSession {
  const start = new Date(Date.now() + overrides.startsInMinutes * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    coach_id: 'coach-1',
    client_id: 'client-1',
    status: 'scheduled',
    start_at: start,
    end_at: end,
    ...overrides,
  };
}

describe('SessionReminderJob — 1h reminder sweep', () => {
  it('dispatches to BOTH coach and client for a scheduled session in window', async () => {
    const sessions = [session({ id: 'sess-1', startsInMinutes: 60 })];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const result = await job.dispatchWindow({
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient, otherName, s) =>
        emitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    });

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toBe(2);
    expect(emitter.emitReminder1h).toHaveBeenCalledTimes(2);

    // The client should see "Coach K" and the coach should see "Jamie".
    const recipients = emitter.emitReminder1h.mock.calls.map((c: [{ recipientUserId: string; otherPartyDisplayName: string }]) => ({
      r: c[0].recipientUserId,
      other: c[0].otherPartyDisplayName,
    }));
    expect(recipients).toEqual(
      expect.arrayContaining([
        { r: 'client-1', other: 'Coach K' },
        { r: 'coach-1', other: 'Jamie' },
      ]),
    );
  });

  it('SKIPS sessions in status canceled / declined / no_show / completed / requested', async () => {
    const sessions: FakeSession[] = [
      session({ id: 's-cancel', startsInMinutes: 60, status: 'canceled' }),
      session({ id: 's-decline', startsInMinutes: 60, status: 'declined' }),
      session({ id: 's-noshow', startsInMinutes: 60, status: 'no_show' }),
      session({ id: 's-complete', startsInMinutes: 60, status: 'completed' }),
      session({ id: 's-request', startsInMinutes: 60, status: 'requested' }),
    ];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const result = await job.dispatchWindow({
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient, otherName, s) =>
        emitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    });

    expect(result.scanned).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(emitter.emitReminder1h).not.toHaveBeenCalled();
  });

  it('idempotency: a second sweep over the same window does NOT re-emit', async () => {
    const sessions = [session({ id: 'sess-idem', startsInMinutes: 60 })];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const args = {
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient: string, otherName: string, s: { id: string; start_at: Date }) =>
        emitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    };

    const first = await job.dispatchWindow(args);
    const second = await job.dispatchWindow(args);

    expect(first.dispatched).toBe(2);
    expect(second.dispatched).toBe(0);
    expect(second.skipped).toBe(2);
    expect(emitter.emitReminder1h).toHaveBeenCalledTimes(2);
    expect(prisma._logs.length).toBe(2);
  });

  it('handles a coach-only session (client_id null) without crashing', async () => {
    const sessions = [
      session({ id: 'sess-solo', startsInMinutes: 60, client_id: null }),
    ];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const result = await job.dispatchWindow({
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient, otherName, s) =>
        emitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    });
    expect(result.scanned).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(emitter.emitReminder1h).toHaveBeenCalledTimes(1);
  });
});

describe('SessionReminderJob — 24h reminder sweep', () => {
  it('picks up sessions ~24h out', async () => {
    const sessions = [
      session({ id: 'sess-24', startsInMinutes: 60 * 24 }),
      // 1h-out session must NOT be picked up by the 24h window.
      session({ id: 'sess-1h', startsInMinutes: 60 }),
    ];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const result = await job.dispatchWindow({
      lowerOffsetMinutes: 60 * 24 - 15,
      upperOffsetMinutes: 60 * 24 + 15,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      emit: (recipient, otherName, s) =>
        emitter.emitReminder24h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    });

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toBe(2);
    expect(emitter.emitReminder24h).toHaveBeenCalledTimes(2);
  });

  it('partial-claim: when 24h reminder already claimed for one user, only the other user receives it', async () => {
    const sessions = [session({ id: 'sess-partial', startsInMinutes: 60 * 24 })];
    const prisma = buildPrismaFake(sessions);
    // Pre-seed: client already received the 24h reminder.
    prisma._logs.push({
      session_id: 'sess-partial',
      user_id: 'client-1',
      kind: NotificationKind.BOOKING_REMINDER_24H,
    });
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const result = await job.dispatchWindow({
      lowerOffsetMinutes: 60 * 24 - 15,
      upperOffsetMinutes: 60 * 24 + 15,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      emit: (recipient, otherName, s) =>
        emitter.emitReminder24h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: s.id,
          scheduledAt: s.start_at,
        }),
    });

    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(1);
    expect(emitter.emitReminder24h).toHaveBeenCalledTimes(1);
    expect(
      emitter.emitReminder24h.mock.calls[0][0].recipientUserId,
    ).toBe('coach-1');
  });
});

describe('SessionReminderJob — findDueReminders helper', () => {
  it('returns scheduled sessions in the requested window only', async () => {
    const sessions = [
      session({ id: 's-in', startsInMinutes: 30 }),
      session({ id: 's-out', startsInMinutes: 120 }),
      session({ id: 's-canceled', startsInMinutes: 30, status: 'canceled' }),
    ];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = new SessionReminderJob(prisma as never, emitter as never);

    const due = await job.findDueReminders(60);
    expect(due.map((s) => s.id)).toEqual(['s-in']);
  });
});
