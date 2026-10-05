import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter, type BookingDeliveryOutcome } from '../src/notifications/emitters/booking.emitter';
import { BookingRequestExpiryJob } from '../src/scheduling/jobs/request-expiry.job';
import { SchedulingJobLeaseService } from '../src/scheduling/jobs/scheduling-job-lease.service';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import { SchedulingFakeDb, asPrisma } from './utils/scheduling-fake-db';

const NOW = new Date('2026-10-06T15:59:59.000Z');
const DEADLINE = new Date('2026-10-06T16:00:00.000Z');
const CLIENT: ActorContext = { id: 'client', role: 'student', email: null, coach_id: 'coach' };
const DELIVERED: BookingDeliveryOutcome = { inapp: 'written', push: 'delivered', notificationId: 'n' };

function harness() {
  const db = new SchedulingFakeDb();
  db.addUser({ id: 'coach', name: 'Coach', role: 'coach' });
  db.addUser({ id: 'client', name: 'Client', role: 'student', coach_id: 'coach' });
  db.addSessionType({ id: 'type', coach_id: 'coach', name: 'Call', duration_minutes: 15 });
  for (let day = 0; day < 7; day++) db.addWindow('coach', day, 0, 1440);
  db.addSession({
    id: 'request', coach_id: 'coach', client_id: 'client', session_type_id: 'type',
    start_at: new Date('2026-10-06T17:00:00Z'), end_at: new Date('2026-10-06T17:15:00Z'),
    status: 'requested', request_expires_at: DEADLINE,
  });
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async () => undefined),
  });
  const emitter = Object.assign(Object.create(BookingEmitter.prototype) as BookingEmitter, {
    emitMoveRequested: jest.fn(async () => DELIVERED),
    emitRequestExpired: jest.fn(async () => DELIVERED),
  });
  return { db, audit, emitter };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('AUD-SOL-SCHA-121 expiry boundary probes', () => {
  it('a client move queued before its deadline must lose when the coach lock is acquired after the deadline', async () => {
    const { db, audit, emitter } = harness();
    const transaction = db.$transaction;
    db.$transaction = async (fn) => transaction(async (tx) => {
      const execute = tx.$executeRaw;
      tx.$executeRaw = async (strings, ...values) => {
        const result = await execute(strings, ...values);
        if (strings?.join('?').includes('pg_advisory_xact_lock')) {
          jest.setSystemTime(new Date(DEADLINE.getTime() + 1000));
        }
        return result;
      };
      return fn(tx);
    });
    const service = new SchedulingService(asPrisma(db), audit, undefined, emitter);
    const moving = service.rescheduleSession(CLIENT, 'request', {
      start_at: '2026-10-07T17:00:00Z', end_at: '2026-10-07T17:15:00Z',
    });
    await expect(moving).rejects.toMatchObject({
      response: { code: 'REQUEST_EXPIRED' }, status: 409,
    });
    expect(db.sessions.find((r) => r.id === 'request')?.start_at).toEqual(
      new Date('2026-10-06T17:00:00Z'),
    );
  });

  it('notices must not be born already expired after a long expiry pass, allowing a concurrent sweep to deliver the same notices', async () => {
    const { db, audit, emitter } = harness();
    jest.setSystemTime(DEADLINE);
    const update = db.coachingSession.updateMany;
    db.coachingSession.updateMany = async (args) => {
      const result = await update(args);
      if (args.data.status === 'expired') {
        // The expiry pass/backlog took five minutes before notices began.
        jest.setSystemTime(new Date(DEADLINE.getTime() + 5 * 60_000));
      }
      return result;
    };
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let resume: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    const recipients: string[] = [];
    emitter.emitRequestExpired = jest.fn(async (p) => {
      recipients.push(p.recipientUserId);
      if (recipients.length === 1) {
        entered();
        await blocked;
      }
      return DELIVERED;
    });
    const prisma = asPrisma(db);
    const lease = new SchedulingJobLeaseService(prisma);
    const a = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
    const b = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
    const first = a.sweep(DEADLINE);
    await enteredPromise;
    const later = await b.sweep(new Date());
    resume();
    await first;
    expect(later.lease).toBe('acquired');
    expect(recipients.filter((id) => id === 'client')).toHaveLength(1);
    expect(recipients.filter((id) => id === 'coach')).toHaveLength(1);
  });

  it('a sweep that died after taking the lease remains recoverable by another instance', async () => {
    const { db, audit, emitter } = harness();
    const prisma = asPrisma(db);
    const lease = new SchedulingJobLeaseService(prisma);
    expect(await lease.tryAcquire('booking-request-expiry', 'dead', 1000, NOW)).toMatchObject({
      acquired: true,
    });
    jest.setSystemTime(new Date(DEADLINE.getTime() + 1000));
    const job = new BookingRequestExpiryJob(prisma, emitter, audit, lease);
    expect(await job.sweep(new Date())).toMatchObject({ lease: 'acquired', expired: 1, notified: 2 });
  });
});
