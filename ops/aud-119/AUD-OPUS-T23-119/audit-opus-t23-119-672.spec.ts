// AUD-OPUS-T23-119 (Claude Opus 5.5 lens, agent 119) — probes on backend
// #672 @ 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 (FIX ROUND 9, Sol B-672-3).
// Audit-only: never merge. All are controls (expected green) on the round-9
// admission lines: the copy is built at admission, after the claim.
//   R9-1  retire at the EMAIL admission after a delivered push: push stays
//         'delivered', email skipped, attempt given back, lease released;
//   R9-2  unknown card at the PUSH admission: nothing sent, channel pending,
//         attempt given back; the next delivery sends exactly once;
//   R9-3  a slow admission preparation exhausts the lease: no send, pending,
//         push:lease_exhausted, attempt given back;
//   R9-4  cancel at period end committed during the email claim (push muted):
//         the email never says the card will be charged;
//   R9-5  the zone read at admission is the one written into the push.
import { EmailService } from '../src/email/email.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');
type C = ConstructorParameters<typeof TrialNoticeService>;
type E = ConstructorParameters<typeof EmailService>;
type Will = Parameters<TrialNoticeService['recordTrialWillEnd']>;

const RELATIONS = {
  package: { name: 'Monthly', interval: 'month', interval_count: 1 },
  coach: { name: 'Coach' },
  client: { name: 'Client', email: 'client@example.test' },
};

function build(zone: 'client' | 'coach' = 'client') {
  const purchases = makeTable([['id']], () => ({}));
  const notices = makeTrialNoticeTable();
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({ id: 'n', ...input })),
    getPreferences: jest.fn(async (): Promise<Record<string, unknown>> => ({ muted: false })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = { send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })) };
  const find = async ({ where }: { where: { id: string } }) =>
    purchases.rows.filter((r) => r.id === where.id).map((r) => ({ ...r, ...RELATIONS }))[0] ?? null;
  const prisma = {
    packageTrialNotice: notices,
    clientPurchase: { findMany: purchases.findMany, findUnique: jest.fn(find) },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: null })) },
    notificationPreferences: {
      findUnique: jest.fn(async () =>
        zone === 'client' ? { timezone: 'America/Los_Angeles', timezone_updated_at: NOW } : null,
      ),
    },
    coachProfile: {
      findUnique: jest.fn(async (a: { where: { user_id: string } }) =>
        a.where.user_id === 'coach-a' ? { timezone: 'America/New_York' } : null,
      ),
    },
    user: { findUnique: jest.fn(async () => ({ coach_id: 'coach-a' })) },
    coachingSession: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const make = (mailer: unknown = email) =>
    new TrialNoticeService(stub<C[0]>(prisma), stub<C[1]>(notifications), stub<C[2]>(mailer));
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
    const id = `notice-${purchaseId}`;
    const created_at = new Date(NOW.getTime() - 600_000);
    const base = {
      purchase_id: purchaseId,
      client_user_id: 'client-a',
      amount_cents: 4900,
      currency: 'usd',
      trial_ends_at: END,
      created_at,
    };
    await notices.createMany({ data: [{ ...base, ...extra, id }] });
    return id;
  };
  const row = (id: string) => notices.rows.find((r) => r.id === id) as Record<string, unknown>;
  return { purchases, notices, notifications, email, prisma, service: make(), make, add, enqueue, row };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
};
const fakeTime = () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(NOW);
};
const subOf = (end: Date) => ({
  status: 'trialing',
  trial_end: end.getTime() / 1000,
  default_payment_method: 'pm_1',
  items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd' } }] },
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});


describe('R9 controls — copy built at admission (Sol B-672-3 closure)', () => {
  it('R9-1 control: retire at the email admission keeps the delivered push and gives the email attempt back', async () => {
    const w = build();
    const p = w.add('p');
    const id = await w.enqueue('p');
    const claim = w.notices.updateMany;
    w.notices.updateMany = async (args: Parameters<typeof claim>[0]) => {
      if (typeof (args.data as Record<string, unknown>).email_lease_token === 'string') p.status = 'active';
      return claim(args);
    };
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject({
      push_status: 'delivered',
      email_status: 'skipped',
      email_attempts: 0,
      email_lease_token: null,
      email_lease_until: null,
      last_error: 'skip:trial_ended',
    });
  });

  it('R9-2 control: an unknown card at the push admission sends nothing, keeps it pending, and the next delivery sends once', async () => {
    const w = build();
    w.add('p', { card_on_file: false });
    const id = await w.enqueue('p', { email_status: 'sent' });
    const card = w.prisma.connectCustomer.findUnique;
    // call 1 = pre-claim check; call 2 = the admission preparation (fails).
    card
      .mockImplementationOnce(async () => ({ default_payment_method_id: 'pm_1' }))
      .mockImplementationOnce(async () => {
        throw new Error('db down');
      });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject({ push_status: 'pending', push_attempts: 0, push_lease_token: null });
    card.mockImplementation(async () => ({ default_payment_method_id: 'pm_1' }));
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain('will be charged $49');
    expect(w.row(id)).toMatchObject({ push_status: 'delivered', push_attempts: 1 });
  });

  it('R9-3 control: a slow admission preparation exhausts the lease: no send, pending, attempt given back', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { email_status: 'sent' });
    let reads = 0;
    const find = w.prisma.clientPurchase.findUnique.getMockImplementation()!;
    w.prisma.clientPurchase.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
      reads += 1;
      // read 2 is the admission preparation: 90 s pass (room = 120 - 30 - 5 = 85 s).
      if (reads === 2) jest.setSystemTime(Date.now() + 90_000);
      return find(a);
    });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject({
      push_status: 'pending',
      push_attempts: 0,
      push_lease_token: null,
      last_error: 'push:lease_exhausted',
    });
  });

  it('R9-4 control: cancel at period end committed during the email claim (push muted) mails will_charge:false', async () => {
    const w = build();
    w.notifications.getPreferences.mockImplementation(async () => ({ muted: true }));
    const p = w.add('p');
    const id = await w.enqueue('p');
    const claim = w.notices.updateMany;
    w.notices.updateMany = async (args: Parameters<typeof claim>[0]) => {
      if (typeof (args.data as Record<string, unknown>).email_lease_token === 'string') p.cancel_at_period_end = true;
      return claim(args);
    };
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({ data: expect.objectContaining({ will_charge: false, no_card: false }) });
    expect(w.row(id)).toMatchObject({ push_status: 'suppressed', email_status: 'sent' });
  });

  it('R9-5 control: the zone read at admission is the one written into the push', async () => {
    const w = build('client');
    const end = new Date('2026-10-13T04:30:00Z');
    w.add('p', { trial_ends_at: end });
    const id = await w.enqueue('p', { trial_ends_at: end, email_status: 'sent' });
    const prefs = w.prisma.notificationPreferences.findUnique;
    let n = 0;
    prefs.mockImplementation(async () => {
      n += 1;
      // the client clears the stamped zone between the pre-claim check and the admission
      return n === 1 ? { timezone: 'America/Los_Angeles', timezone_updated_at: NOW } : null;
    });
    await w.service.deliver(id, NOW);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain('Oct 13 at 12:30 AM EDT');
  });
});
