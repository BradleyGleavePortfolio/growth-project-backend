// MONEY-DAILY (owner, agent 199): the money check runs every day over every
// purchase and tells the owner "clean" or "needs review".
//
// The real ReconciliationService and the real CronLeaseService run over
// in-memory tables; Stripe and the notifications sender are stand-ins. No live
// Stripe, no network, no database.
import { Logger } from '@nestjs/common';
import { CronLeaseService } from '../src/checkout/cron-lease.service';
import {
  BATCH,
  DAILY_CRON,
  DAILY_JOB_NAME,
  LEASE_TTL_MS,
  PACE_MS,
  RUN_BUDGET_MS,
  ReconciliationDailyCron,
  dailyAlertCopy,
  dailyVerdict,
  reconciliationDailyEnabled,
  type DailyTally,
} from '../src/checkout/reconciliation-daily.cron';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { Table, asPrisma, type Row } from './utils/settlement-fakes';
import { stub } from './utils/trial-fakes';

type Kind = 'ok' | 'drift' | 'unknown' | 'throws';
interface P {
  id: string;
  kind: Kind;
  status?: string;
  source?: string | null;
}

/** Purchases + their ledger + their snapshots, with the findMany filter runSweep relies on. */
function moneyWorld(list: P[]) {
  const purchases = list.map((p, i) => ({
    id: p.id,
    status: p.status ?? 'paid',
    source: p.source ?? null,
    amount_cents: 10_000,
    // `unknown`: no payment intent and no charge id on the ledger (no_charge_id_yet).
    stripe_payment_intent_id: p.kind === 'unknown' ? null : `pi_${p.id}`,
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    _kind: p.kind,
  }));
  const snapshots = new Map<string, { purchase_id: string; status: string; last_checked_at: Date }>();
  const findManyCalls: unknown[] = [];
  const byId = (id: string) => purchases.find((p) => p.id === id)!;
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async (args: any) => {
        findManyCalls.push(args);
        const w = args.where;
        const stale: Date = w.OR[1].reconciliation.last_checked_at.lt;
        return purchases
          .filter((p) => w.status.in.includes(p.status) && p.source === w.source)
          .filter((p) => {
            const s = snapshots.get(p.id);
            return !s || s.last_checked_at < stale;
          })
          .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
          .slice(0, args.take);
      }),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where }: any) => {
        const p = byId(where.purchase_id);
        // `drift`: the ledger is short by 500 cents.
        const dest = p._kind === 'drift' ? 9_300 : 9_800;
        return [
          { purchase_id: p.id, kind: 'destination', amount_cents: dest, reversed_cents: 0, status: 'posted' },
          { purchase_id: p.id, kind: 'application_fee', amount_cents: 200, reversed_cents: 0, status: 'posted' },
        ];
      }),
      findFirst: jest.fn(async () => null),
    },
    connectTransfer: {
      findMany: jest.fn(async ({ where }: any) => {
        if (byId(where.purchase_id)._kind === 'throws') throw new Error('db read failed');
        return [];
      }),
    },
    chargeSettlement: { findMany: jest.fn(async () => []) },
    payeeRecovery: { findMany: jest.fn(async () => []) },
    reconciliationSnapshot: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const prev = snapshots.get(where.purchase_id);
        const row = prev ? { ...prev, ...update } : { ...create };
        snapshots.set(where.purchase_id, row);
        return row;
      }),
    },
  };
  const stripe = {
    retrievePaymentIntent: jest.fn(async (id: string) => ({ id, latest_charge: `ch_${id}` })),
    retrieveCharge: jest.fn(async (id: string) => ({
      id,
      amount: 10_000,
      amount_refunded: 0,
      application_fee_amount: 200,
    })),
  };
  const svc = new ReconciliationService(prisma as any, stripe as any);
  return { svc, prisma, stripe, snapshots, findManyCalls };
}

const OWNER = { id: 'owner-1' };

function notifier() {
  return {
    createNotification: jest.fn(async (input: any) => ({ id: 'n-1', ...input })),
    pushToUser: jest.fn(async () => ({ sent: 1 }) as any),
  };
}

