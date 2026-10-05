/**
 * S-SCHED-5 auto-expiry (OR-112-5): a booking request the coach does not
 * answer closes at a clear time, both sides get one calm notice, the slot is
 * free again, and the sweep is idempotent and single-runner.
 */
import { HttpException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import type { PushDeliveryResult } from '../src/notifications/push-delivery.types';
import {
  BookingRequestExpiryJob,
  REQUEST_EXPIRY_LEASE_NAME,
} from '../src/scheduling/jobs/request-expiry.job';
import { SchedulingJobLeaseService } from '../src/scheduling/jobs/scheduling-job-lease.service';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import { requestExpiresAt, type ActorContext } from '../src/scheduling/scheduling.types';
import { SchedulingFakeDb, asPrisma } from './utils/scheduling-fake-db';

const NOW = new Date('2026-10-05T15:00:00.000Z'); // Monday
const TUE_1000 = '2026-10-06T17:00:00.000Z';
const TUE_1015 = '2026-10-06T17:15:00.000Z';
const TUE_DEADLINE = new Date('2026-10-06T16:00:00.000Z'); // 1h before start

const COACH: ActorContext = { id: 'coach-1', role: 'coach', email: null, coach_id: null };
const CLIENT: ActorContext = { id: 'client-1', role: 'student', email: null, coach_id: 'coach-1' };
const CLIENT_2: ActorContext = {
  id: 'client-2',
  role: 'student',
  email: null,
  coach_id: 'coach-1',
};

class FakeNotifications {
  rows: CreateNotificationInput[] = [];
  pushes: Array<{ userId: string; title: string; body: string }> = [];
  pushResult: PushDeliveryResult = { delivered: true, code: 'delivered' };
  createNotification = jest.fn(async (input: CreateNotificationInput) => {
    this.rows.push(input);
    return { id: `notif-${this.rows.length}` };
  });
  getPreferences = jest.fn(async (userId: string) => ({
    user_id: userId,
    timezone: 'America/Los_Angeles',
    booking_push: true,
    booking_inapp: true,
    muted: false,
  }));
  pushToUser = jest.fn(async (userId: string, title: string, body: string) => {
    this.pushes.push({ userId, title, body });
    return this.pushResult;
  });
  expiredFor(userId: string): CreateNotificationInput[] {
    return this.rows.filter(
      (r) => r.user_id === userId && r.kind === NotificationKind.BOOKING_REQUEST_EXPIRED,
    );
  }
}

function harness() {
  const db = new SchedulingFakeDb();
  db.addUser({ id: 'coach-1', name: 'Coach Kim', role: 'coach' });
  db.addUser({ id: 'client-1', name: 'Client One', role: 'student', coach_id: 'coach-1' });
  db.addUser({ id: 'client-2', name: 'Client Two', role: 'student', coach_id: 'coach-1' });
  db.addSessionType({
    id: 'st-q',
    coach_id: 'coach-1',
    name: 'Quick Q/A Call',
    duration_minutes: 15,
    auto_approve: false,
  });
  db.addSessionType({
    id: 'st-open',
    coach_id: 'coach-1',
    name: 'Open call',
    duration_minutes: 15,
    auto_approve: true,
  });
  for (let day = 1; day <= 5; day++) db.addWindow('coach-1', day, 9 * 60, 17 * 60);
  const notifications = new FakeNotifications();
  const emitter = new BookingEmitter(
    Object.assign(
      Object.create(NotificationsService.prototype) as NotificationsService,
      notifications,
    ),
    asPrisma(db),
  );
  const auditWrites: Array<Record<string, unknown>> = [];
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async (input: Record<string, unknown>) => {
      auditWrites.push(input);
    }),
  });
  const prisma = asPrisma(db);
  const svc = new SchedulingService(prisma, audit, undefined, emitter);
  const lease = new SchedulingJobLeaseService(prisma);
  const job = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
  return { db, notifications, svc, auditWrites, job, emitter, audit, prisma, lease };
}

