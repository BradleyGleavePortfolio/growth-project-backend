// AUD-OPUS-T23D-119 (Claude Opus 5.5 lens, agent 119) — probes on backend
// #672 @ 62c2c066a9347dcf16ad45d010f5434e85ae1a60 (FIX ROUND 10, Sol B-672-3:
// purchase + customer card from one REPEATABLE READ snapshot). Audit-only: never merge.
// Harness: noticeWorld() copied from #706 test/b-trials-4-fix-round.spec.ts, with
// a $transaction fake that can model a snapshot (reads frozen at the first statement).
//   N1 control: with SNAPSHOT semantics, a card removal committed after the
//      snapshot's first statement is invisible to the card read, so the copy is
//      the consistent pre-removal one ("will be charged $49"). This is the real
//      Postgres outcome; #706's "removed during the purchase read" test asserts
//      the opposite only because its fake is read-committed (C-706-1).
//   N2 control: a removal committed BEFORE the snapshot -> no-card copy.
//   N3 control: the card read fails inside the snapshot (pre-claim) -> nothing
//      sent, no attempt spent, the channel stays pending; next sweep sends.
//   N4 control: the snapshot transaction itself rejects before the claim (pool
//      wait / P2028) -> nothing sent, no attempt spent, retried later.
//   N5 probe (C-672-12, expected RED): the snapshot transaction rejects at the
//      admission re-prepare (after the claim) -> the attempt is spent and the
//      lease stays held (unlike the null path, which gives the attempt back).
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');

function noticeWorld(opts: { muted?: boolean; customerCard?: string | null; snapshot?: boolean } = {}) {
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'pur-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    status: 'trialing',
    entitlement_active: true,
    card_on_file: false,
    cancel_at_period_end: false,
    trial_ends_at: END,
  });
  const notices = makeTrialNoticeTable();
  const db = { customerCard: (opts.customerCard ?? null) as string | null };
  const hooks: { onPurchaseRead?: () => void; cardFails?: (n: number) => boolean; txFails?: (n: number) => boolean } = {};
  let cardReads = 0;
  let txCalls = 0;
  const purchaseRead = async (where: { id: string }) => {
    const p = purchases.rows.find((r) => r.id === where.id);
    return p
      ? {
          ...p,
          package: { name: 'Monthly', interval: 'month', interval_count: 1 },
          coach: { name: 'Coach' },
          client: { name: 'Client', email: 'client@example.test' },
        }
      : null;
  };
  const cardRead = async (value: () => string | null) => {
    cardReads += 1;
    if (hooks.cardFails?.(cardReads)) throw new Error('connection reset');
    return { default_payment_method_id: value() };
  };
  const prisma: Record<string, unknown> = {
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => purchaseRead(where)),
    },
    connectCustomer: { findUnique: jest.fn(async () => cardRead(() => db.customerCard)) },
    notificationPreferences: {
      findUnique: jest.fn(async () => ({ timezone: 'America/New_York', timezone_updated_at: NOW })),
    },
  };
  prisma.$transaction = jest.fn(async (cb: (tx: unknown) => unknown, txOpts?: { isolationLevel?: string }) => {
    txCalls += 1;
    if (hooks.txFails?.(txCalls)) throw Object.assign(new Error('Transaction API error'), { code: 'P2028' });
    if (!opts.snapshot) return cb(prisma);
    expect(txOpts?.isolationLevel).toBe('RepeatableRead');
    // Snapshot: frozen at the first statement of the transaction.
    let frozen: string | null | undefined;
    const freeze = () => {
      if (frozen === undefined) frozen = db.customerCard;
    };
    const tx = {
      ...prisma,
      clientPurchase: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          freeze();
          const row = await purchaseRead(where);
          hooks.onPurchaseRead?.(); // a commit by another session after the snapshot started
          return row;
        },
      },
      connectCustomer: {
        findUnique: async () => {
          freeze();
          return cardRead(() => frozen ?? null);
        },
      },
    };
    return cb(tx);
  });
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({ id: 'inapp', ...input })),
    getPreferences: jest.fn(async () => ({ muted: !!opts.muted })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = { send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })) };
  const service = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const enqueue = async () => {
    await notices.createMany({
      data: [
        {
          id: 'notice-1',
          purchase_id: 'pur-1',
          client_user_id: 'client-1',
          trial_ends_at: END,
          amount_cents: 4900,
          currency: 'usd',
          created_at: new Date(NOW.getTime() - 600_000),
        },
      ],
      skipDuplicates: true,
    });
    return 'notice-1';
  };
  return { prisma, notices, notifications, email, service, enqueue, hooks, db, txCount: () => txCalls };
}

describe('AUD-OPUS-T23D-119 #672 — B-672-3 round 10 (snapshot admission)', () => {
  it('N1 control: removal committed after the snapshot started is invisible: consistent charge copy', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    let n = 0;
    w.hooks.onPurchaseRead = () => {
      n += 1;
      if (n === 2) w.db.customerCard = null; // during the admission (post-claim) purchase read
    };
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain('will be charged $49');
  });

  it('N2 control: removal committed before the admission snapshot: no-card copy', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    w.notifications.getPreferences.mockImplementation(async () => {
      w.db.customerCard = null; // after the claim, before the admission snapshot
      return { muted: false };
    });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    const body = String(w.notifications.pushToUser.mock.calls[0][2]);
    expect(body).toContain('nothing will be charged');
    expect(body).not.toContain('will be charged $49');
  });

  it('N3 control: card read fails inside the snapshot before the claim: nothing sent, no attempt spent', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    w.hooks.cardFails = (k) => k === 1;
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'pending', push_attempts: 0, push_lease_token: null });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('N3b control: card read fails at the admission re-prepare: nothing sent, attempt given back', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    w.hooks.cardFails = (k) => k === 2;
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'pending', push_attempts: 0 });
  });

  it('N4 control: the snapshot transaction rejects before the claim: nothing sent, no attempt spent', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    w.hooks.txFails = (k) => k === 1;
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'pending', push_attempts: 0, push_lease_token: null });
  });

  it('N5 probe C-672-12 (expected RED): the snapshot rejects at admission: attempt should be given back, lease released', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer', snapshot: true });
    const id = await w.enqueue();
    w.hooks.txFails = (k) => k === 2;
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'pending', push_attempts: 0, push_lease_token: null });
  });
});
