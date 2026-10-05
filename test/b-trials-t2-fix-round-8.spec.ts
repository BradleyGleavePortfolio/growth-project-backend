// B-TR2-117 (trials T2 fix round 8, agent 117) — regressions for #672 @ 6ce54002 on the real
// TrialNoticeService (and the real EmailService over an intercepted fetch; nothing leaves):
//   B-672-3 (Sol) / C-672-8 (Opus) only the current started, unended trial gets its notice;
//   B-672-4 (Sol) / C-672-9 (Opus) a send is aborted at the timeout and no retry overlaps it;
//   C-672-7 (Opus, operator ruling) a zone that is not the client's own names time and zone.
import { EmailService } from '../src/email/email.service';
import { EmailTemplateKey } from '../src/email/email.types';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');
type C = ConstructorParameters<typeof TrialNoticeService>;
type E = ConstructorParameters<typeof EmailService>;
type Will = Parameters<TrialNoticeService['recordTrialWillEnd']>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const RELATIONS = {
  package: { name: 'Monthly', interval: 'month', interval_count: 1 },
  coach: { name: 'Coach' },
  client: { name: 'Client', email: 'client@example.test' },
};
const PURCHASE = { client_user_id: 'client-a', coach_user_id: 'coach-a', package_id: 'pkg-a' };
const TRIAL = { status: 'trialing', entitlement_active: true, card_on_file: true };
const MONEY = { amount_cents: 4900, currency: 'usd', trial_ends_at: END };
const LA = { timezone: 'America/Los_Angeles', timezone_updated_at: NOW };

function build(zone: 'client' | 'coach' | 'none' = 'client') {
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
  const coachZone = async (a: { where: { user_id: string } }) =>
    a.where.user_id === 'coach-a' && zone !== 'none' ? { timezone: 'America/New_York' } : null;
  const prisma = {
    packageTrialNotice: notices,
    clientPurchase: { findMany: purchases.findMany, findUnique: jest.fn(find) },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: null })) },
    notificationPreferences: { findUnique: jest.fn(async () => (zone === 'client' ? LA : null)) },
    coachProfile: { findUnique: jest.fn(coachZone) },
    user: { findUnique: jest.fn(async () => ({ coach_id: 'coach-a' })) },
    coachingSession: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const make = (mailer: unknown = email) =>
    new TrialNoticeService(stub<C[0]>(prisma), stub<C[1]>(notifications), stub<C[2]>(mailer));
  const add = (id: string, extra: Record<string, unknown> = {}) => {
    const row = { id, ...PURCHASE, ...TRIAL, ...MONEY, cancel_at_period_end: false, ...extra };
    purchases.rows.push(row);
    return row;
  };
  const enqueue = async (purchaseId: string, extra: Record<string, unknown> = {}) => {
    const id = (extra.id as string | undefined) ?? `notice-${purchaseId}`;
    const created_at = new Date(NOW.getTime() - 600_000);
    const base = { purchase_id: purchaseId, client_user_id: 'client-a', ...MONEY, created_at };
    await notices.createMany({ data: [{ ...base, ...extra, id }] });
    return id;
  };
  const row = (id: string) => notices.rows.find((r) => r.id === id) as Record<string, unknown>;
  return {
    purchases,
    notices,
    notifications,
    email,
    prisma,
    service: make(),
    make,
    add,
    enqueue,
    row,
  };
}

const pushText = (w: ReturnType<typeof build>, i = 0) =>
  String(w.notifications.pushToUser.mock.calls[i][2]);
const retired = (code: string) => ({
  ...{ push_status: 'skipped', email_status: 'skipped', push_attempts: 0, email_attempts: 0 },
  last_error: `skip:${code}`,
});
const fakeTime = () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(NOW);
};