function req(actor: ActorContext, typeId: string, start = TUE_1000, end = TUE_1015) {
  return {
    coach_id: 'coach-1',
    session_type_id: typeId,
    title: 'Session',
    start_at: start,
    end_at: end,
  };
}

async function failure(
  p: Promise<unknown>,
): Promise<{ status: number; code: string; message: string; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) {
      const res = err.getResponse();
      const body: Record<string, unknown> =
        typeof res === 'object' && res !== null ? { ...res } : {};
      return {
        status: err.getStatus(),
        code: String(body.code),
        message: String(body.message),
        body,
      };
    }
    throw err;
  }
  throw new Error('expected a failure');
}

const CALM = (s: string) => {
  expect(s).not.toMatch(/!/);
  expect(s).not.toMatch(/\b(we|us|our)\b/i);
  expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
};

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
beforeEach(() => jest.setSystemTime(NOW));
afterAll(() => jest.useRealTimers());

describe('S-SCHED-5 requestExpiresAt rule', () => {
  it('is 1 hour before the start when that comes before 48 hours', () => {
    expect(requestExpiresAt(NOW, new Date(TUE_1000)).toISOString()).toBe(
      TUE_DEADLINE.toISOString(),
    );
  });
  it('is capped at 48 hours after the request', () => {
    const start = new Date('2026-10-20T17:00:00.000Z');
    expect(requestExpiresAt(NOW, start).toISOString()).toBe('2026-10-07T15:00:00.000Z');
  });
  it('a short-notice request that would get under 30 minutes stays open until the start', () => {
    const start = new Date(NOW.getTime() + 80 * 60_000); // 1h before = 20 min from now
    expect(requestExpiresAt(NOW, start).toISOString()).toBe(start.toISOString());
    const ok = new Date(NOW.getTime() + 95 * 60_000); // 1h before = 35 min from now
    expect(requestExpiresAt(NOW, ok).getTime()).toBe(ok.getTime() - 60 * 60_000);
  });
});

