// AUD-OPUS-T23-118 (Claude Opus 5.5 lens, agent 118) — probes on backend
// #672 @ c5e7ed8e35f1e5b88653e5605dded2af8614182d. Audit-only: never merge.
// "probe" = asserts the safe behaviour, EXPECTED RED at this head;
// "control" = expected green (closure evidence for the round-8 fixes).
//   C-672-10  a hung push that ignores its abort and then really delivers:
//             the late result is dropped (row stays pending), so the next
//             delivery sends the same push a second time;
//   C-672-11  a stale trial_will_end (payload still trialing) for a purchase
//             whose trial already converted writes an in-app row that says
//             the card "will be charged ... then";
//   controls  C-672-7 ruling label on every channel; B-672-3 retire on
//             extension / conversion; B-672-4 email abort reaches fetch.
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

describe('C-672-10 probe — a hung push that really delivered is not sent again', () => {
  it('probe (expected red): after the late delivery, the next delivery sends no second push', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { email_status: 'sent' });
    let release!: (v: { delivered: boolean; code: string }) => void;
    const gate = new Promise<{ delivered: boolean; code: string }>((r) => (release = r));
    w.notifications.pushToUser.mockImplementationOnce(() => gate);
    const first = w.service.deliver(id);
    await flush();
    await jest.advanceTimersByTimeAsync(35_001);
    await first;
    // Expo accepted the message after all (the SDK call takes no signal).
    release({ delivered: true, code: 'delivered' });
    await flush();
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });
});

describe('C-672-11 probe — the in-app row is written for a trial that already converted', () => {
  it('probe (expected red): a stale trial_will_end for an active (paid) purchase writes no "will be charged" row', async () => {
    const w = build();
    const p = w.add('p', { status: 'active' });
    const id = await w.service.recordTrialWillEnd(stub<Will[0]>(w.prisma), {
      purchase: stub<Will[1]['purchase']>(p),
      sub: subOf(END),
      eventId: 'evt-stale',
      now: NOW,
    });
    expect(w.notifications.createNotification).not.toHaveBeenCalled();
    expect(id).toBeNull();
  });
});

describe('controls — round-8 closures', () => {
  it('control C-672-7: coach zone only -> "Oct 13 at 12:30 AM EDT" on in-app, push and email', async () => {
    const w = build('coach');
    const end = new Date('2026-10-13T04:30:00Z');
    const p = w.add('p', { trial_ends_at: end });
    const id = await w.service.recordTrialWillEnd(stub<Will[0]>(w.prisma), {
      purchase: stub<Will[1]['purchase']>(p),
      sub: subOf(end),
      eventId: 'evt-1',
      now: NOW,
    });
    await w.service.deliver(id as string, NOW);
    const line = 'Your free trial ends on Oct 13 at 12:30 AM EDT. Your card will be charged $49 then.';
    expect(String(w.notifications.createNotification.mock.calls[0][0].body)).toContain(line);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain(line);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ trial_end_date: 'Oct 13 at 12:30 AM EDT' }),
    });
  });

  it('control C-672-7: the client own (stamped) zone keeps the bare date "Oct 12"', async () => {
    const w = build('client');
    const end = new Date('2026-10-13T04:30:00Z');
    const p = w.add('p', { trial_ends_at: end });
    const id = await w.service.recordTrialWillEnd(stub<Will[0]>(w.prisma), {
      purchase: stub<Will[1]['purchase']>(p),
      sub: subOf(end),
      eventId: 'evt-1',
      now: NOW,
    });
    await w.service.deliver(id as string, NOW);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain('ends on Oct 12. ');
  });

  it('control B-672-3: extension and conversion retire the old notice; the sweep never retries it', async () => {
    const w = build();
    w.add('p-ext', { trial_ends_at: new Date('2026-10-19T17:00:00Z') });
    w.add('p-paid', { status: 'active' });
    const a = await w.enqueue('p-ext');
    const b = await w.enqueue('p-paid');
    await w.service.deliver(a, NOW);
    await w.service.deliver(b, NOW);
    await w.service.sweep(new Date(NOW.getTime() + 600_000));
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.row(a)).toMatchObject({ push_status: 'skipped', email_status: 'skipped', last_error: 'skip:trial_superseded' });
    expect(w.row(b)).toMatchObject({ push_status: 'skipped', email_status: 'skipped', last_error: 'skip:trial_ended' });
  });

  it('control B-672-4: the abort reaches the Resend fetch and the retry reuses the provider key', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { push_status: 'delivered' });
    let seq = 0;
    const log = { create: jest.fn(async () => ({ id: `log-${++seq}` })), update: jest.fn(async () => ({})) };
    const env: Record<string, string> = {
      EMAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'synthetic',
      EMAIL_FROM_ADDRESS: 'test@example.test',
    };
    const svc = new EmailService(stub<E[0]>({ emailSendLog: log }), stub<E[1]>({ get: (k: string) => env[k] }));
    const calls: Array<{ aborted: () => boolean; key?: string }> = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const signal = init?.signal ?? undefined;
      calls.push({ aborted: () => !!signal?.aborted, key: headers['Idempotency-Key'] });
      if (calls.length === 1) {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('abort'))));
      }
      return new Response(JSON.stringify({ id: `msg-${calls.length}` }), { status: 200 });
    });
    const notice = w.make(svc);
    const first = notice.deliver(id);
    await flush();
    await jest.advanceTimersByTimeAsync(30_001);
    await first;
    expect(calls[0].aborted()).toBe(true);
    expect(w.row(id)).toMatchObject({ email_status: 'pending', email_lease_token: null });
    await notice.deliver(id);
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);
    expect(w.row(id)).toMatchObject({ email_status: 'sent', email_attempts: 2 });
  });
});