/** Real EmailService (Resend transport) over an intercepted fetch; the first request hangs. */
function realEmail(opts: { honorAbort: boolean }) {
  let seq = 0;
  const log = {
    create: jest.fn(async () => ({ id: `log-${++seq}` })),
    update: jest.fn(async () => ({})),
  };
  const env: Record<string, string> = { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'synthetic' };
  env.EMAIL_FROM_ADDRESS = 'test@example.test';
  const svc = new EmailService(
    stub<E[0]>({ emailSendLog: log }),
    stub<E[1]>({ get: (k: string) => env[k] }),
  );
  const calls: Array<{ signal?: AbortSignal | null; key?: string }> = [];
  const entered = deferred();
  const held = deferred();
  let inFlight = 0;
  let peak = 0;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ signal: init?.signal, key: headers['Idempotency-Key'] });
    peak = Math.max(peak, (inFlight += 1));
    try {
      if (calls.length === 1) {
        entered.resolve();
        await new Promise<void>((resolve, reject) => {
          void held.promise.then(resolve);
          if (opts.honorAbort)
            init?.signal?.addEventListener('abort', () => reject(new Error('abort')));
        });
      }
      return new Response(JSON.stringify({ id: `msg-${calls.length}` }), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  });
  return { log, svc, calls, entered, release: () => held.resolve(), peak: () => peak };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('B-672-3 / C-672-8 — only the current started, unended trial gets its notice', () => {
  it('the trial end moved: the old notice is retired unsent; the new end is delivered', async () => {
    const w = build();
    const later = new Date('2026-10-14T17:00:00Z');
    w.add('p', { trial_ends_at: later });
    const old = await w.enqueue('p');
    const current = await w.enqueue('p', { id: 'notice-new', trial_ends_at: later });
    await w.service.deliver(old, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.row(old)).toMatchObject(retired('trial_superseded'));
    await w.service.deliver(current, NOW);
    expect(pushText(w)).toContain('ends on Oct 14.');
    expect(w.email.send.mock.calls[0][0].data).toMatchObject({ trial_end_date: 'Oct 14' });
  });

  it('paid early, never started, cancelled: nothing sent (controls: cancel-at-end, no card)', async () => {
    const w = build();
    w.add('p-paid', { status: 'active' });
    w.add('p-nostart', { entitlement_active: false });
    w.add('p-cancel', { status: 'canceled', entitlement_active: false });
    w.add('p-cxl', { cancel_at_period_end: true });
    w.add('p-nocard', { card_on_file: false });
    for (const p of ['p-paid', 'p-nostart', 'p-cancel', 'p-cxl', 'p-nocard']) {
      await w.service.deliver(await w.enqueue(p), NOW);
    }
    expect(w.row('notice-p-paid')).toMatchObject(retired('trial_ended'));
    expect(w.row('notice-p-nostart')).toMatchObject(retired('trial_not_started'));
    expect(w.row('notice-p-cancel')).toMatchObject(retired('purchase_canceled'));
    expect(pushText(w, 0)).toContain('Your card will not be charged');
    expect(pushText(w, 1)).toContain('No card is saved, so nothing will be charged');
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(2);
    expect(w.email.send).toHaveBeenCalledTimes(2);
  });

  it('a bounded push that runs past the trial end: the email is not sent after the trial is over', async () => {
    fakeTime();
    const w = build();
    const end = new Date(NOW.getTime() + 20_000);
    w.add('p', { trial_ends_at: end });
    const id = await w.enqueue('p', { trial_ends_at: end });
    w.notifications.pushToUser.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(NOW.getTime() + 29_000));
      return { delivered: true, code: 'delivered' };
    });
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject({ email_status: 'skipped', email_attempts: 0 });
  });

  it('retired rows spend no attempt and never come back to the retry sweep', async () => {
    const w = build();
    for (let i = 0; i < 60; i += 1) {
      const p = `p-${String(i).padStart(3, '0')}`;
      w.add(p, { trial_ends_at: new Date('2026-10-14T17:00:00Z') });
      await w.enqueue(p, { created_at: new Date(NOW.getTime() - 600_000 + i) });
    }
    w.add('p-ok');
    await w.enqueue('p-ok', { created_at: new Date(NOW.getTime() - 300_000) });
    await w.service.sweep(NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.notices.rows.slice(0, 60)).toEqual(
      Array(60).fill(expect.objectContaining(retired('trial_superseded'))),
    );
    const reads = w.prisma.clientPurchase.findUnique.mock.calls.length;
    await w.service.sweep(new Date(NOW.getTime() + 600_000));
    expect(w.prisma.clientPurchase.findUnique.mock.calls.length).toBe(reads);
  });

  it('out of order: a notice retired against a stale purchase row is reopened once the row catches up, and sent once', async () => {
    const w = build();
    const moved = new Date('2026-10-11T17:00:00Z');
    w.add('p', { trial_ends_at: END }); // the subscription.updated for the new end is still in flight
    const id = await w.enqueue('p', { trial_ends_at: moved });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject(retired('trial_superseded'));
    w.purchases.rows[0].trial_ends_at = moved;
    expect(await w.service.reconcileDue(NOW)).toBe(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(pushText(w)).toContain('ends on Oct 11.');
    expect(w.row(id)).toMatchObject({ email_status: 'sent', last_error: null });
    expect(await w.service.reconcileDue(NOW)).toBe(0);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });
});

