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
import type { PrismaService } from '../src/prisma.service';
import type { BookingEmitter } from '../src/notifications/emitters/booking.emitter';

interface FakeSession {
  id: string;
  coach_id: string;
  client_id: string | null;
  status: string;
  start_at: Date;
  end_at: Date;
}

interface FakeLog {
  id?: string;
  session_id: string;
  user_id: string;
  kind: string;
  /** Claim key part (B-NOTIF-4): the session start the claim is for. */
  start_at: Date;
  status?: string;
  attempts?: number;
  claim_token?: string | null;
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
      findMany: jest.fn(
        async (args: {
          where: {
            id?: { in: string[] };
            status?: string | { in: string[] };
            start_at?: { gte: Date; lte: Date };
          };
        }) => {
          // S-SCHED-4: the recovery pass loads sessions by id.
          const ids = args.where.id?.in;
          if (ids) return sessions.filter((s) => ids.includes(s.id));
          if (!args.where.start_at || !args.where.status) return [];
          const lower = args.where.start_at.gte;
          const upper = args.where.start_at.lte;
          const wanted = args.where.status;
          // S-SCHED-2: the sweep asks for status IN (scheduled, pending_provider).
          const statusOk = (status: string) =>
            typeof wanted === 'string' ? status === wanted : wanted.in.includes(status);
          return sessions.filter(
            (s) => statusOk(s.status) && s.start_at >= lower && s.start_at <= upper,
          );
        },
      ),
      // S-SCHED-3: the sweep re-reads each session before sending (fence).
      findUnique: jest.fn(
        async (args: { where: { id: string } }) =>
          sessions.find((s) => s.id === args.where.id) ?? null,
      ),
    },
    notificationDeliveryLog: {
      create: jest.fn(async (args: { data: FakeLog }) => {
        // Claim key (session_id, user_id, kind, start_at) (B-NOTIF-4).
        const dup = logs.find(
          (l) =>
            l.session_id === args.data.session_id &&
            l.user_id === args.data.user_id &&
            l.kind === args.data.kind &&
            l.start_at.getTime() === args.data.start_at.getTime(),
        );
        if (dup) {
          // Real Prisma reports the unique-key violation as P2002.
          throw Object.assign(new Error('unique violation'), { code: 'P2002' });
        }
        const row = { id: `log-${logs.length + 1}`, ...args.data };
        logs.push(row);
        return row;
      }),
      // S-SCHED-4: the recovery pass reads unfinished rows ('retry', or
      // 'sending' with an expired lease) of the sweep's kind.
      findMany: jest.fn(async (args: { where: { kind: string } }) =>
        logs.filter((l) => {
          if (l.kind !== args.where.kind) return false;
          if (l.status === 'retry') return true;
          const lease = (l as { lease_until?: Date | null }).lease_until ?? null;
          return l.status === 'sending' && (lease === null || lease.getTime() <= Date.now());
        }),
      ),
      findFirst: jest.fn(
        async (args: {
          where: { session_id: string; user_id: string; kind: string; start_at: Date };
        }) =>
          logs.find(
            (l) =>
              l.session_id === args.where.session_id &&
              l.user_id === args.where.user_id &&
              l.kind === args.where.kind &&
              l.start_at.getTime() === args.where.start_at.getTime(),
          ) ?? null,
      ),
      updateMany: jest.fn(async (args: { where: Partial<FakeLog>; data: Partial<FakeLog> }) => {
        let count = 0;
        for (const l of logs) {
          const keys = Object.keys(args.where) as Array<keyof FakeLog>;
          if (keys.every((k) => l[k] === args.where[k])) {
            Object.assign(l, args.data);
            count += 1;
          }
        }
        return { count };
      }),
      // releaseClaim: a fresh claim whose session moved or was cancelled.
      deleteMany: jest.fn(async (args: { where: { id: string; claim_token: string } }) => {
        const before = logs.length;
        for (let i = logs.length - 1; i >= 0; i--) {
          if (logs[i].id === args.where.id && logs[i].claim_token === args.where.claim_token) {
            logs.splice(i, 1);
          }
        }
        return { count: before - logs.length };
      }),
    },
    // Sol B-647-1: remindOne's fence reads the session FOR SHARE inside a
    // transaction; the fake answers from the CURRENT session state (what a
    // FOR SHARE read sees once any in-flight reschedule has committed).
    $transaction: jest.fn(
      async <T>(
        fn: (tx: {
          $queryRaw: (...a: unknown[]) => Promise<unknown[]>;
          coachingSession: { findUnique: (a: { where: { id: string } }) => Promise<unknown> };
        }) => Promise<T>,
      ): Promise<T> =>
        fn({
          $queryRaw: async () => [],
          coachingSession: {
            findUnique: async (a: { where: { id: string } }) =>
              sessions.find((s) => s.id === a.where.id) ?? null,
          },
        }),
    ),
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

