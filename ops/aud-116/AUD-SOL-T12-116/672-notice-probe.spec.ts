import { Logger } from '@nestjs/common';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { willChargeCard } from '../src/packages/trials/trial-copy';
import { trialErrorClass, trialHttpCode, trialPushCode } from '../src/packages/trials/trial-diagnostics';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');
const TICK = 29_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function build() {
  const purchases = makeTable([['id']], () => ({}));
  const notices = makeTrialNoticeTable();
  const customer = {
    findUnique: jest.fn(async (): Promise<{ default_payment_method_id: string | null } | null> =>
      ({ default_payment_method_id: null })),
  };
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({ id: 'inapp', ...input })),
    getPreferences: jest.fn(async () => ({ muted: false })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = {
    send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })),
  };
  const prisma = {
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = purchases.rows.find((row) => row.id === where.id);
        return p ? {
          ...p,
          package: { name: 'Monthly', interval: 'month', interval_count: 1 },
          coach: { name: 'Coach' },
          client: { name: 'Client', email: 'client@example.test' },
        } : null;
      }),
    },
    connectCustomer: customer,
    notificationPreferences: { findUnique: jest.fn(async () => ({ timezone: 'UTC' })) },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const service = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
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
      data: [{
        id: `notice-${purchaseId}`,
        purchase_id: purchaseId,
        client_user_id: 'client-a',
        trial_ends_at: END,
        amount_cents: 4900,
        currency: 'usd',
        created_at: new Date(NOW.getTime() - 600_000),
        ...extra,
      }],
      skipDuplicates: true,
    });
    return `notice-${purchaseId}`;
  };
  return { purchases, notices, customer, notifications, email, prisma, service, add, enqueue };
}

type World = ReturnType<typeof build>;
const tx = (w: World) => stub<Parameters<TrialNoticeService['recordNotice']>[0]>(w.prisma);

