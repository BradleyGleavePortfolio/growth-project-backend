import { BillingService } from '../src/billing/billing.service';
import { NotificationKind } from '../src/notifications/notification-kind';

// B7 — Stripe `payout.failed` / `payout.canceled` webhook handling.
//
// Before B7 these event types fell through to the `default` "ignoring
// unhandled" branch and were swallowed behind the StripeProcessedEvent
// dedup, so a coach got NO in-app signal that a bank payout bounced. These
// tests verify the failure is recorded on the cached PayoutSnapshot, a
// COACH_ALERT is emitted, the coach is never marked paid, and a replay is a
// no-op (idempotent).

function makePrisma(opts: { snapshot?: any | null } = {}) {
  const processed: any[] = [];
  // Mutable snapshot row so updateMany side-effects are observable across a
  // replay within the same test.
  const snapshotRow =
    opts.snapshot === undefined
      ? {
          id: 'snap_1',
          coach_user_id: 'coach-1',
          stripe_account_id: 'acct_abc',
          last_payout_stripe_id: null,
          last_payout_amount_cents: null,
          last_payout_status: null,
          last_payout_failure_message: null,
          currency: 'usd',
        }
      : opts.snapshot;

  const stub: any = {
    _processed: processed,
    _snapshot: snapshotRow,
    stripeProcessedEvent: {
      findUnique: jest.fn(async ({ where }: any) =>
        processed.find((e) => e.stripe_event_id === where.stripe_event_id) ??
        null,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async ({ data }: any) => {
        if (processed.find((e) => e.stripe_event_id === data.stripe_event_id)) {
          const err: any = new Error('dup');
          err.code = 'P2002';
          throw err;
        }
        processed.push({ ...data, processed_at: new Date() });
        return data;
      }),
    },
    payoutSnapshot: {
      findFirst: jest.fn(async ({ where }: any) =>
        snapshotRow && snapshotRow.stripe_account_id === where.stripe_account_id
          ? snapshotRow
          : null,
      ),
      // Faithfully models real Prisma/SQL evaluation of the WHERE clause so a
      // nullable `NOT` predicate reproduces the production NULL hazard the
      // auditor found (Prisma 6.19.3: all-NULL row -> { count: 0 }).
      //   - `where: { id }`            -> matches the row, updates it.
      //   - `where: { id, NOT: {a,b} }`-> SQL `NOT (col=a AND col2=b)`, which
      //     is UNKNOWN (NOT matched -> count:0) when either guarded column is
      //     NULL, exactly like Postgres three-valued logic.
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!snapshotRow || snapshotRow.id !== where.id) return { count: 0 };
        const not = where.NOT;
        if (not) {
          // SQL three-valued logic: col = ? is UNKNOWN when col is NULL, so
          // `NOT (a AND b)` cannot be TRUE -> the row is NOT matched.
          const eqA =
            snapshotRow.last_payout_stripe_id == null
              ? null
              : snapshotRow.last_payout_stripe_id === not.last_payout_stripe_id;
          const eqB =
            snapshotRow.last_payout_status == null
              ? null
              : snapshotRow.last_payout_status === not.last_payout_status;
          // inner = (eqA AND eqB) under three-valued logic
          let inner: boolean | null;
          if (eqA === false || eqB === false) inner = false;
          else if (eqA === null || eqB === null) inner = null;
          else inner = true;
          // matched only when NOT(inner) is TRUE, i.e. inner === false
          const matched = inner === false;
          if (!matched) return { count: 0 };
        }
        Object.assign(snapshotRow, data);
        return { count: 1 };
      }),
    },
    // Tables touched by the SaaS-subscription happy path. If B7 ever wrote
    // through them we'd see calls; the tests assert they are NOT called.
    coachSubscription: {
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    coachProfile: { findUnique: jest.fn(async () => null), update: jest.fn() },
  };
  stub.$transaction = jest.fn(async (cb: (tx: any) => Promise<any>) => cb(stub));
  return stub;
}

function makeService(prisma: any, notifications: any) {
  return new BillingService(
    prisma,
    { capture: jest.fn(), identify: jest.fn() } as any,
    { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
    undefined, // connect
    undefined, // checkoutWebhooks
    undefined, // email
    undefined, // guestCheckout
    undefined, // coachAiPacks
    notifications,
    undefined, // stripeApi
  );
}

function payoutEvent(
  id: string,
  type: 'payout.failed' | 'payout.canceled',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    // Connect events carry the account on the envelope.
    account: 'acct_abc',
    data: {
      object: {
        id: 'po_123',
        amount: 5000,
        currency: 'usd',
        status: type === 'payout.canceled' ? 'canceled' : 'failed',
        failure_code: 'account_closed',
        failure_message: 'The bank account has been closed.',
        ...overrides,
      },
    },
  } as any;
}

