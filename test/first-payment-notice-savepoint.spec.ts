/**
 * B-LSNOTIFY3-1 (FR-NOTIFY4, b#1169 LS-NOTIFY3 6455999632): a first-payment
 * notice that fails never fails the coach's purchase.
 *
 * The once-ever claim (CoachFirstPaymentNotification) and its notice (the inbox
 * row, its push twin and the queued push) run inside the webhook's purchase
 * transaction. On Postgres a failed statement aborts the whole transaction:
 * every later statement fails with 25P02 until a ROLLBACK TO SAVEPOINT, so a
 * caught error is not enough. The step now runs behind its own savepoint: a
 * failed notice rolls back to it (the claim goes with the notice), the purchase
 * writes after it still run, and the next paid purchase sends the notice once.
 *
 * Lane-runnable, no Postgres: `pgTransaction` below keeps Postgres's rule for
 * one transaction (abort after an error, ROLLBACK TO SAVEPOINT undoes the rows
 * written after the savepoint and clears the abort, COMMIT of an aborted
 * transaction fails). The real CoachFirstPaymentService -> FirstPaymentEmitter
 * -> NotificationsService -> PushDeliveryService run on it. The live twin is
 * test/rls/first-payment-second-purchase-rls.spec.ts (real Postgres).
 */
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditService } from '../src/audit/audit.service';
import { CoachFirstPaymentService } from '../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../src/notifications/emitters/first-payment.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const COACH = 'coach-sp';
const CLIENT = 'client-sp';
const INPUT = { coachId: COACH, amount: 4900, currency: 'usd', clientId: CLIENT };

type Row = Record<string, unknown>;
type Fail = 'outbox' | 'inbox' | 'ledger' | null;

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const aborted = () =>
  pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');

