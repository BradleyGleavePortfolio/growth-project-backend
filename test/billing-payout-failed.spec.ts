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
      // Mimic the WHERE-guard: only "update" (count=1) when the row is NOT
      // already at this exact (payout id, terminal status).
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!snapshotRow || snapshotRow.id !== where.id) return { count: 0 };
        const not = where.NOT;
        const alreadyTerminal =
          not &&
          snapshotRow.last_payout_stripe_id === not.last_payout_stripe_id &&
          snapshotRow.last_payout_status === not.last_payout_status;
        if (alreadyTerminal) return { count: 0 };
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