function cronJob(
  prisma: ReturnType<typeof buildPrismaFake>,
  emitter: ReturnType<typeof buildBookingEmitter>,
): SessionReminderJob {
  // @ts-expect-error R0 partial Prisma test double supplies every delegate the cron reads.
  const db: PrismaService = prisma;
  // @ts-expect-error R0 partial emitter test double stubs each public emit method; no private emitter implementation runs.
  const notifications: BookingEmitter = emitter;
  return new SessionReminderJob(db, notifications);
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
    const job = cronJob(prisma, emitter);

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
    const recipients = emitter.emitReminder1h.mock.calls.map(
      (c: [{ recipientUserId: string; otherPartyDisplayName: string }]) => ({
        r: c[0].recipientUserId,
        other: c[0].otherPartyDisplayName,
      }),
    );
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
    const job = cronJob(prisma, emitter);

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
    const job = cronJob(prisma, emitter);

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
    const sessions = [session({ id: 'sess-solo', startsInMinutes: 60, client_id: null })];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);

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
    const job = cronJob(prisma, emitter);

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
      start_at: sessions[0].start_at,
    });
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);

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
    expect(emitter.emitReminder24h.mock.calls[0][0].recipientUserId).toBe('coach-1');
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
    const job = cronJob(prisma, emitter);

    const due = await job.findDueReminders(60);
    expect(due.map((s) => s.id)).toEqual(['s-in']);
  });
});

describe('SessionReminderJob — explicit launch switch', () => {
  const original = process.env.BOOKING_REMINDERS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
    else process.env.BOOKING_REMINDERS_ENABLED = original;
  });

  it.each([undefined, '', 'off', 'false', 'true', 'ON', 'invalid'])(
    'does not dispatch either reminder when configured as %s',
    async (value) => {
      if (value === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
      else process.env.BOOKING_REMINDERS_ENABLED = value;
      const prisma = buildPrismaFake([]);
      const job = cronJob(prisma, buildBookingEmitter());
      await job.runOneHourReminderSweep();
      await job.runTwentyFourHourReminderSweep();
      expect(prisma.coachingSession.findMany).not.toHaveBeenCalled();
    },
  );

  it('dispatches both cron windows only with explicit on', async () => {
    process.env.BOOKING_REMINDERS_ENABLED = 'on';
    const prisma = buildPrismaFake([
      session({ id: 'one-hour', startsInMinutes: 60 }),
      session({ id: 'one-day', startsInMinutes: 1440 }),
    ]);
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    await job.runOneHourReminderSweep();
    await job.runTwentyFourHourReminderSweep();
    expect(emitter.emitReminder1h).toHaveBeenCalledTimes(2);
    expect(emitter.emitReminder24h).toHaveBeenCalledTimes(2);
  });
});