describe('S-SCHED-5 request lifecycle around the clear time', () => {
  it('a request carries its clear time; an instant booking has none; approval clears it', async () => {
    const { svc } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    expect(r.status).toBe('requested');
    expect(r.request_expires_at?.toISOString()).toBe(TUE_DEADLINE.toISOString());
    const approved = await svc.approveSession(COACH, r.id);
    expect(approved.status).toBe('scheduled');
    expect(approved.request_expires_at).toBeNull();
    const instant = await svc.requestSession(
      CLIENT_2,
      req(CLIENT_2, 'st-open', '2026-10-06T18:00:00.000Z', '2026-10-06T18:15:00.000Z'),
    );
    expect(instant.status).toBe('scheduled');
    expect(instant.request_expires_at).toBeNull();
  });

  it('at the clear time the request reads as expired and cannot be approved, declined, cancelled or moved', async () => {
    const { svc } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(TUE_DEADLINE);
    const view = await svc.getSession(CLIENT, r.id);
    expect(view.status).toBe('expired');
    expect(view.cancellable).toBe(false);
    expect(view.reschedulable).toBe(false);
    const approve = await failure(svc.approveSession(COACH, r.id));
    expect(approve).toMatchObject({ status: 409, code: 'REQUEST_EXPIRED' });
    expect(approve.body.request_expires_at).toBe(TUE_DEADLINE.toISOString());
    CALM(approve.message);
    const decline = await failure(svc.declineSession(COACH, r.id, 'Busy'));
    expect(decline.code).toBe('REQUEST_EXPIRED');
    const cancel = await failure(svc.cancelSession(CLIENT, r.id, {}));
    expect(cancel.code).toBe('REQUEST_EXPIRED');
    expect(cancel.message).toMatch(/Pick a new time/);
    CALM(cancel.message);
    const move = await failure(
      svc.rescheduleSession(CLIENT, r.id, {
        start_at: '2026-10-06T19:00:00.000Z',
        end_at: '2026-10-06T19:15:00.000Z',
      }),
    );
    expect(move.code).toBe('REQUEST_EXPIRED');
  });

  it('one minute before the clear time the coach can still approve', async () => {
    const { svc } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(new Date(TUE_DEADLINE.getTime() - 60_000));
    const ok = await svc.approveSession(COACH, r.id);
    expect(ok.status).toBe('scheduled');
  });

  it('the slot is free at exactly the clear time, even before the sweep runs', async () => {
    const { svc, db, auditWrites } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(new Date(TUE_DEADLINE.getTime() - 60_000));
    const taken = await failure(svc.requestSession(CLIENT_2, req(CLIENT_2, 'st-q')));
    expect(taken.code).toBe('SLOT_TAKEN');
    jest.setSystemTime(TUE_DEADLINE);
    const slots = await svc.getOpenSlots(CLIENT_2, 'coach-1', {
      from: '2026-10-06T16:30:00.000Z',
      to: '2026-10-06T19:00:00.000Z',
      session_type_id: 'st-q',
    });
    expect(slots.slots.map((s) => s.start_at)).toContain(TUE_1000);
    const second = await svc.requestSession(CLIENT_2, req(CLIENT_2, 'st-q'));
    expect(second.status).toBe('requested');
    const first = db.sessions.find((s) => s.id === r.id);
    expect(first).toMatchObject({ status: 'expired', end_reason: 'request_expired' });
    expect(auditWrites).toContainEqual(
      expect.objectContaining({
        action: 'session.expired',
        targetId: r.id,
        actorRole: 'system',
        metadata: expect.objectContaining({ source: 'booking' }),
      }),
    );
  });

  it('a client move that asks the coach again starts a fresh answer window', async () => {
    const { svc } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(new Date('2026-10-05T20:00:00.000Z'));
    const moved = await svc.rescheduleSession(CLIENT, r.id, {
      start_at: '2026-10-07T17:00:00.000Z',
      end_at: '2026-10-07T17:15:00.000Z',
    });
    expect(moved.status).toBe('requested');
    expect(moved.request_expires_at?.toISOString()).toBe('2026-10-07T16:00:00.000Z');
  });
});

