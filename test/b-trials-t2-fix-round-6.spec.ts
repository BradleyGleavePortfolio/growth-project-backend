// B-T12-116 (trials T2 fix round 6) — regressions for the audit findings on
// backend #672 @ e06b5b13, run against the real TrialNoticeService over the
// constraint-aware in-memory tables (test/utils/trial-fakes.ts):
//   B-672-1 (Sol) / C-672-1 (Opus)  a channel claim takes its lease from a
//       fresh clock at the claim, never the sweep's start time, so a row
//       reached late in a slow sweep is not claimed with an expiring lease
//       that a second replica can take while the first send is in flight;
//       a claim whose preparation used up its lease sends nothing;
//   B-672-2 (Sol) / C-672-2 (Opus)  notices for cancelled or missing
//       purchases are settled 'skipped', and the retry sweep pages by
//       (created_at, id), so no prefix of skipped, unknown-card or leased
//       rows can hide a later healthy notice;
//   B-672-1 (Opus)  the trial-end date uses main's recipient time-zone rule
//       (resolveRecipientTimeZone: a stamped preference, else the coach's
//       zone); with no usable zone the date is the earliest calendar date
//       the end falls on anywhere, never a day late;
//   C-672-5 (Opus, operator ruling)  "plus any tax" when Stripe may add tax.
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');
const TICK = 29_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface WorldOpts {
  prefs?: { timezone: string; timezone_updated_at: Date | null } | null;
  coachZone?: string | null;
}

function build(opts: WorldOpts = {}) {
  const purchases = makeTable([['id']], () => ({}));
  const notices = makeTrialNoticeTable();
  const customer = {
    findUnique: jest.fn(
      async (_args: {
        where: { client_user_id: string };
      }): Promise<{ default_payment_method_id: string | null } | null> => ({
        default_payment_method_id: null,
      }),
    ),
  };
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({
      id: 'inapp',
      ...input,
    })),
    getPreferences: jest.fn(async (_userId: string): Promise<Record<string, unknown>> => ({
      muted: false,
    })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = {
    send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })),
  };
  const prefs = opts.prefs === undefined ? null : opts.prefs;
  const prisma = {
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = purchases.rows.find((row) => row.id === where.id);
        return p
          ? {
              ...p,
              package: { name: 'Monthly', interval: 'month', interval_count: 1 },
              coach: { name: 'Coach' },
              client: { name: 'Client', email: 'client@example.test' },
            }
          : null;
      }),
    },
    connectCustomer: customer,
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        where.user_id === 'coach-a' && opts.coachZone ? { timezone: opts.coachZone } : null,
      ),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id.startsWith('client') ? { coach_id: 'coach-a' } : null,
      ),
    },
    coachingSession: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const makeService = () =>
    new TrialNoticeService(
      stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
      stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
      stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
    );
  const service = makeService();
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id,
      client_user_id: 'client-a',
      coach_user_id: 'coach-a',
      package_id: 'pkg-a',
      amount_cents: 4900,
      currency: 'usd',
      status: 'trialing',
      entitlement_active: true,
      card_on_file: true,
      cancel_at_period_end: false,
      trial_ends_at: END,
      ...extra,
    };
    purchases.rows.push(row);
    return row;
  };
  const enqueue = async (purchaseId: string, extra: Record<string, unknown> = {}) => {
    await notices.createMany({
      data: [
        {
          id: `notice-${purchaseId}`,
          purchase_id: purchaseId,
          client_user_id: 'client-a',
          trial_ends_at: END,
          amount_cents: 4900,
          currency: 'usd',
          created_at: new Date(NOW.getTime() - 600_000),
          ...extra,
        },
      ],
      skipDuplicates: true,
    });
    return `notice-${purchaseId}`;
  };
  const pushesFor = (purchaseId: string) =>
    notifications.pushToUser.mock.calls.filter(
      (args) => (args[3] as { purchase_id?: string } | undefined)?.purchase_id === purchaseId,
    );
  return {
    purchases,
    notices,
    customer,
    notifications,
    email,
    prisma,
    service,
    makeService,
    add,
    enqueue,
    pushesFor,
  };
}