function userTable(owner: { id: string } | null = OWNER) {
  return {
    user: {
      findFirst: jest.fn(async () => owner),
    },
  };
}

function leaseFor(rows: Row[] = []) {
  const cronLease = new Table(rows, { prefix: 'lease', unique: ['name'] });
  return { lease: new CronLeaseService(asPrisma({ cronLease })), rows };
}

function cronFor(
  list: P[],
  opts: { owner?: { id: string } | null; lease?: CronLeaseService } = {},
) {
  const world = moneyWorld(list);
  const notes = notifier();
  const users = userTable(opts.owner === undefined ? OWNER : opts.owner);
  const lease = opts.lease ?? leaseFor().lease;
  const cron = new ReconciliationDailyCron(lease, world.svc, notes as any, users as any);
  return { cron, world, notes, users, lease };
}

const many = (n: number, kind: Kind, prefix = kind) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, '0')}`, kind }));

const noPause = jest.fn(async () => undefined);
const NOW = () => new Date(Date.now() - 1_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  noPause.mockClear();
  delete process.env.RECONCILIATION_DAILY_ENABLED;
});

describe('ReconciliationService.runSweep (MONEY-DAILY additions)', () => {
  it('reads staleBefore when given and the 24h window when not', async () => {
    const { svc, findManyCalls } = moneyWorld(many(2, 'ok'));
    const at = new Date('2026-11-06T11:00:00Z');
    await svc.runSweep(50, { staleBefore: at });
    const before = Date.now();
    await svc.runSweep(50);
    const w0 = (findManyCalls[0] as any).where.OR[1].reconciliation.last_checked_at.lt as Date;
    const w1 = (findManyCalls[1] as any).where.OR[1].reconciliation.last_checked_at.lt as Date;
    expect(w0).toEqual(at);
    expect(Math.abs(before - 24 * 60 * 60 * 1000 - w1.getTime())).toBeLessThan(5_000);
  });

  it('returns one outcome per purchase and counts a check that throws as failed', async () => {
    const { svc } = moneyWorld([
      { id: 'a', kind: 'ok' },
      { id: 'b', kind: 'drift' },
      { id: 'c', kind: 'unknown' },
      { id: 'd', kind: 'throws' },
    ]);
    const r = await svc.runSweep(50, { staleBefore: new Date() });
    expect(r).toEqual({
      scanned: 4,
      drifted: 1,
      unknown: 1,
      failed: 1,
      outcomes: [
        { purchase_id: 'a', status: 'ok' },
        { purchase_id: 'b', status: 'drift' },
        { purchase_id: 'c', status: 'unknown' },
        { purchase_id: 'd', status: 'failed' },
      ],
    });
  });

  it('the admin run-sweeper route keeps its three-number answer', async () => {
    const reconciliation = {
      runSweep: jest.fn(async () => ({ scanned: 3, drifted: 1, unknown: 1, failed: 1, outcomes: [{ purchase_id: 'x', status: 'ok' }] })),
    };
    const ctl = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
    (ctl as any).reconciliation = reconciliation;
    await expect(ctl.runReconciliationSweeper('500')).resolves.toEqual({ scanned: 3, drifted: 1, unknown: 1 });
    expect(reconciliation.runSweep).toHaveBeenCalledWith(200);
  });
});

describe('ReconciliationDailyCron: every purchase, every day', () => {
  it.each(['refunded', 'disputed'])(
    'LS-1225 B2: a money-bearing %s purchase must not disappear from the daily check',
    async (status) => {
      const { cron } = cronFor([{ id: 'money-bearing-purchase', kind: 'drift', status }]);
      const result = await cron.runOnce(NOW(), 'machine-a', noPause);
      expect(result).toMatchObject({
        ran: true,
        verdict: 'needs_review',
        tally: { checked: 1, drift: 1 },
      });
    },
  );

  it('is scheduled once a day at 11:00 UTC (before 06:00 Pacific in summer and winter)', () => {
    expect(DAILY_CRON).toBe('0 11 * * *');
    expect(DAILY_JOB_NAME).toBe('reconciliation-daily');
    expect(BATCH).toBe(50);
    // 11:00 UTC + the whole budget is 04:45 PDT at the latest.
    expect(11 * 60 + RUN_BUDGET_MS / 60_000 - 7 * 60).toBeLessThan(6 * 60);
    expect(LEASE_TTL_MS).toBeGreaterThan(RUN_BUDGET_MS);
  });

  it('120 purchases are checked in 3 batches of 50 and the owner gets "clean"', async () => {
    const { cron, world, notes, users } = cronFor(many(120, 'ok'));
    const now = NOW();
    const r = await cron.runOnce(now, 'm1', noPause);
    expect(r).toMatchObject({ ran: true, verdict: 'clean', batches: 3, alerted: true });
    if (!r.ran) throw new Error('unreachable');
    expect(r.tally).toEqual({ checked: 120, ok: 120, drift: 0, unknown: 0, failed: 0, stopped: null });
    expect(world.snapshots.size).toBe(120);
    expect(world.findManyCalls.map((c: any) => c.take)).toEqual([50, 50, 50]);
    // Paced between batches, not before the first.
    expect(noPause.mock.calls).toEqual([[PACE_MS], [PACE_MS]]);
    expect(users.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'owner', deleted_at: null, deletion_scheduled_at: null } }),
    );
    expect(notes.pushToUser).toHaveBeenCalledTimes(1);
    const [uid, title, body, data, signal, route] = notes.pushToUser.mock.calls[0] as unknown as any[];
    expect([uid, title, body]).toEqual(['owner-1', 'Money check: clean', 'Checked 120 purchases against Stripe. Every one matches.']);
    expect(data).toEqual({ type: 'money_check', verdict: 'clean' });
    expect(signal).toBeUndefined();
    expect(route).toEqual({
      kind: NotificationKind.COACH_ALERT,
      passesMuteAll: true,
      dedupeKey: `money_daily:${now.toISOString().slice(0, 10)}`,
    });
    expect(notes.createNotification).toHaveBeenCalledTimes(1);
    expect(notes.createNotification.mock.calls[0][0]).toMatchObject({
      user_id: 'owner-1',
      kind: NotificationKind.COACH_ALERT,
      channel: 'inapp',
      body: 'Checked 120 purchases against Stripe. Every one matches.',
      payload: { type: 'money_check', title: 'Money check: clean', verdict: 'clean', checked: 120, drift: 0, unknown: 0, failed: 0 },
    });
  });

  it('a purchase checked an hour ago by the admin button is checked again today (one run = every purchase)', async () => {
    const { cron, world } = cronFor(many(3, 'ok'));
    await world.svc.runSweep(50); // the button, earlier
    expect(world.snapshots.size).toBe(3);
    const r = await cron.runOnce(new Date(Date.now() + 1), 'm1', noPause);
    if (!r.ran) throw new Error('did not run');
    expect(r.tally.checked).toBe(3);
  });

  it('skips $0 grants and purchases with no money moved, like the sweep always has', async () => {
    const { cron } = cronFor([
      { id: 'paid', kind: 'ok' },
      { id: 'grant', kind: 'ok', source: 'coach_grant' },
      { id: 'pending', kind: 'ok', status: 'pending' },
    ]);
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    if (!r.ran) throw new Error('did not run');
    expect(r.tally.checked).toBe(1);
  });

  it('drift, unknown and a failed check make it "needs review" with counts only', async () => {
    const { cron, notes } = cronFor([
      ...many(40, 'ok'),
      ...many(2, 'drift'),
      ...many(3, 'unknown'),
      { id: 'boom', kind: 'throws' },
    ]);
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    expect(r).toMatchObject({ ran: true, verdict: 'needs_review' });
    if (!r.ran) throw new Error('unreachable');
    expect(r.tally).toEqual({ checked: 46, ok: 40, drift: 2, unknown: 3, failed: 1, stopped: null });
    const [, title, body] = notes.pushToUser.mock.calls[0] as unknown as any[];
    expect(title).toBe('Money check: needs review');
    expect(body).toBe(
      "Checked 46 purchases against Stripe. 2 don't match, 3 could not be confirmed yet, 1 could not be checked.",
    );
    // Counts only: no purchase ids, no amounts.
    expect(body).not.toMatch(/\$|cents|drift-|boom|pi_|ch_/);
  });

  it('one failing purchase among 120 is counted once; the short third batch ends the run', async () => {
    const { cron, world } = cronFor([{ id: 'boom', kind: 'throws' }, ...many(120, 'ok')]);
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    if (!r.ran) throw new Error('did not run');
    // boom comes back in every batch (no snapshot); batch 3 is short.
    expect(r.batches).toBe(3);
    expect(r.tally).toEqual({ checked: 121, ok: 120, drift: 0, unknown: 0, failed: 1, stopped: null });
    expect(world.snapshots.size).toBe(120);
  });

  it('a purchase that keeps failing ends the run: a full batch with no new id stops it, and the alert says so', async () => {
    const { cron, notes } = cronFor([...many(60, 'throws'), ...many(30, 'ok')]);
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    if (!r.ran) throw new Error('did not run');
    expect(r.batches).toBe(2);
    expect(r.tally).toEqual({ checked: 50, ok: 0, drift: 0, unknown: 0, failed: 50, stopped: 'no_progress' });
    expect(r.verdict).toBe('needs_review');
    const [, , body] = notes.pushToUser.mock.calls[0] as unknown as any[];
    expect(body).toBe(
      'Checked 50 purchases against Stripe. 50 could not be checked. The check stopped early before it reached every purchase.',
    );
  });

  it('stops at the time budget and says so', async () => {
    const { cron, notes } = cronFor(many(200, 'ok'));
    let t = 0;
    const pause = jest.fn(async () => {
      t += RUN_BUDGET_MS; // the first pause uses up the whole budget
    });
    const r = await cron.runOnce(NOW(), 'm1', pause, () => t);
    if (!r.ran) throw new Error('did not run');
    expect(r.batches).toBe(2);
    expect(r.tally.stopped).toBe('time_limit');
    expect(r.tally.checked).toBe(100);
    const [, title, body] = notes.pushToUser.mock.calls[0] as unknown as any[];
    expect(title).toBe('Money check: needs review');
    expect(body).toBe(
      'Checked 100 purchases against Stripe. The check hit its time limit before it reached every purchase.',
    );
  });

  it('a batch that throws ends the run; the owner still hears what was checked', async () => {
    const { cron, world, notes } = cronFor(many(80, 'ok'));
    const real = world.svc.runSweep.bind(world.svc);
    let n = 0;
    jest.spyOn(world.svc, 'runSweep').mockImplementation(async (...a) => {
      n += 1;
      if (n === 2) throw new Error('db down');
      return real(...a);
    });
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    if (!r.ran) throw new Error('did not run');
    expect(r.tally).toMatchObject({ checked: 50, stopped: 'error' });
    expect(r.verdict).toBe('needs_review');
    expect(notes.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('no purchases at all is clean and says so plainly', async () => {
    const { cron, notes } = cronFor([]);
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    expect(r).toMatchObject({ ran: true, verdict: 'clean', batches: 1 });
    expect((notes.pushToUser.mock.calls[0] as unknown as any[])[2]).toBe('No purchases to check today.');
  });
});

describe('ReconciliationDailyCron: one machine, the off switch, the owner', () => {
  it.each([1, 1_000, 60_000])(
    'LS-1225 B1: a second machine starting %i ms later cannot repeat the same UTC day',
    async (offsetMs) => {
      const { lease } = leaseFor();
      const a = cronFor(many(2, 'ok'), { lease });
      const second = new ReconciliationDailyCron(lease, a.world.svc, a.notes as any, a.users as any);
      const now = NOW();
      const first = await a.cron.runOnce(now, 'machine-a', noPause);
      const again = await second.runOnce(new Date(now.getTime() + offsetMs), 'machine-b', noPause);
      expect({
        runs: Number(first.ran) + Number(again.ran),
        inboxRows: a.notes.createNotification.mock.calls.length,
      }).toEqual({ runs: 1, inboxRows: 1 });
    },
  );

  it('a held lease runs nothing: two machines at the same tick, one runs, the other skips (one push)', async () => {
    const { lease } = leaseFor();
    const a = cronFor(many(5, 'ok'), { lease });
    const b = cronFor(many(5, 'ok'), { lease });
    const now = NOW();
    const [ra, rb] = await Promise.all([a.cron.runOnce(now, 'm-a', noPause), b.cron.runOnce(now, 'm-b', noPause)]);
    const results = [ra, rb].map((r) => (r.ran ? 'ran' : r.reason)).sort();
    expect(results).toEqual(['lock_held', 'ran']);
    expect(a.notes.pushToUser.mock.calls.length + b.notes.pushToUser.mock.calls.length).toBe(1);
  });

  it('releases the lease when done, so tomorrow runs', async () => {
    const { lease, rows } = leaseFor();
    const { cron } = cronFor(many(2, 'ok'), { lease });
    const now = NOW();
    await cron.runOnce(now, 'm1', noPause);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'reconciliation-daily' });
    expect(new Date(rows[0].lease_until as Date).getTime()).toBe(now.getTime());
    const again = await cron.runOnce(new Date(now.getTime() + 24 * 3600_000), 'm2', noPause);
    expect(again.ran).toBe(true);
  });

  it('a lease read error skips the day without sending anything', async () => {
    const lease = { tryAcquire: jest.fn(async () => { throw new Error('db'); }), release: jest.fn() };
    const { cron, notes } = cronFor(many(2, 'ok'), { lease: lease as any });
    await expect(cron.runOnce(NOW(), 'm1', noPause)).resolves.toEqual({ ran: false, reason: 'lock_error' });
    expect(notes.pushToUser).not.toHaveBeenCalled();
  });

  it('RECONCILIATION_DAILY_ENABLED: unset = on, "false" = off, nothing else turns it off', async () => {
    expect(reconciliationDailyEnabled({})).toBe(true);
    expect(reconciliationDailyEnabled({ RECONCILIATION_DAILY_ENABLED: 'true' })).toBe(true);
    expect(reconciliationDailyEnabled({ RECONCILIATION_DAILY_ENABLED: 'false' })).toBe(false);
    process.env.RECONCILIATION_DAILY_ENABLED = 'false';
    const { cron, world, notes } = cronFor(many(2, 'ok'));
    await expect(cron.runOnce(NOW(), 'm1', noPause)).resolves.toEqual({ ran: false, reason: 'disabled' });
    expect(world.prisma.clientPurchase.findMany).not.toHaveBeenCalled();
    expect(notes.pushToUser).not.toHaveBeenCalled();
  });

  it('with no owner account nothing is sent and the run still ends cleanly', async () => {
    const { cron, notes } = cronFor(many(2, 'ok'), { owner: null });
    const r = await cron.runOnce(NOW(), 'm1', noPause);
    expect(r).toMatchObject({ ran: true, alerted: false });
    expect(notes.pushToUser).not.toHaveBeenCalled();
  });

  it('a send that throws never throws out of the run', async () => {
    const { cron, notes } = cronFor(many(2, 'ok'));
    notes.pushToUser.mockRejectedValueOnce(new Error('expo down'));
    await expect(cron.runOnce(NOW(), 'm1', noPause)).resolves.toMatchObject({ ran: true, alerted: false });
  });

  it('the push passes Mute all (a money alert) and an ordinary coach_alert push does not', async () => {
    const { cron, notes } = cronFor(many(1, 'ok'));
    await cron.runOnce(NOW(), 'm1', noPause);
    const route = (notes.pushToUser.mock.calls[0] as unknown as any[])[5];
    const mutedAllOn = { muted: true };
    expect(pushAllowedByPreferences(mutedAllOn, route.kind, { passesMuteAll: route.passesMuteAll })).toBe(true);
    expect(pushAllowedByPreferences(mutedAllOn, NotificationKind.COACH_ALERT)).toBe(false);
  });
});

// KT-4: the real send path (NotificationsService.pushToUser -> outbox -> worker), the owner with Mute all on,
// in Pacific time, at the run's 04:00 PDT: the push waits for 08:00 and then goes; one row, to the owner only.
describe('ReconciliationDailyCron through the real push path (Mute all on, quiet hours, recipient exact)', () => {
  it('Mute all on: the owner still gets it; inside quiet hours it waits for 08:00 Pacific; nobody else gets anything', async () => {
    const LA = 'America/Los_Angeles';
    const clock = { at: new Date('2026-10-06T11:00:00Z') }; // 04:00 PDT, the cron's hour
    const owner = 'owner-qh';
    const world = pushOutboxWorld({
      now: () => clock.at,
      prefs: { [owner]: { muted: true, coach_alert_inapp: true, coach_alert_push: true, timezone: LA, timezone_updated_at: new Date('2026-01-01T00:00:00Z') } },
    });
    world.tokens[owner] = 'ExponentPushToken[moneydailyowner0000]';
    world.tokens['coach-x'] = 'ExponentPushToken[moneydailycoach0000]';
    const inbox: Array<Record<string, unknown>> = [];
    const db = {
      ...world.db,
      notification: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => {
          inbox.push(a.data);
          return { id: `n-${inbox.length}`, ...a.data };
        }),
      },
    };
    const sent = jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `t-${i}` })));
    class Clocked extends PushDeliveryService {
      protected now(): Date {
        return new Date(clock.at.getTime());
      }
    }
    const delivery = new Clocked(
      stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
      stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) }),
    );
    delivery.autoDrain = false;
    const svc = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
      undefined,
      undefined,
      delivery,
    );
    const money = moneyWorld([...many(3, 'ok'), ...many(1, 'drift')]);
    const cron = new ReconciliationDailyCron(leaseFor().lease, money.svc, svc, userTable({ id: owner }) as any);
    const r = await cron.runOnce(new Date(Date.now() - 1_000), 'm1', noPause);
    expect(r).toMatchObject({ ran: true, verdict: 'needs_review', alerted: true });
    // The inbox row: the owner's, counts only.
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ user_id: owner, kind: NotificationKind.COACH_ALERT });
    expect(String(inbox[0].body)).toBe("Checked 4 purchases against Stripe. 1 doesn't match.");
    expect(inbox[0].payload).toMatchObject({ title: 'Money check: needs review', verdict: 'needs_review', checked: 4, drift: 1 });
    // The push: queued for the owner only, held to 08:00 PDT (15:00Z), carrying the Mute all pass.
    expect(world.rows).toHaveLength(1);
    expect(world.rows[0]).toMatchObject({
      user_id: owner,
      kind: NotificationKind.COACH_ALERT,
      deferred_reason: 'quiet_hours',
      not_before: new Date('2026-10-06T15:00:00Z'),
      context: { passesMuteAll: true },
    });
    await delivery.drain();
    expect(sent).not.toHaveBeenCalled();
    clock.at = new Date('2026-10-06T15:00:00Z');
    await delivery.drain();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(world.rows[0].status).toBe('sent');
    const [msg] = (sent.mock.calls[0] as unknown as [Array<Record<string, unknown>>])[0];
    expect(msg).toMatchObject({
      to: 'ExponentPushToken[moneydailyowner0000]',
      title: 'Money check: needs review',
      body: "Checked 4 purchases against Stripe. 1 doesn't match.",
    });
  });
});

describe('dailyAlertCopy / dailyVerdict', () => {
  const t = (p: Partial<DailyTally>): DailyTally => ({ checked: 1, ok: 1, drift: 0, unknown: 0, failed: 0, stopped: null, ...p });
  it('singular and plural read right', () => {
    expect(dailyAlertCopy(t({})).body).toBe('Checked 1 purchase against Stripe. Every one matches.');
    expect(dailyAlertCopy(t({ checked: 1, ok: 0, drift: 1 })).body).toBe("Checked 1 purchase against Stripe. 1 doesn't match.");
  });
  it('clean needs every purchase reached and matched', () => {
    expect(dailyVerdict(t({}))).toBe('clean');
    expect(dailyVerdict(t({ stopped: 'time_limit' }))).toBe('needs_review');
    expect(dailyVerdict(t({ unknown: 1 }))).toBe('needs_review');
  });
});