function world() {
  const w = pushOutboxWorld({ now: () => new Date() });
  const sales: Row[] = [];
  const ledger: Row[] = [];
  const inbox: Row[] = [];
  const tables: unknown[][] = [sales, ledger, inbox, w.rows];
  const statements: string[] = [];
  let fail: Fail = null;
  let deadConnection = false;
  let isAborted = false;
  let savepoints: Array<{ name: string; sizes: number[] }> = [];

  // One SQL statement: refused while the transaction is aborted; an error aborts it.
  const statement =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      statements.push(name);
      if (isAborted) throw aborted();
      try {
        return await fn(...a);
      } catch (e) {
        isAborted = true;
        throw e;
      }
    };
  const wrap = <T extends object>(table: string, delegate: T): T =>
    Object.fromEntries(
      Object.entries(delegate).map(([k, v]) => [
        k,
        typeof v === 'function' ? statement(`${table}.${k}`, v as (...a: unknown[]) => Promise<unknown>) : v,
      ]),
    ) as T;

  const failOnce = (what: Fail, error: Error) => {
    if (fail !== what) return;
    fail = null;
    throw error;
  };

  const db = {
    ...w.db,
    pushOutbox: wrap('pushOutbox', {
      ...w.db.pushOutbox,
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        // A real SQL error at the queued push (NOT NULL violation).
        failOnce('outbox', pgError('23502', 'null value in column violates not-null constraint'));
        return w.db.pushOutbox.createMany(args);
      },
    }),
    notificationPreferences: wrap('notificationPreferences', w.db.notificationPreferences),
    user: wrap('user', w.db.user),
    coachProfile: wrap('coachProfile', w.db.coachProfile),
    notification: wrap('notification', {
      findFirst: async () => null,
      create: async (a: { data: Row }) => {
        failOnce('inbox', pgError('23502', 'null value in column violates not-null constraint'));
        inbox.push(a.data);
        return { id: `n-${inbox.length}`, ...a.data };
      },
    }),
    coachFirstPaymentNotification: wrap('ledger', {
      createMany: async ({ data }: { data: Row[]; skipDuplicates?: boolean }) => {
        failOnce('ledger', pgError('23503', 'insert violates foreign key constraint'));
        let count = 0;
        for (const row of data) {
          if (ledger.some((r) => r.coachId === row.coachId)) continue; // ON CONFLICT DO NOTHING
          ledger.push(row);
          count += 1;
        }
        return { count };
      },
    }),
    clientPurchase: wrap('clientPurchase', {
      create: async (a: { data: Row }) => {
        sales.push({ ...a.data });
        return a.data;
      },
      update: async (a: { where: { id: string }; data: Row }) => {
        const sale = sales.find((s) => s.id === a.where.id);
        if (!sale) throw pgError('P2025', 'record not found');
        Object.assign(sale, a.data);
        return sale;
      },
    }),
    // Transaction control: SAVEPOINT, RELEASE SAVEPOINT, ROLLBACK TO SAVEPOINT.
    $executeRaw: jest.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('?').trim();
      statements.push(text);
      if (deadConnection) throw pgError('P1017', 'Server has closed the connection.');
      const back = /^ROLLBACK TO SAVEPOINT (\w+)$/.exec(text);
      if (back) {
        const at = savepoints.map((s) => s.name).lastIndexOf(back[1]);
        if (at < 0) throw pgError('3B001', `savepoint "${back[1]}" does not exist`);
        savepoints[at].sizes.forEach((n, i) => tables[i].splice(n));
        savepoints = savepoints.slice(0, at + 1);
        isAborted = false;
        return 0;
      }
      if (isAborted) throw aborted();
      const save = /^SAVEPOINT (\w+)$/.exec(text);
      if (save) {
        savepoints.push({ name: save[1], sizes: tables.map((t) => t.length) });
        return 0;
      }
      const release = /^RELEASE SAVEPOINT (\w+)$/.exec(text);
      if (release) {
        const at = savepoints.map((s) => s.name).lastIndexOf(release[1]);
        if (at < 0) throw pgError('3B001', `savepoint "${release[1]}" does not exist`);
        savepoints = savepoints.slice(0, at);
        return 0;
      }
      throw new Error(`unexpected statement: ${text}`);
    }),
  };

  const send = jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` })));
  const delivery = new PushDeliveryService(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  w.tokens[COACH] = 'ExponentPushToken[savepoint]';
  const write = jest.fn(async (_entry: unknown) => undefined);
  const service = new CoachFirstPaymentService(
    new FirstPaymentEmitter(notifications),
    stub<AuditService>({ write }),
  );
  const tx = stub<Prisma.TransactionClient>(db);

  // One paid purchase, the webhook's shape: the purchase row, the first-payment
  // step, then the write the webhook makes after it; then COMMIT. Any error
  // rolls the whole transaction back (every table to its size at BEGIN).
  let n = 0;
  const purchase = async () => {
    const begin = tables.map((t) => t.length);
    isAborted = false;
    savepoints = [];
    const id = `sale-${++n}`;
    try {
      await db.clientPurchase.create({ data: { id, status: 'pending' } });
      await service.tryEmitFirstPayment(tx, INPUT);
      await db.clientPurchase.update({ where: { id }, data: { status: 'entitled' } });
      if (isAborted) throw aborted(); // COMMIT of an aborted transaction is a ROLLBACK
    } catch (e) {
      begin.forEach((size, i) => tables[i].splice(size));
      throw e;
    }
    return id;
  };
  const counts = () => ({
    sales: sales.length,
    entitled: sales.filter((s) => s.status === 'entitled').length,
    ledger: ledger.length,
    inbox: inbox.map((r) => r.channel),
    push: w.rows.length,
  });
  return {
    purchase,
    counts,
    statements,
    write,
    failNext: (what: Fail) => {
      fail = what;
    },
    loseConnectionAfterError: () => {
      const original = db.pushOutbox.createMany;
      db.pushOutbox.createMany = async (args) => {
        try {
          return await original(args);
        } finally {
          deadConnection = true;
        }
      };
    },
  };
}

describe('B-LSNOTIFY3-1: a failed first-payment notice never fails the purchase', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('control: the happy path claims, writes the notice, queues one push and commits', async () => {
    const w = world();
    await w.purchase();
    expect(w.counts()).toEqual({ sales: 1, entitled: 1, ledger: 1, inbox: ['inapp', 'push'], push: 1 });
    expect(w.write).toHaveBeenCalledTimes(1);
  });

  it('(failed before) a real SQL error at the queued push: the purchase commits, the claim and the notice roll back', async () => {
    const w = world();
    w.failNext('outbox');
    await expect(w.purchase()).resolves.toBe('sale-1');
    // The webhook's write after the step ran on a usable transaction.
    expect(w.counts()).toEqual({ sales: 1, entitled: 1, ledger: 0, inbox: [], push: 0 });
    // No audit entry for a notice that was not sent.
    expect(w.write).not.toHaveBeenCalled();
    // Observable, with no client id, amount or error text in the line.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_payment_notice_failed', coachId: COACH, code: '23502' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/client-sp|4900|not-null/);
  });

  it('(failed before) a real SQL error at the inbox row behaves the same', async () => {
    const w = world();
    w.failNext('inbox');
    await expect(w.purchase()).resolves.toBe('sale-1');
    expect(w.counts()).toEqual({ sales: 1, entitled: 1, ledger: 0, inbox: [], push: 0 });
  });

  it('(failed before) a failed claim insert keeps the purchase and sends nothing', async () => {
    const w = world();
    w.failNext('ledger');
    await expect(w.purchase()).resolves.toBe('sale-1');
    expect(w.counts()).toEqual({ sales: 1, entitled: 1, ledger: 0, inbox: [], push: 0 });
  });

  it('(failed before) after a failed notice the next paid purchase sends it once, and never again', async () => {
    const w = world();
    w.failNext('outbox');
    await w.purchase();
    await w.purchase();
    expect(w.counts()).toEqual({ sales: 2, entitled: 2, ledger: 1, inbox: ['inapp', 'push'], push: 1 });
    await w.purchase();
    expect(w.counts()).toEqual({ sales: 3, entitled: 3, ledger: 1, inbox: ['inapp', 'push'], push: 1 });
    expect(w.write).toHaveBeenCalledTimes(1);
  });

  it('(failed before) the step is one savepoint: set before the claim, released after the notice', async () => {
    const w = world();
    await w.purchase();
    const at = (s: string) => w.statements.indexOf(s);
    expect(at('SAVEPOINT first_payment_notice')).toBeGreaterThan(at('clientPurchase.create'));
    expect(at('SAVEPOINT first_payment_notice')).toBeLessThan(at('ledger.createMany'));
    expect(at('RELEASE SAVEPOINT first_payment_notice')).toBeGreaterThan(at('pushOutbox.createMany'));
    expect(at('RELEASE SAVEPOINT first_payment_notice')).toBeLessThan(at('clientPurchase.update'));
    expect(w.statements).not.toContain('ROLLBACK TO SAVEPOINT first_payment_notice');
  });

  it('a lost connection (the rollback to the savepoint fails) rethrows the first error: the purchase rolls back for a redelivery', async () => {
    const w = world();
    w.failNext('outbox');
    w.loseConnectionAfterError();
    await expect(w.purchase()).rejects.toMatchObject({ code: '23502' });
    expect(w.counts()).toEqual({ sales: 0, entitled: 0, ledger: 0, inbox: [], push: 0 });
  });

  it('a duplicate claim (already sent) still skips the notice without a savepoint rollback', async () => {
    const w = world();
    await w.purchase();
    await w.purchase();
    expect(w.counts()).toMatchObject({ sales: 2, ledger: 1, push: 1 });
    expect(w.statements).not.toContain('ROLLBACK TO SAVEPOINT first_payment_notice');
  });
});