type World = ReturnType<typeof build>;
const tx = (w: World) => stub<Parameters<TrialNoticeService['recordNotice']>[0]>(w.prisma);
const sub = (extra: Record<string, unknown> = {}) =>
  stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['sub']>({
    status: 'trialing',
    trial_end: END.getTime() / 1000,
    default_payment_method: 'pm_1',
    items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd' } }] },
    ...extra,
  });
const purchaseArg = (p: Record<string, unknown>) =>
  stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(p);

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('B-672-1 (Sol) — channel leases start at the claim, not at the sweep', () => {
  it('push: after two slow rows, a replica cannot claim the third push while it is in flight', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(NOW);
    const w = build();
    for (const id of ['p-1', 'p-2', 'p-3']) {
      w.add(id);
      await w.enqueue(id);
    }
    const entered = deferred<void>();
    const held = deferred<{ delivered: boolean; code: string }>();
    let pushCalls = 0;
    let emailCalls = 0;
    w.notifications.pushToUser.mockImplementation(async () => {
      pushCalls += 1;
      if (pushCalls < 3) jest.setSystemTime(new Date(Date.now() + TICK));
      if (pushCalls === 3) {
        entered.resolve();
        return held.promise;
      }
      return { delivered: true, code: 'delivered' };
    });
    w.email.send.mockImplementation(async () => {
      emailCalls += 1;
      if (emailCalls < 3) jest.setSystemTime(new Date(Date.now() + TICK));
      return { status: 'sent' };
    });
    const sweep = w.service.sweep(NOW);
    await entered.promise;
    expect(Date.now() - NOW.getTime()).toBe(116_000);
    jest.setSystemTime(new Date(Date.now() + 5000));
    await w.makeService().deliver('notice-p-3');
    held.resolve({ delivered: true, code: 'delivered' });
    await sweep;
    expect(w.pushesFor('p-3')).toHaveLength(1);
    expect(w.notices.rows[2]).toMatchObject({ push_status: 'delivered', push_attempts: 1 });
  });

  it('email: after slow earlier rows, a replica cannot claim the third email while it is in flight', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(NOW);
    const w = build();
    for (const id of ['p-1', 'p-2', 'p-3']) {
      w.add(id);
      await w.enqueue(id);
    }
    const entered = deferred<void>();
    const held = deferred<{ status: string }>();
    let pushCalls = 0;
    let emailCalls = 0;
    w.notifications.pushToUser.mockImplementation(async () => {
      pushCalls += 1;
      if (pushCalls < 3) jest.setSystemTime(new Date(Date.now() + TICK));
      return { delivered: true, code: 'delivered' };
    });
    w.email.send.mockImplementation(async () => {
      emailCalls += 1;
      if (emailCalls < 3) jest.setSystemTime(new Date(Date.now() + TICK));
      if (emailCalls === 3) {
        entered.resolve();
        return held.promise;
      }
      return { status: 'sent' };
    });
    const sweep = w.service.sweep(NOW);
    await entered.promise;
    jest.setSystemTime(new Date(Date.now() + 5000));
    await w.makeService().deliver('notice-p-3');
    held.resolve({ status: 'sent' });
    await sweep;
    const third = w.email.send.mock.calls.filter((c) =>
      String(c[0].idempotencyKey).startsWith('trial-ending:p-3:'),
    );
    expect(third).toHaveLength(1);
    expect(w.notices.rows[2]).toMatchObject({ email_status: 'sent', email_attempts: 1 });
  });

  it('a claim whose preparation used up its lease sends nothing and gives the attempt back', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(NOW);
    const w = build();
    w.add('p-1');
    const id = await w.enqueue('p-1');
    // The preference read after the claim stalls for 100 s of a 120 s lease:
    // less than the 30 s transport bound is left, so the push is not sent.
    w.notifications.getPreferences.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(Date.now() + 100_000));
      return { muted: false };
    });
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'pending',
      push_attempts: 0,
      push_lease_token: null,
      push_lease_until: null,
    });
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', push_attempts: 1 });
  });
});

