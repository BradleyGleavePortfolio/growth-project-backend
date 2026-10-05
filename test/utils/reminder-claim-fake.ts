/**
 * In-memory stand-in for the reminder claim ledger (Sol B-647-1).
 *
 * SessionReminderJob.claimDelivery runs one interactive transaction:
 *   SELECT start_at, status FROM "CoachingSession" WHERE id = $1 FOR SHARE
 *   then createMany(skipDuplicates) on (session_id, user_id, kind, start_at).
 * This fake answers the SELECT from the CURRENT session state (what a FOR
 * SHARE read sees after any committed reschedule) and enforces the widened
 * unique key, so tests can interleave a stale sweep with a reschedule.
 */
export interface FakeClaim {
  session_id: string;
  user_id: string;
  kind: string;
  start_at: Date;
}

export interface ClaimableSession {
  id: string;
  status: string;
  start_at: Date;
}

export function reminderClaimLedger(currentSession: (id: string) => ClaimableSession | undefined) {
  const claims: FakeClaim[] = [];
  const sameKey = (a: FakeClaim, b: FakeClaim) =>
    a.session_id === b.session_id &&
    a.user_id === b.user_id &&
    a.kind === b.kind &&
    a.start_at.getTime() === b.start_at.getTime();
  const tx = {
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const s = currentSession(String(values[0]));
      return s ? [{ start_at: new Date(s.start_at.getTime()), status: s.status }] : [];
    }),
    notificationDeliveryLog: {
      createMany: jest.fn(async ({ data }: { data: FakeClaim[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          if (claims.some((c) => sameKey(c, row))) continue;
          claims.push({ ...row, start_at: new Date(row.start_at.getTime()) });
          count += 1;
        }
        return { count };
      }),
    },
  };
  return {
    claims,
    tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}
