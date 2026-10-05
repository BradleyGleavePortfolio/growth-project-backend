/**
 * In-memory stand-in for the reminder claim ledger (Sol B-647-1, S-SCHED-3).
 *
 * SessionReminderJob claims each (session, recipient, kind, start_at) by an
 * insert on NotificationDeliveryLog (the unique key carries start_at), drives
 * the claim through its delivery states with token-guarded updateMany calls,
 * and, before anything is sent, re-reads the session inside a transaction
 * after `SELECT ... FOR SHARE` so an in-flight reschedule or cancel commits
 * first. The ledger reuses SchedulingFakeDb's NotificationDeliveryLog model
 * (unique key, status CHECK, column defaults) and answers the fenced read
 * from the CURRENT session state (what a FOR SHARE read sees after any
 * committed reschedule), so tests can interleave a stale sweep with a
 * reschedule.
 */
import { SchedulingFakeDb } from './scheduling-fake-db';

export interface ClaimableSession {
  id: string;
  status: string;
  start_at: Date;
}

export function reminderClaimLedger(currentSession: (id: string) => ClaimableSession | undefined) {
  const db = new SchedulingFakeDb();
  const claims = db.deliveryLogs;
  const tx = {
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []),
    coachingSession: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const s = currentSession(where.id);
        return s ? { ...s, start_at: new Date(s.start_at.getTime()) } : null;
      }),
    },
  };
  return {
    claims,
    tx,
    notificationDeliveryLog: db.notificationDeliveryLog,
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}