describe('B-672-4 / C-672-9 — a send is really bounded, and a retry never overlaps it', () => {
  it('stalled provider: aborted at the timeout, the lease freed only after the fetch stopped, one provider key', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { push_status: 'delivered' });
    const mail = realEmail({ honorAbort: true });
    const svc = w.make(mail.svc);
    const first = svc.deliver(id);
    await mail.entered.promise;
    await jest.advanceTimersByTimeAsync(30_001);
    await first;
    expect(mail.calls[0].signal?.aborted).toBe(true);
    expect(w.row(id)).toMatchObject({ email_attempts: 1, email_lease_token: null });
    await svc.deliver(id);
    expect(w.row(id)).toMatchObject({ email_status: 'sent', email_attempts: 2 });
    expect(mail.calls).toHaveLength(2);
    expect(mail.peak()).toBe(1);
    expect(mail.calls[0].key).toMatch(/^trial-ending:p:\d+:[0-9a-f]{32}$/);
    expect(mail.calls[1].key).toBe(mail.calls[0].key);
  });

  it('a request that ignores its abort keeps the lease until it ends: no second send here or on a replica', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { push_status: 'delivered' });
    const mail = realEmail({ honorAbort: false });
    const svc = w.make(mail.svc);
    const first = svc.deliver(id);
    await mail.entered.promise;
    await jest.advanceTimersByTimeAsync(35_001);
    await first;
    expect(w.row(id).email_lease_token).toEqual(expect.any(String));
    await svc.deliver(id);
    await w.make(mail.svc).deliver(id);
    await jest.advanceTimersByTimeAsync(200_000); // past the first lease: renewed while it runs
    await w.make(mail.svc).deliver(id);
    expect(mail.calls).toHaveLength(1);
    mail.release();
    await flush();
    expect(w.row(id)).toMatchObject({ email_lease_token: null });
    await svc.deliver(id);
    expect(mail.calls).toHaveLength(2);
    expect(mail.peak()).toBe(1);
  });

  it('a hung push that ignores its abort keeps the push lease until it ends', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { email_status: 'sent' });
    const gate = deferred<{ delivered: boolean; code: string }>();
    w.notifications.pushToUser.mockImplementationOnce(() => gate.promise);
    const first = w.service.deliver(id);
    await flush();
    await jest.advanceTimersByTimeAsync(35_001);
    await first;
    expect(w.row(id)).toMatchObject({ push_status: 'pending', last_error: 'push:timeout' });
    expect(w.row(id).push_lease_token).toEqual(expect.any(String));
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    gate.resolve({ delivered: true, code: 'delivered' });
    await flush();
    expect(w.row(id)).toMatchObject({ push_lease_token: null, push_lease_until: null });
  });

  it('preparation that leaves less than the transport bound plus the abort grace sends nothing', async () => {
    fakeTime();
    const w = build();
    w.add('p');
    const id = await w.enqueue('p', { email_status: 'sent' });
    w.notifications.getPreferences.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(Date.now() + 86_000)); // 34 s of the 120 s lease left
      return { muted: false };
    });
    await w.service.deliver(id);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.row(id)).toMatchObject({ push_attempts: 0, push_lease_token: null });
  });

  it('EmailService: an aborted caller burns no key and makes no request; the provider key follows the content', async () => {
    const mail = realEmail({ honorAbort: true });
    mail.release();
    const send = (signal?: AbortSignal, name = 'Ana') =>
      mail.svc.send({
        to: 'client@example.test',
        template: EmailTemplateKey.TRIAL_ENDING,
        idempotencyKey: `k-${name}-${mail.calls.length}`,
        providerIdempotencyKey: 'trial-ending:p:1',
        signal,
        data: { recipient_name: name, trial_end_date: 'Oct 12', will_charge: true },
      });
    const controller = new AbortController();
    controller.abort();
    expect(await send(controller.signal)).toMatchObject({ status: 'failed', error: 'aborted' });
    expect(mail.log.create).not.toHaveBeenCalled();
    expect(mail.calls).toHaveLength(0);
    await send();
    await send();
    await send(undefined, 'Bo');
    expect(mail.calls[1].key).toBe(mail.calls[0].key);
    expect(mail.calls[2].key).not.toBe(mail.calls[0].key);
  });
});

describe("C-672-7 — a zone that is not the client's own names the time and the zone", () => {
  // 2026-10-13T04:30Z = 9:30 pm Oct 12 in Los Angeles, 12:30 am Oct 13 in New York.
  const end = new Date('2026-10-13T04:30:00Z');
  it.each([
    ['client', 'Oct 12'],
    ['coach', 'Oct 13 at 12:30 AM EDT'],
    ['none', 'Oct 13 at 4:30 AM UTC'],
  ] as const)('zone known from %s: "%s" on every channel', async (zone, label) => {
    const w = build(zone);
    const p = w.add('p', { trial_ends_at: end });
    const sub = {
      status: 'trialing',
      trial_end: end.getTime() / 1000,
      default_payment_method: 'pm',
    };
    const args = { purchase: stub<Will[1]['purchase']>(p), sub, eventId: 'evt-1', now: NOW };
    const id = await w.service.recordTrialWillEnd(stub<Will[0]>(w.prisma), args);
    await w.service.deliver(id as string, NOW);
    const line = `Your free trial ends on ${label}. Your card will be charged $49 then.`;
    expect(String(w.notifications.createNotification.mock.calls[0][0].body)).toContain(line);
    expect(pushText(w)).toContain(line);
    expect(w.email.send.mock.calls[0][0].data).toMatchObject({ trial_end_date: label });
  });
});