describe('AUD-SOL-T12-116 — prior boundary controls at exact T2 head', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('B-656-3: 100 noticed rows do not starve 20 missing rows; ties are deterministic', async () => {
    const w = build();
    for (let i = 119; i >= 0; i -= 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      w.add(id);
      if (i < 100) await w.enqueue(id, { push_status: 'delivered', email_status: 'sent' });
    }
    expect(await w.service.reconcileDue(NOW)).toBe(20);
    expect(w.notices.rows).toHaveLength(120);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(20);
    expect(await w.service.reconcileDue(NOW)).toBe(0);
  });

  it('B-656-3: concurrent reconciliations insert each missing notice once', async () => {
    const w = build();
    for (let i = 0; i < 8; i += 1) w.add(`p-${i}`);
    const results = await Promise.all([w.service.reconcileDue(NOW), w.service.reconcileDue(NOW)]);
    expect(results[0] + results[1]).toBe(8);
    expect(w.notices.rows).toHaveLength(8);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(8);
  });

  it('B-656-5: a failed default-card lookup sends nothing or spends attempts; recovery charges truthfully', async () => {
    const w = build();
    w.add('p', { card_on_file: false });
    const id = await w.enqueue('p');
    w.customer.findUnique.mockRejectedValueOnce(new Error('synthetic failure'));
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_attempts: 0, email_attempts: 0 });
    w.customer.findUnique.mockResolvedValue({ default_payment_method_id: 'pm-a' });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toMatch(/will be charged \$49/);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
  });

  it('B-656-5: unknown while recording is retained through reconciliation, not false no-card copy', async () => {
    const w = build();
    const p = w.add('p', { card_on_file: false });
    w.customer.findUnique.mockRejectedValueOnce(new Error('synthetic failure'));
    const id = await w.service.recordTrialWillEnd(tx(w), {
      purchase: stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(p),
      sub: { status: 'trialing', trial_end: END.getTime() / 1000, default_payment_method: null },
      eventId: 'event-a',
      now: NOW,
    });
    expect(id).toBeNull();
    expect(w.notices.rows).toHaveLength(0);
    w.customer.findUnique.mockResolvedValue({ default_payment_method_id: 'pm-a' });
    expect(await w.service.reconcileDue(NOW)).toBe(1);
    expect(w.notifications.createNotification.mock.calls[0][0].body).toMatch(/will be charged \$49/);
  });

  it('B-656-5: confirmed absent, present and unknown are distinct', () => {
    expect(willChargeCard(false, false)).toBe(false);
    expect(willChargeCard(false, true)).toBe(true);
    expect(willChargeCard(false, null)).toBeNull();
  });

  it('B-656-2/4: current mute suppresses push, not billing email', async () => {
    const w = build();
    w.add('p');
    const id = await w.enqueue('p');
    w.notifications.getPreferences.mockResolvedValue({ muted: true });
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'suppressed', email_status: 'sent' });
  });

  it('B-656-2: staggered entrants under a fresh lease make one push', async () => {
    const w = build();
    w.add('p');
    const id = await w.enqueue('p');
    const entered = deferred<void>();
    const held = deferred<{ delivered: boolean; code: string }>();
    w.notifications.pushToUser.mockImplementationOnce(async () => {
      entered.resolve();
      return held.promise;
    });
    const first = w.service.deliver(id, NOW);
    await entered.promise;
    await w.service.deliver(id, NOW);
    held.resolve({ delivered: true, code: 'delivered' });
    await first;
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('B-656-7: helper canaries and actual notice catch never emit arbitrary names', async () => {
    const canary = 'AUDIT_TEXT_NAME_client_at_example_invalid';
    const err = Object.assign(new Error('synthetic'), { name: canary });
    expect(trialErrorClass(err)).toBe('unclassified');
    expect(trialPushCode(canary)).toBe('unclassified');
    expect(trialHttpCode(canary)).toBe('http_unknown');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const w = build();
    w.add('p', { card_on_file: false });
    const id = await w.enqueue('p');
    w.customer.findUnique.mockRejectedValue(err);
    await w.service.deliver(id, NOW);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(canary);
    expect(warn.mock.calls.flat().join(' ')).toContain('unclassified');
  });
});

describe('AUD-SOL-T12-116 — new notice-worker counterexamples', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('pending notices for 50 canceled purchases cannot permanently hide a healthy later notice', async () => {
    const w = build();
    for (let i = 0; i < 51; i += 1) {
      const id = `p-${String(i).padStart(4, '0')}`;
      w.add(id, i < 50 ? { status: 'canceled', entitlement_active: false } : {});
      await w.enqueue(id, { created_at: new Date(NOW.getTime() - 600_000 + i * 1000) });
    }
    await w.service.sweep(NOW);
    await w.service.sweep(new Date(NOW.getTime() + 600_000));
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.notices.rows[50]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
  });

  it('after slow earlier rows, a fresh channel claim must not expire before its provider finishes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
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
      // Earlier completed transports take 29 seconds each, under the
      // 30-second bound. Only clock progress is modeled, without waiting.
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
    // Five seconds into the third push, well before its 30-second deadline,
    // the two-minute lease based on the sweep's old timestamp has expired.
    jest.setSystemTime(new Date(Date.now() + 5000));
    expect(Date.now() - NOW.getTime()).toBe(121_000);
    const replica = new TrialNoticeService(
      stub<ConstructorParameters<typeof TrialNoticeService>[0]>(w.prisma),
      stub<ConstructorParameters<typeof TrialNoticeService>[1]>(w.notifications),
      stub<ConstructorParameters<typeof TrialNoticeService>[2]>(w.email),
    );
    await replica.deliver('notice-p-3');
    held.resolve({ delivered: true, code: 'delivered' });
    await sweep;
    const forThird = w.notifications.pushToUser.mock.calls.filter((args) =>
      (args[3] as { purchase_id?: string } | undefined)?.purchase_id === 'p-3');
    expect(forThird).toHaveLength(1);
  });
});