describe('BillingService — payout.failed / payout.canceled (B7)', () => {
  let prisma: any;
  let notifications: any;

  beforeEach(() => {
    prisma = makePrisma();
    notifications = { createNotification: jest.fn(async () => undefined) };
  });

  it('records the failure on PayoutSnapshot and alerts the coach (not swallowed)', async () => {
    const svc = makeService(prisma, notifications);
    const ignoreSpy = jest.spyOn((svc as any).logger, 'log');

    const result = await svc.handleEvent(payoutEvent('evt_po_1', 'payout.failed'));

    expect(result.processed).toBe(true);
    // The snapshot row carries the failure.
    expect(prisma._snapshot.last_payout_status).toBe('failed');
    expect(prisma._snapshot.last_payout_stripe_id).toBe('po_123');
    expect(prisma._snapshot.last_payout_amount_cents).toBe(5000);
    expect(prisma._snapshot.last_payout_failure_message).toContain(
      'account_closed',
    );
    // The coach is alerted via the existing COACH_ALERT kind.
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    const arg = notifications.createNotification.mock.calls[0][0];
    expect(arg.user_id).toBe('coach-1');
    expect(arg.kind).toBe(NotificationKind.COACH_ALERT);
    expect(arg.payload.event).toBe('payout_failed');
    // The default "ignoring unhandled" log line must NOT be hit.
    const ignored = ignoreSpy.mock.calls.some((c) =>
      String(c[0]).includes('Ignoring unhandled'),
    );
    expect(ignored).toBe(false);
    // The coach is NEVER marked paid — no subscription/invoice writes.
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.invoice.upsert).not.toHaveBeenCalled();
  });

  it('payout.canceled records terminal status "canceled"', async () => {
    const svc = makeService(prisma, notifications);
    await svc.handleEvent(payoutEvent('evt_po_c', 'payout.canceled'));
    expect(prisma._snapshot.last_payout_status).toBe('canceled');
    expect(notifications.createNotification.mock.calls[0][0].payload.event).toBe(
      'payout_canceled',
    );
  });

  it('is idempotent across a duplicate event id (replay = no-op)', async () => {
    const svc = makeService(prisma, notifications);
    const event = payoutEvent('evt_po_dup', 'payout.failed');
    const a = await svc.handleEvent(event);
    const b = await svc.handleEvent(event);
    expect(a.processed).toBe(true);
    expect(b.processed).toBe(false);
    expect(b.alreadyProcessed).toBe(true);
    // Only ONE alert despite two deliveries.
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across a DIFFERENT event id for the same payout failure (WHERE-guard)', async () => {
    const svc = makeService(prisma, notifications);
    await svc.handleEvent(payoutEvent('evt_po_a', 'payout.failed'));
    // Second event, different id, same payout id + terminal status. The
    // WHERE-guarded updateMany returns count=0, so NO second alert fires.
    await svc.handleEvent(payoutEvent('evt_po_b', 'payout.failed'));
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION (P0): first failure on an all-NULL snapshot records + alerts exactly once', async () => {
    // The cached snapshot has never seen a payout: both guarded columns are
    // NULL. Under real Prisma/SQL three-valued logic a nullable
    // `NOT (last_payout_stripe_id = ? AND last_payout_status = ?)` predicate
    // is UNKNOWN (not TRUE), so the old 0c88ce3 updateMany matched 0 rows and
    // the handler returned BEFORE alerting — the failed bank payout was
    // silently swallowed while the webhook was marked complete (the B7 money
    // bug). The fix decides idempotency in TypeScript and updates by
    // `{ id }` only, so the failure is recorded and the COACH_ALERT fires.
    prisma = makePrisma({
      snapshot: {
        id: 'snap_null',
        coach_user_id: 'coach-null',
        stripe_account_id: 'acct_abc',
        last_payout_stripe_id: null,
        last_payout_amount_cents: null,
        last_payout_status: null,
        last_payout_failure_message: null,
        currency: 'usd',
      },
    });
    const svc = makeService(prisma, notifications);

    const result = await svc.handleEvent(
      payoutEvent('evt_po_null', 'payout.failed'),
    );

    expect(result.processed).toBe(true);
    // Failure is persisted on the snapshot (NOT swallowed).
    expect(prisma._snapshot.last_payout_status).toBe('failed');
    expect(prisma._snapshot.last_payout_stripe_id).toBe('po_123');
    expect(prisma._snapshot.last_payout_amount_cents).toBe(5000);
    // Coach is alerted exactly once.
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification.mock.calls[0][0].user_id).toBe(
      'coach-null',
    );
    expect(notifications.createNotification.mock.calls[0][0].kind).toBe(
      NotificationKind.COACH_ALERT,
    );
  });

  it('REGRESSION (P0): stubbed updateMany count:0 still records + alerts on first NULL-snapshot failure', async () => {
    // Belt-and-suspenders: even if `updateMany` reports { count: 0 } (the
    // exact production symptom), the handler must NOT gate the alert on that
    // count anymore — idempotency is decided in TS off the loaded row. This
    // would fail against old 0c88ce3 logic, which returned on count===0.
    prisma = makePrisma({
      snapshot: {
        id: 'snap_z',
        coach_user_id: 'coach-z',
        stripe_account_id: 'acct_abc',
        last_payout_stripe_id: null,
        last_payout_amount_cents: null,
        last_payout_status: null,
        last_payout_failure_message: null,
        currency: 'usd',
      },
    });
    // Force the production symptom regardless of where-clause shape.
    prisma.payoutSnapshot.updateMany = jest.fn(async () => ({ count: 0 }));
    const svc = makeService(prisma, notifications);

    await svc.handleEvent(payoutEvent('evt_po_z', 'payout.failed'));

    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification.mock.calls[0][0].kind).toBe(
      NotificationKind.COACH_ALERT,
    );
  });

  it('does not throw (and skips) when no PayoutSnapshot exists for the account', async () => {
    prisma = makePrisma({ snapshot: null });
    const svc = makeService(prisma, notifications);
    const result = await svc.handleEvent(
      payoutEvent('evt_po_nosnap', 'payout.failed'),
    );
    expect(result.processed).toBe(true);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