describe('S-SCHED-5 expiry sweep', () => {
  it('closes the lapsed request, frees the slot and sends one calm notice to each side', async () => {
    const { svc, db, job, notifications, auditWrites } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    notifications.rows.length = 0;
    notifications.pushes.length = 0;
    jest.setSystemTime(TUE_DEADLINE);
    const res = await job.sweep(new Date());
    expect(res).toMatchObject({ lease: 'acquired', expired: 1, notified: 2, failed: 0 });
    expect(db.sessions.find((s) => s.id === r.id)).toMatchObject({
      status: 'expired',
      end_reason: 'request_expired',
    });
    const toClient = notifications.expiredFor('client-1');
    const toCoach = notifications.expiredFor('coach-1');
    expect(toClient).toHaveLength(1);
    expect(toCoach).toHaveLength(1);
    expect(toClient[0].body).toMatch(
      /was not confirmed in time, so it has closed\. Pick another time in Calendar\./,
    );
    expect(toCoach[0].body).toMatch(
      /^Client One's Quick Q\/A Call request for .+ closed without an answer, and the time is open again\.$/,
    );
    for (const n of [...toClient, ...toCoach]) CALM(n.body);
    for (const p of notifications.pushes) {
      expect(p.title).toBe('Session request closed');
      CALM(p.title);
      CALM(p.body);
    }
    expect(notifications.pushes.map((p) => p.userId).sort()).toEqual(['client-1', 'coach-1']);
    expect(
      db.deliveryLogs
        .filter((l) => l.kind === NotificationKind.BOOKING_REQUEST_EXPIRED)
        .map((l) => l.status),
    ).toEqual(['sent', 'sent']);
    expect(auditWrites.filter((a) => a.action === 'session.expired')).toHaveLength(1);

    // Idempotent: the next tick changes nothing and sends nothing.
    const again = await job.sweep(new Date(TUE_DEADLINE.getTime() + 5 * 60_000));
    expect(again).toMatchObject({ expired: 0, notified: 0, recovered: 0 });
    expect(notifications.pushes).toHaveLength(2);
    // The slot is bookable again.
    const next = await svc.requestSession(CLIENT_2, req(CLIENT_2, 'st-q'));
    expect(next.status).toBe('requested');
  });

  it('announces a request the booking transaction closed', async () => {
    const { svc, job, notifications } = harness();
    await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(TUE_DEADLINE);
    await svc.requestSession(CLIENT_2, req(CLIENT_2, 'st-q'));
    const res = await job.sweep(new Date());
    expect(res).toMatchObject({ expired: 0, notified: 2 });
    expect(notifications.expiredFor('client-1')).toHaveLength(1);
  });

  it('leaves an answered request alone', async () => {
    const { svc, db, job, notifications } = harness();
    const r = await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    await svc.approveSession(COACH, r.id);
    jest.setSystemTime(TUE_DEADLINE);
    const res = await job.sweep(new Date());
    expect(res).toMatchObject({ expired: 0, notified: 0 });
    expect(db.sessions.find((s) => s.id === r.id)?.status).toBe('scheduled');
    expect(notifications.expiredFor('client-1')).toHaveLength(0);
  });

  it('two machines sweeping at once: one holds the lease, each side is told once', async () => {
    const { svc, prisma, emitter, audit, lease, notifications } = harness();
    await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(TUE_DEADLINE);
    const a = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
    const b = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
    const [ra, rb] = await Promise.all([a.sweep(new Date()), b.sweep(new Date())]);
    expect([ra.lease, rb.lease].sort()).toEqual(['acquired', 'held']);
    expect(notifications.expiredFor('client-1')).toHaveLength(1);
    expect(notifications.expiredFor('coach-1')).toHaveLength(1);
  });

  it('a lease held by another machine skips the tick; an expired lease is taken over', async () => {
    const { svc, db, job } = harness();
    await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(TUE_DEADLINE);
    db.leases.push({
      name: REQUEST_EXPIRY_LEASE_NAME,
      holder: 'other-machine',
      lease_until: new Date(TUE_DEADLINE.getTime() + 60_000),
      acquired_at: TUE_DEADLINE,
    });
    expect(await job.sweep(new Date())).toMatchObject({ lease: 'held', expired: 0 });
    const later = new Date(TUE_DEADLINE.getTime() + 2 * 60_000);
    expect(await job.sweep(later)).toMatchObject({ lease: 'acquired', expired: 1 });
    // Released after the tick, so the next machine does not wait a full ttl.
    expect((db.leases[0].lease_until as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a request whose time passed long ago closes quietly (no late notice)', async () => {
    const { db, job, notifications } = harness();
    db.addSession({
      id: 'old-req',
      coach_id: 'coach-1',
      client_id: 'client-1',
      session_type_id: 'st-q',
      start_at: new Date('2026-10-01T17:00:00.000Z'),
      end_at: new Date('2026-10-01T17:15:00.000Z'),
      status: 'requested',
      request_expires_at: new Date('2026-10-01T17:00:00.000Z'),
    });
    const res = await job.sweep(NOW);
    expect(res).toMatchObject({ expired: 1, notified: 0 });
    expect(db.sessions.find((s) => s.id === 'old-req')?.status).toBe('expired');
    expect(notifications.rows).toHaveLength(0);
  });

  it('a failed push is retried on the next tick for that channel only, then settles', async () => {
    const { svc, db, job, notifications } = harness();
    await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    notifications.rows.length = 0;
    jest.setSystemTime(TUE_DEADLINE);
    notifications.pushResult = { delivered: false, code: 'transport-error' };
    const first = await job.sweep(new Date());
    expect(first).toMatchObject({ expired: 1, notified: 0, retrying: 2 });
    const inAppAfterFirst = notifications.rows.length;
    expect(inAppAfterFirst).toBe(2);
    notifications.pushResult = { delivered: true, code: 'delivered' };
    const second = await job.sweep(new Date(TUE_DEADLINE.getTime() + 5 * 60_000));
    expect(second).toMatchObject({ recovered: 2, notified: 2 });
    expect(notifications.rows).toHaveLength(inAppAfterFirst); // no duplicate in-app row
    expect(
      db.deliveryLogs
        .filter((l) => l.kind === NotificationKind.BOOKING_REQUEST_EXPIRED)
        .map((l) => l.status),
    ).toEqual(['sent', 'sent']);
  });

  it('gives up after three attempts with a safe reason', async () => {
    const { svc, db, job, notifications } = harness();
    await svc.requestSession(CLIENT, req(CLIENT, 'st-q'));
    jest.setSystemTime(TUE_DEADLINE);
    notifications.pushResult = { delivered: false, code: 'transport-error' };
    for (let i = 0; i < 4; i++) await job.sweep(new Date(TUE_DEADLINE.getTime() + i * 5 * 60_000));
    const logs = db.deliveryLogs.filter((l) => l.kind === NotificationKind.BOOKING_REQUEST_EXPIRED);
    expect(logs.map((l) => l.status)).toEqual(['gave_up', 'gave_up']);
    expect(logs.every((l) => (l.attempts as number) === 3)).toBe(true);
    expect(notifications.pushes.filter((p) => p.title === 'Session request closed')).toHaveLength(
      6,
    );
  });
});

describe('S-SCHED-5 migration 20270226000000', () => {
  const dir = path.join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20270226000000_scheduling_request_expiry',
  );
  const up = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
  const down = fs.readFileSync(path.join(dir, 'down.sql'), 'utf8');
  const integrity = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20270222000000_scheduling_lifecycle_integrity',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds expired, the clear-time column and index, and does not use the new value in the same file', () => {
    expect(up).toMatch(/ALTER TYPE "SessionStatus" ADD VALUE IF NOT EXISTS 'expired'/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS "request_expires_at" TIMESTAMP\(3\)/);
    expect(up).toMatch(/CoachingSession_status_request_expires_at_idx/);
    const sqlOnly = up.replace(/--.*$/gm, '');
    expect(sqlOnly.match(/'expired'/g)).toHaveLength(1);
  });

  it('the no-double-booking constraint does not count expired rows', () => {
    const m = integrity.match(/status" IN \(([^)]*)\)/);
    expect(m?.[1]).toBeDefined();
    expect(m?.[1]).not.toContain('expired');
  });

  it('SchedulingJobLease has RLS enabled and forced with service_role and owner policies', () => {
    expect(up).toMatch(/ALTER TABLE "SchedulingJobLease" ENABLE ROW LEVEL SECURITY/);
    expect(up).toMatch(/ALTER TABLE "SchedulingJobLease" FORCE ROW LEVEL SECURITY/);
    expect(up).toMatch(/ON "SchedulingJobLease"\s+AS PERMISSIVE FOR ALL TO service_role/);
    expect(up).toMatch(/app\.is_owner\(\)/);
  });

  it('down.sql reverses the table, index and column and keeps expired rows readable', () => {
    expect(down).toMatch(/DROP TABLE IF EXISTS "SchedulingJobLease"/);
    expect(down).toMatch(/DROP INDEX IF EXISTS "CoachingSession_status_request_expires_at_idx"/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS "request_expires_at"/);
    expect(down).toMatch(/SET "status" = 'declined'/);
  });
});