// Sol B-647-1 (backend main #647, merged into S-SCHED-2): a reminder claim is
// bound to the start time the sweep selected (claim key session, user, kind,
// start_at), and nothing is sent unless the session, re-read FOR SHARE inside
// a transaction, is still confirmed at that start.
describe('SessionReminderJob — schedule generation fence (Sol B-647-1)', () => {
  const window24h = (emitter: ReturnType<typeof buildBookingEmitter>) => ({
    lowerOffsetMinutes: 60 * 24 - 15,
    upperOffsetMinutes: 60 * 24 + 15,
    kind: NotificationKind.BOOKING_REMINDER_24H,
    emit: (recipient: string, otherName: string, s: FakeSession) =>
      emitter.emitReminder24h({
        recipientUserId: recipient,
        otherPartyDisplayName: otherName,
        sessionId: s.id,
        scheduledAt: s.start_at,
      }),
  });
  const window1h = (emitter: ReturnType<typeof buildBookingEmitter>) => ({
    lowerOffsetMinutes: 55,
    upperOffsetMinutes: 65,
    kind: NotificationKind.BOOKING_REMINDER_1H,
    emit: (recipient: string, otherName: string, s: FakeSession) =>
      emitter.emitReminder1h({
        recipientUserId: recipient,
        otherPartyDisplayName: otherName,
        sessionId: s.id,
        scheduledAt: s.start_at,
      }),
  });

  it('a sweep that read the old slot before a reschedule committed emits nothing and keeps no claim', async () => {
    const sessions = [session({ id: 'sess-moved', startsInMinutes: 60 * 24 })];
    const prisma = buildPrismaFake(sessions);
    const movedTo = new Date(sessions[0].start_at.getTime() + 3 * 60 * 60_000);
    // The sweep's band read returns the old snapshot; the reschedule commits
    // before the sweep's fence read.
    prisma.coachingSession.findMany.mockImplementationOnce(async () => {
      const snapshot = sessions.map((s) => ({ ...s }));
      sessions[0].start_at = movedTo;
      return snapshot;
    });
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);

    const result = await job.dispatchWindow(window24h(emitter));
    expect(emitter.emitReminder24h).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(0);
    expect(prisma._logs).toEqual([]);

    // The new time's sweep reminds both people, once.
    jest.useFakeTimers({ now: new Date(movedTo.getTime() - 24 * 60 * 60_000) });
    try {
      const again = await job.dispatchWindow(window24h(emitter));
      expect(again.dispatched).toBe(2);
      expect(emitter.emitReminder24h.mock.calls.map((c) => c[0].scheduledAt)).toEqual([
        movedTo,
        movedTo,
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an old-time claim (written by a stale sweep) does not suppress the new time', async () => {
    const sessions = [session({ id: 'sess-new', startsInMinutes: 60 * 24 })];
    const prisma = buildPrismaFake(sessions);
    const oldStart = new Date(sessions[0].start_at.getTime() - 2 * 60 * 60_000);
    for (const user_id of ['client-1', 'coach-1']) {
      prisma._logs.push({
        id: `old-${user_id}`,
        session_id: 'sess-new',
        user_id,
        kind: NotificationKind.BOOKING_REMINDER_24H,
        start_at: oldStart,
        status: 'sent',
      });
    }
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    const result = await job.dispatchWindow(window24h(emitter));
    expect(result.dispatched).toBe(2);
    expect(prisma._logs).toHaveLength(4);
  });

  it('a no-op reschedule (same slot) cannot replay a reminder that already went out', async () => {
    const sessions = [session({ id: 'sess-same', startsInMinutes: 60 * 24 })];
    const prisma = buildPrismaFake(sessions);
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    expect((await job.dispatchWindow(window24h(emitter))).dispatched).toBe(2);
    // "Reschedule" to the identical start time: the claims stay valid.
    sessions[0].start_at = new Date(sessions[0].start_at.getTime());
    const again = await job.dispatchWindow(window24h(emitter));
    expect(again.dispatched).toBe(0);
    expect(again.skipped).toBe(2);
    expect(emitter.emitReminder24h).toHaveBeenCalledTimes(2);
  });

  it('a session cancelled after the sweep read it is not reminded', async () => {
    const sessions = [session({ id: 'sess-cancel', startsInMinutes: 60 })];
    const prisma = buildPrismaFake(sessions);
    prisma.coachingSession.findMany.mockImplementationOnce(async () => {
      const snapshot = sessions.map((s) => ({ ...s }));
      sessions[0].status = 'canceled';
      return snapshot;
    });
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    const result = await job.dispatchWindow(window1h(emitter));
    expect(result.dispatched).toBe(0);
    expect(emitter.emitReminder1h).not.toHaveBeenCalled();
    expect(prisma._logs).toEqual([]);
  });

  it('a claim that cannot be written (database error) never emits unclaimed and counts as failed (B-634-2)', async () => {
    const sessions = [session({ id: 'sess-dberr', startsInMinutes: 60 })];
    const prisma = buildPrismaFake(sessions);
    prisma.notificationDeliveryLog.create.mockRejectedValue(new Error('connection reset'));
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    const result = await job.dispatchWindow(window1h(emitter));
    expect(result.dispatched).toBe(0);
    // Only P2002 means "already claimed"; any other error is a failure the
    // next sweep retries, never a skip.
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(2);
    expect(emitter.emitReminder1h).not.toHaveBeenCalled();
  });

  it('the fence is read FOR SHARE in a transaction; a failed fence read sends nothing', async () => {
    const sessions = [session({ id: 'sess-fence', startsInMinutes: 60 })];
    const prisma = buildPrismaFake(sessions);
    const sql: string[] = [];
    prisma.$transaction.mockImplementationOnce(async (fn) =>
      fn({
        $queryRaw: async (strings: unknown) => {
          sql.push((strings as TemplateStringsArray).join('?'));
          return [];
        },
        coachingSession: {
          findUnique: async (a: { where: { id: string } }) =>
            sessions.find((s) => s.id === a.where.id) ?? null,
        },
      }),
    );
    prisma.$transaction.mockRejectedValueOnce(new Error('connection reset'));
    const emitter = buildBookingEmitter();
    const job = cronJob(prisma, emitter);
    const result = await job.dispatchWindow(window1h(emitter));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('FOR SHARE');
    // First recipient: fence held, sent. Second: fence read failed, nothing
    // sent, its claim stays 'sending' for the next sweep to take over.
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
    expect(emitter.emitReminder1h).toHaveBeenCalledTimes(1);
    expect(prisma._logs.map((l) => l.status)).toEqual(['sent', 'sending']);
  });
});