describe('B-672-2 (Sol) — inapplicable notices settle; the retry sweep is fair', () => {
  it('50 cancelled purchases ahead of a healthy notice: the healthy one is delivered, the 50 are skipped', async () => {
    const w = build();
    for (let i = 0; i < 51; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      w.add(id, i < 50 ? { status: 'canceled', entitlement_active: false } : {});
      await w.enqueue(id, { created_at: new Date(NOW.getTime() - 600_000 + i * 1000) });
    }
    await w.service.sweep(NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.notices.rows[50]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
    for (const row of w.notices.rows.slice(0, 50)) {
      expect(row).toMatchObject({
        push_status: 'skipped',
        email_status: 'skipped',
        last_error: 'skip:purchase_canceled',
      });
    }
    // Settled rows never come back: a later sweep sends nothing new.
    await w.service.sweep(new Date(NOW.getTime() + 600_000));
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
  });

  it('a notice whose purchase is gone is skipped', async () => {
    const w = build();
    const id = await w.enqueue('p-gone');
    await w.service.deliver(id, NOW);
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'skipped',
      email_status: 'skipped',
      last_error: 'skip:purchase_missing',
    });
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('more than a page of unknown-card notices cannot hide a later healthy one, and they stay retryable', async () => {
    const w = build();
    for (let i = 0; i < 120; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      w.add(id, { client_user_id: 'client-unknown', card_on_file: false });
      await w.enqueue(id, {
        client_user_id: 'client-unknown',
        created_at: new Date(NOW.getTime() - 600_000 + i),
      });
    }
    w.add('p-late');
    await w.enqueue('p-late', { created_at: new Date(NOW.getTime() - 300_000) });
    w.customer.findUnique.mockImplementation(async ({ where }) => {
      if (where.client_user_id === 'client-unknown') throw new Error('connection reset');
      return { default_payment_method_id: 'pm_1' };
    });
    await w.service.sweep(NOW);
    expect(w.pushesFor('p-late')).toHaveLength(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    const unknown = w.notices.rows.filter((r) => r.client_user_id === 'client-unknown');
    expect(unknown).toHaveLength(120);
    for (const row of unknown) {
      expect(row).toMatchObject({
        push_status: 'pending',
        push_attempts: 0,
        email_status: 'pending',
        email_attempts: 0,
      });
    }
  });

  it('more than a page of live-leased notices cannot hide a later healthy one', async () => {
    const w = build();
    const leaseUntil = new Date(NOW.getTime() + 60_000);
    for (let i = 0; i < 120; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      w.add(id);
      await w.enqueue(id, {
        created_at: new Date(NOW.getTime() - 600_000 + i),
        push_attempts: 1,
        push_lease_token: `held-${i}`,
        push_lease_until: leaseUntil,
        email_attempts: 1,
        email_lease_token: `held-e-${i}`,
        email_lease_until: leaseUntil,
      });
    }
    w.add('p-late');
    await w.enqueue('p-late', { created_at: new Date(NOW.getTime() - 300_000) });
    await w.service.sweep(NOW);
    expect(w.pushesFor('p-late')).toHaveLength(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });
});

describe('B-672-1 (Opus) — the trial-end date follows the recipient time-zone rule', () => {
  // 2026-10-13T01:30Z is 9:30 pm on Oct 12 in New York.
  const LATE_EVENING_ET = new Date('2026-10-13T01:30:00Z');

  async function recordAndDeliver(w: World, end: Date) {
    const p = w.add('p-1', { trial_ends_at: end });
    const id = await w.service.recordTrialWillEnd(tx(w), {
      purchase: purchaseArg(p),
      sub: sub({ trial_end: end.getTime() / 1000 }),
      eventId: 'evt-1',
      now: NOW,
    });
    expect(id).toEqual(expect.any(String));
    await w.service.deliver(id as string, NOW);
    return {
      inapp: String(w.notifications.createNotification.mock.calls[0][0].body),
      push: String(w.notifications.pushToUser.mock.calls[0][2]),
      email: w.email.send.mock.calls[0][0].data as Record<string, unknown>,
    };
  }

  it("no preference row: the coach's zone names the date (Oct 12, not Oct 13) on every channel", async () => {
    const w = build({ prefs: null, coachZone: 'America/New_York' });
    const out = await recordAndDeliver(w, LATE_EVENING_ET);
    expect(out.inapp).toContain('ends on Oct 12.');
    expect(out.push).toContain('ends on Oct 12.');
    expect(out.email.trial_end_date).toBe('Oct 12');
  });

  it("an unstamped default row is not the client's zone: the coach's zone wins (Oct 11 in Hawaii)", async () => {
    const w = build({
      prefs: { timezone: 'America/Los_Angeles', timezone_updated_at: null },
      coachZone: 'Pacific/Honolulu',
    });
    const out = await recordAndDeliver(w, new Date('2026-10-12T08:00:00Z'));
    expect(out.inapp).toContain('ends on Oct 11.');
    expect(out.push).toContain('ends on Oct 11.');
    expect(out.email.trial_end_date).toBe('Oct 11');
  });

  it("a stamped preference is the client's own zone", async () => {
    const w = build({
      prefs: { timezone: 'Asia/Tokyo', timezone_updated_at: new Date('2026-10-01T00:00:00Z') },
      coachZone: 'America/New_York',
    });
    const out = await recordAndDeliver(w, LATE_EVENING_ET);
    expect(out.inapp).toContain('ends on Oct 13.');
    expect(out.email.trial_end_date).toBe('Oct 13');
  });

  it('no usable zone at all: never a date later than the true local end (earliest calendar date)', async () => {
    const w = build({ prefs: null, coachZone: null });
    const out = await recordAndDeliver(w, LATE_EVENING_ET);
    // UTC would say Oct 13, a day late for every client in the Americas.
    expect(out.inapp).toContain('ends on Oct 12.');
    expect(out.push).toContain('ends on Oct 12.');
    expect(out.email.trial_end_date).toBe('Oct 12');
  });
});

describe('C-672-5 — "plus any tax" when Stripe may add tax at the trial end', () => {
  it('automatic tax on the subscription: in-app, push and email name the tax', async () => {
    const w = build({ prefs: null, coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await w.service.recordTrialWillEnd(tx(w), {
      purchase: purchaseArg(p),
      sub: sub({ automatic_tax: { enabled: true } }),
      eventId: 'evt-1',
      now: NOW,
    });
    expect(w.notices.rows[0]).toMatchObject({ tax_may_apply: true });
    await w.service.deliver(id as string, NOW);
    const line = 'Your card will be charged $49 plus any tax then.';
    expect(String(w.notifications.createNotification.mock.calls[0][0].body)).toContain(line);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain(line);
    expect(w.email.send.mock.calls[0][0].data).toMatchObject({
      amount_display: '$49 plus any tax',
    });
  });

  it('control: no automatic tax keeps the exact charge line', async () => {
    const w = build({ prefs: null, coachZone: 'America/New_York' });
    const p = w.add('p-1');
    const id = await w.service.recordTrialWillEnd(tx(w), {
      purchase: purchaseArg(p),
      sub: sub(),
      eventId: 'evt-1',
      now: NOW,
    });
    await w.service.deliver(id as string, NOW);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toBe(
      'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
    );
    expect(w.email.send.mock.calls[0][0].data).toMatchObject({ amount_display: '$49' });
  });
});
