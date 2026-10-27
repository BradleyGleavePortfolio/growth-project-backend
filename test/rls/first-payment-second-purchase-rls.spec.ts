/**
 * B-LSNOTIFY-1 (FR-NOTIFY2, agent 177; b#1169 AUDIT 6426424702): a coach's
 * SECOND paid purchase commits on real Postgres.
 *
 * CoachFirstPaymentService runs inside the interactive purchase transaction.
 * It used to INSERT the once-ever ledger row and catch the duplicate's P2002 in
 * JS. On Postgres a failed statement aborts the whole transaction (25P02) even
 * when the error is caught, so every write after it failed and the coach's
 * second purchase rolled back. The service now inserts with ON CONFLICT DO
 * NOTHING (createMany + skipDuplicates) and treats count 0 as "already sent".
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay (the whole
 * migration chain) with the REAL CoachFirstPaymentService -> FirstPaymentEmitter
 * -> NotificationsService -> PushDeliveryService, only the Expo client faked.
 * Each "purchase" is one prisma.$transaction that writes a ClientPurchase row,
 * runs the first-payment step, then writes again (as the webhook does after
 * the step), exactly the shape that broke.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { CoachFirstPaymentService } from '../../src/notifications/coach-first-payment.service';
import { FirstPaymentEmitter } from '../../src/notifications/emitters/first-payment.emitter';
import { NotificationKind } from '../../src/notifications/notification-kind';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { ExpoPushClient, PushDeliveryService } from '../../src/notifications/push/push-delivery.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { stub } from '../utils/trial-fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('first-payment-second-purchase-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'K' | 'L' | 'M' | 'A' | 'B' | 'C';
const ROLE: Record<Key, string> = { K: 'coach', L: 'coach', M: 'coach', A: 'student', B: 'student', C: 'student' };
const COACH_OF: Partial<Record<Key, Key>> = { A: 'K', B: 'K', C: 'M' };
const FIRST_PAYMENT = NotificationKind.FIRST_PAYMENT;

(DB_URL ? describe : describe.skip)('B-LSNOTIFY-1: the second paid purchase commits on Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['K', 'L', 'M', 'A', 'B', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const pkg = { K: randomUUID(), M: randomUUID() };

  const send = jest.fn(async (m: unknown[]) => m.map((_x, i) => ({ status: 'ok', id: `ticket-${i}` })));
  const delivery = new PushDeliveryService(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(prisma),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
    undefined,
    undefined,
    delivery,
  );
  const service = new CoachFirstPaymentService(new FirstPaymentEmitter(notifications));

  // One paid purchase: the purchase row, the first-payment step, then the
  // write the webhook makes after the step. Returns the purchase id.
  const purchase = async (coach: 'K' | 'M', client: 'A' | 'B' | 'C', amount: number) => {
    const saleId = randomUUID();
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`INSERT INTO "ClientPurchase" ("id", "client_user_id", "coach_user_id", "package_id",
        "amount_cents", "stripe_checkout_session_id", "idempotency_key", "updated_at")
        VALUES (${saleId}, ${id[client]}, ${id[coach]}, ${pkg[coach]}, ${amount}, ${`cs_${saleId}`}, ${saleId}, now())`;
      await service.tryEmitFirstPayment(tx, { coachId: id[coach], amount, currency: 'usd', clientId: id[client] });
      await tx.$executeRaw`UPDATE "ClientPurchase" SET "updated_at" = now() WHERE "id" = ${saleId}`;
    });
    return saleId;
  };
  const counts = async (coach: Key) => {
    const [ledger, inbox, push, sales] = await Promise.all([
      prisma.coachFirstPaymentNotification.findMany({ where: { coachId: id[coach] } }),
      prisma.notification.findMany({ where: { user_id: id[coach], kind: FIRST_PAYMENT }, orderBy: { channel: 'asc' } }),
      prisma.pushOutbox.findMany({ where: { user_id: id[coach], kind: FIRST_PAYMENT } }),
      prisma.clientPurchase.count({ where: { coach_user_id: id[coach] } }),
    ]);
    return { ledger, inbox, push, sales };
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    for (const k of keys) {
      const coach = COACH_OF[k] ? id[COACH_OF[k] as Key] : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`first-payment-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    for (const c of ['K', 'M'] as const) {
      await prisma.coachPackage.create({ data: { id: pkg[c], coach_id: id[c], name: 'RLS plan', amount_cents: 4900 } });
    }
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.$disconnect();
  });

  it('control (failed before): catching the duplicate P2002 leaves the purchase transaction aborted', async () => {
    // The old code path, run by hand: a coach who already has the ledger row.
    await prisma.coachFirstPaymentNotification.create({
      data: { coachId: id.L, amount: 100, currency: 'usd', clientId: id.A },
    });
    let caught = '';
    let after = '';
    await prisma
      .$transaction(async (tx: Prisma.TransactionClient) => {
        try {
          await tx.coachFirstPaymentNotification.create({
            data: { coachId: id.L, amount: 200, currency: 'usd', clientId: id.B },
          });
        } catch (e) {
          caught = String((e as { code?: string }).code);
        }
        // Any statement after the caught violation fails: the tx is aborted.
        await tx.$queryRaw`SELECT 1`;
      })
      .catch((e: unknown) => {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        after = `${err.code ?? ''} ${err.meta?.code ?? ''} ${err.message ?? ''}`;
      });
    expect(caught).toBe('P2002');
    expect(after).toMatch(/25P02|current transaction is aborted/);
  });

  it('first purchase writes one ledger row, the inbox row and its push twin, and one push outbox row', async () => {
    await purchase('K', 'A', 4900);
    const c = await counts('K');
    expect(c.sales).toBe(1);
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]).toMatchObject({ coachId: id.K, clientId: id.A, amount: 4900, currency: 'usd' });
    expect(c.inbox.map((n) => n.channel)).toEqual(['inapp', 'push']);
    expect(c.inbox.every((n) => n.deep_link === `tgp://coach/clients/${id.A}`)).toBe(true);
    expect(c.push).toHaveLength(1);
    expect(c.push[0]).toMatchObject({ dedupe_key: `first_payment:${id.K}`, status: 'pending' });
  });

  it('(failed before) the same coach\'s second paid purchase commits and sends nothing new', async () => {
    const second = await purchase('K', 'B', 12000);
    const c = await counts('K');
    expect(await prisma.clientPurchase.count({ where: { id: second } })).toBe(1);
    expect(c.sales).toBe(2);
    // Still the first client's once-ever row, one inbox pair, one queued push.
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0].clientId).toBe(id.A);
    expect(c.inbox).toHaveLength(2);
    expect(c.push).toHaveLength(1);
    // And a third (a Stripe redelivery of either) still commits.
    await purchase('K', 'A', 4900);
    expect((await counts('K')).sales).toBe(3);
    expect((await counts('K')).push).toHaveLength(1);
  });

  it('two first payments for one coach at the same time both commit; one ledger row, one push', async () => {
    const fresh = randomUUID();
    const freshSub = randomUUID();
    const freshPkg = randomUUID();
    await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
      VALUES (${fresh}, ${freshSub}, ${`first-payment-${fresh}`}, 'RLS user', 'coach'::"Role")`;
    await prisma.coachPackage.create({ data: { id: freshPkg, coach_id: fresh, name: 'RLS plan', amount_cents: 4900 } });
    const race = (client: 'A' | 'B') =>
      prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const saleId = randomUUID();
        await tx.$executeRaw`INSERT INTO "ClientPurchase" ("id", "client_user_id", "coach_user_id", "package_id",
          "amount_cents", "stripe_checkout_session_id", "idempotency_key", "updated_at")
          VALUES (${saleId}, ${id[client]}, ${fresh}, ${freshPkg}, 4900, ${`cs_${saleId}`}, ${saleId}, now())`;
        await service.tryEmitFirstPayment(tx, { coachId: fresh, amount: 4900, currency: 'usd', clientId: id[client] });
        await tx.$executeRaw`UPDATE "ClientPurchase" SET "updated_at" = now() WHERE "id" = ${saleId}`;
      }, { timeout: 20000 });
    await Promise.all([race('A'), race('B')]);
    expect(await prisma.clientPurchase.count({ where: { coach_user_id: fresh } })).toBe(2);
    expect(await prisma.coachFirstPaymentNotification.count({ where: { coachId: fresh } })).toBe(1);
    expect(await prisma.notification.count({ where: { user_id: fresh, kind: FIRST_PAYMENT } })).toBe(2);
    expect(await prisma.pushOutbox.count({ where: { user_id: fresh, kind: FIRST_PAYMENT } })).toBe(1);
  });

  it('a failed push outbox insert rolls the whole purchase back; the Stripe retry sends exactly once', async () => {
    // A real Postgres error inside the purchase tx at the outbox step (NOT NULL
    // violation), the way a broken outbox write would fail in production.
    const enqueue = jest.spyOn(delivery, 'enqueue').mockImplementationOnce(async (_push, tx) => {
      if (!tx) throw new Error('first-payment push must ride the purchase transaction');
      await tx.$executeRawUnsafe('INSERT INTO "PushOutbox" ("id") VALUES (NULL)');
      throw new Error('unreachable');
    });
    await expect(purchase('M', 'C', 4900)).rejects.toBeDefined();
    let c = await counts('M');
    expect(c).toMatchObject({ sales: 0, ledger: [], inbox: [], push: [] });

    // Redelivery: the real outbox write this time.
    await purchase('M', 'C', 4900);
    c = await counts('M');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(c.sales).toBe(1);
    expect(c.ledger).toHaveLength(1);
    expect(c.inbox.map((n) => n.channel)).toEqual(['inapp', 'push']);
    expect(c.push).toHaveLength(1);
    enqueue.mockRestore();
  });

  it('tenancy: no coach or client request can read the ledger row; the server role reads it (control)', async () => {
    // 20270502003500_billing_rows_server_only: billing ledgers are server-only
    // at the grant layer, so a request role is refused (42501) before RLS.
    const reads = (who: Key | 'server') =>
      prisma
        .$transaction(async (tx: Prisma.TransactionClient) => {
          if (who === 'server') {
            await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
          } else {
            await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
            await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
              JSON.stringify({ sub: sub[who], role: 'authenticated' }));
          }
          const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS "n" FROM "coach_first_payment_notification" WHERE "coachId" = $1`, id.K);
          return rows[0].n;
        })
        .catch((e: unknown) => {
          const err = e as { meta?: { code?: string }; message?: string };
          return `refused ${err.meta?.code ?? ''} ${err.message ?? ''}`;
        });
    expect(await reads('server')).toBe(1); // control: the row exists and is readable
    expect(await reads('L')).toMatch(/^refused .*(42501|permission denied)/); // another coach
    expect(await reads('A')).toMatch(/^refused .*(42501|permission denied)/); // the paying client
    expect(await reads('K')).toMatch(/^refused .*(42501|permission denied)/); // even the owner: server-only
  });
});
