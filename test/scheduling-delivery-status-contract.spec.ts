/**
 * S-SCHED-5 round 2 (B-634-7): the reminder job may only write delivery
 * statuses that the real database CHECK allows. Prisma types the column as
 * String, so tsc and Schema parity cannot see a missing CHECK member; this
 * spec ties the three sources of truth together:
 *   1. REMINDER_DELIVERY_STATUSES in src/scheduling/jobs/reminder.job.ts,
 *   2. NotificationDeliveryLog_status_check in migration 20270222000000,
 *   3. every status literal the job's source writes.
 * The in-memory test DB enforces (2), so a new status fails unit tests too.
 * Fails on 4d987916 ('parked' written, CHECK without it).
 */
import { SessionStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { REMINDER_DELIVERY_STATUSES } from '../src/scheduling/jobs/reminder.job';
import { SchedulingFakeDb, migrationDeliveryStatuses } from './utils/scheduling-fake-db';

const JOB_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'scheduling', 'jobs', 'reminder.job.ts'),
  'utf8',
);
const DOWN_SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20270222000000_scheduling_lifecycle_integrity',
    'down.sql',
  ),
  'utf8',
);

describe('S-SCHED-5 B-634-7: delivery status contract (job <-> database CHECK)', () => {
  it('the migration CHECK allows exactly the statuses the job declares', () => {
    expect([...migrationDeliveryStatuses()].sort()).toEqual([...REMINDER_DELIVERY_STATUSES].sort());
    expect(migrationDeliveryStatuses()).toContain('parked');
  });

  it('every status literal the job writes is in the declared set', () => {
    const written = new Set<string>();
    // `status:` literals on CoachingSession reads (SessionStatus values) are
    // not delivery-log writes; everything else must be in the CHECK.
    const sessionStatuses = new Set<string>(Object.values(SessionStatus));
    for (const m of JOB_SRC.matchAll(/\bstatus:\s*'([a-z_]+)'/g)) {
      if (!sessionStatuses.has(m[1])) written.add(m[1]);
    }
    for (const m of JOB_SRC.matchAll(/'(sent|retry|gave_up|sending|parked)'\s*(?:\||:|;|\))/g))
      written.add(m[1]);
    const allowed = new Set<string>(REMINDER_DELIVERY_STATUSES);
    expect(written.size).toBeGreaterThanOrEqual(4);
    expect([...written].filter((s) => !allowed.has(s))).toEqual([]);
  });

  it('down.sql drops the CHECK it added (rollback contract kept)', () => {
    expect(DOWN_SQL).toMatch(/DROP CONSTRAINT IF EXISTS "NotificationDeliveryLog_status_check"/);
  });

  it('the in-memory DB refuses a status the CHECK does not allow, on insert and update', async () => {
    const db = new SchedulingFakeDb();
    db.addSession({
      id: 's-1',
      coach_id: 'coach-1',
      client_id: 'client-1',
      status: 'scheduled',
      start_at: new Date('2027-03-01T10:00:00Z'),
      end_at: new Date('2027-03-01T10:30:00Z'),
    });
    await expect(
      db.notificationDeliveryLog.create({
        data: { session_id: 's-1', user_id: 'client-1', kind: 'k', status: 'bogus' },
      }),
    ).rejects.toThrow(/NotificationDeliveryLog_status_check/);
    const row = await db.notificationDeliveryLog.create({
      data: { session_id: 's-1', user_id: 'client-1', kind: 'k', status: 'retry' },
    });
    await expect(
      db.notificationDeliveryLog.updateMany({ where: { id: row.id }, data: { status: 'parked' } }),
    ).resolves.toEqual({ count: 1 });
    await expect(
      db.notificationDeliveryLog.updateMany({ where: { id: row.id }, data: { status: 'bogus' } }),
    ).rejects.toThrow(/NotificationDeliveryLog_status_check/);
  });
});
