// Independent AUD-SOL-661R5-117 proof. CI runner's disposable PostgreSQL only.
// Real generated Prisma Client, real handler and real recovery/cancellation.
// The three physical fixture tables contain every scalar field of their
// candidate models but intentionally no unrelated FKs/RLS/migration history.
import { execFileSync } from 'child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import { StripeConnectApiService, StripeConnectApiError } from '../src/connect/stripe-connect-api.service';

jest.setTimeout(30000);
const url = 'postgresql://aud_sol_661r5:synthetic_only@127.0.0.1:5432/aud_sol_661r5_disposable?connection_limit=8';
let prisma: PrismaClient;
let other: PrismaClient;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sqlTypes: Record<string, string> = {
  String: 'TEXT', Int: 'INTEGER', Boolean: 'BOOLEAN', DateTime: 'TIMESTAMP(3)',
  Json: 'JSONB', Float: 'DOUBLE PRECISION', Decimal: 'DECIMAL', BigInt: 'BIGINT', Bytes: 'BYTEA',
};

beforeAll(async () => {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('CI-only disposable fixture; no application database allowed');
  execFileSync('sudo', ['systemctl', 'start', 'postgresql'], { stdio: 'pipe' });
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c',
    "CREATE ROLE aud_sol_661r5 LOGIN PASSWORD 'synthetic_only';"], { stdio: 'pipe' });
  execFileSync('sudo', ['-u', 'postgres', 'createdb', '-O', 'aud_sol_661r5', 'aud_sol_661r5_disposable'], { stdio: 'pipe' });
  prisma = new PrismaClient({ datasources: { db: { url } } });
  other = new PrismaClient({ datasources: { db: { url } } });
  const identity = await prisma.$queryRaw<Array<{ db: string; address: string; version: string }>>`
    SELECT current_database() AS db, host(inet_server_addr()) AS address, version() AS version`;
  expect(identity[0].db).toBe('aud_sol_661r5_disposable');
  expect(identity[0].address).toBe('127.0.0.1');
  console.log('DISPOSABLE_POSTGRES', identity[0]);
  for (const modelName of ['ClientPurchase', 'PurchaseFanout', 'ScheduledDrop', 'PartialRefundDecision']) {
    const model = Prisma.dmmf.datamodel.models.find(m => m.name === modelName)!;
    const columns = model.fields.filter(f => f.kind === 'scalar').map(f => {
      const type = sqlTypes[f.type];
      if (!type) throw new Error(`Unhandled fixture scalar ${f.type}`);
      let def = '';
      if (typeof f.default === 'string') def = ` DEFAULT ${literal(f.default)}`;
      else if (typeof f.default === 'number' || typeof f.default === 'boolean') def = ` DEFAULT ${String(f.default)}`;
      else if (f.default && typeof f.default === 'object' && 'name' in f.default && f.default.name === 'now') def = ' DEFAULT CURRENT_TIMESTAMP';
      return `${q(f.name)} ${type}${f.isRequired ? ' NOT NULL' : ''}${f.isId ? ' PRIMARY KEY' : ''}${f.isUnique ? ' UNIQUE' : ''}${def}`;
    });
    await prisma.$executeRawUnsafe(`CREATE TABLE ${q(modelName)} (${columns.join(',')})`);
  }
});
afterAll(async () => {
  await prisma?.$disconnect();
  await other?.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "ScheduledDrop", "PurchaseFanout", "ClientPurchase", "PartialRefundDecision"');
});
afterEach(() => jest.restoreAllMocks());

function fixture<T>(value: object): T { return value as T; }
class StripeStub extends StripeConnectApiService {
  statusNow = 'requires_payment_method';
  retrievePaymentIntent = jest.fn(async (id: string) => ({ id, status: this.statusNow, latest_charge: 'ch_synthetic' }));
}
function wiring(db: Prisma.TransactionClient | PrismaClient) {
  return {
    clientPurchase: db.clientPurchase,
    purchaseFanout: db.purchaseFanout,
    scheduledDrop: db.scheduledDrop,
    $queryRaw: db.$queryRaw.bind(db),
    coachPackage: { findUnique: jest.fn(async () => ({ id: 'pkg', billing_type: 'one_time', duration_periods: 4 })) },
    coachPackageContent: { findMany: jest.fn(async () => []) },
  };
}
function harness() {
  const stripe = new StripeStub();
  const fanout = new PurchaseFanoutService();
  const entitled = jest.spyOn(fanout, 'onPurchaseEntitled');
  const restored = jest.spyOn(fanout, 'restoreAfterPaymentRecovered');
  const splits = { onChargeSucceeded: jest.fn() };
  const first = { tryEmitFirstPayment: jest.fn() };
  const real = { ...wiring(prisma), $transaction: prisma.$transaction.bind(prisma) };
  type C = ConstructorParameters<typeof CheckoutWebhookHandlerService>;
  const svc = new CheckoutWebhookHandlerService(
    fixture<C[0]>(real), stripe, fixture<C[2]>(splits), undefined, undefined, fanout,
    undefined, undefined, fixture<C[8]>(first),
  );
  return { stripe, fanout, svc, entitled, restored, splits, first };
}
const pi = 'pi_synthetic';
const failed = (id = 'evt_decline') => ({ id, type: 'payment_intent.payment_failed', data: { object: { id: pi, last_payment_error: { message: 'card_declined' } } } });
const succeeded = (id = 'evt_success') => ({ id, type: 'payment_intent.succeeded', data: { object: { id: pi, latest_charge: 'ch_synthetic' } } });
const completed = { id: 'evt_completed', type: 'checkout.session.completed', data: { object: { id: 'cs_synthetic', payment_intent: pi, mode: 'payment' } } };
async function seed(status = 'paid', hosted = true) {
  return prisma.clientPurchase.create({ data: {
    id: 'purchase', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg',
    amount_cents: 10000, idempotency_key: 'synthetic-key',
    billing_type: 'one_time', status, entitlement_active: status === 'paid',
    stripe_checkout_session_id: hosted ? 'cs_synthetic' : pi, stripe_payment_intent_id: pi,
    stripe_client_secret: hosted ? null : 'pi_synthetic_secret_canary',
    stripe_ephemeral_key: hosted ? null : 'ek_test_canary',
  } });
}
async function activateMarker() {
  await prisma.purchaseFanout.create({ data: { purchase_id: 'purchase', entrypoint: 'in_app_hosted', state: 'succeeded' } });
}
type Event = { id: string; type: string; data: { object: Record<string, unknown> } };
async function deliver(h: ReturnType<typeof harness>, event: Event) {
  const prefetch = await h.svc.prefetchForOuterTx(event);
  return prisma.$transaction(tx => h.svc.handle(event, fixture<Prisma.TransactionClient>(wiring(tx)), prefetch));
}
async function version() {
  return (await prisma.$queryRaw<Array<{ row_version: string }>>`SELECT xmin::text AS row_version FROM "ClientPurchase" WHERE id = 'purchase'`)[0].row_version;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('independent exact-head PostgreSQL settlement acceptance', () => {
  it('xmin changes on a committed same-clock same-value write but not a row lock, and rolled-back writes do not invalidate it', async () => {
    const row = await seed();
    const before = await version();
    await prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = 'purchase' FOR UPDATE`);
    expect(await version()).toBe(before);
    await other.clientPurchase.update({ where: { id: 'purchase' }, data: { updated_at: row.updated_at } });
    expect(await version()).not.toBe(before);
    const committed = await version();
    await expect(other.$transaction(async tx => {
      await tx.clientPurchase.update({ where: { id: 'purchase' }, data: { status: 'payment_failed' } });
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect(await version()).toBe(committed);
  });

  it('equal application-clock successful settlement invalidates old prefetched decline evidence', async () => {
    const h = harness();
    const row = await seed();
    const old = failed();
    const prefetched = await h.svc.prefetchForOuterTx(old);
    await other.clientPurchase.update({ where: { id: 'purchase' }, data: { updated_at: row.updated_at } });
    await expect(prisma.$transaction(tx => h.svc.handle(old, fixture<Prisma.TransactionClient>(wiring(tx)), prefetched)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('an actual success handler between prefetch and decline makes the old evidence retry, then fresh delivery no-ops', async () => {
    const h = harness();
    await seed();
    const old = failed();
    const prefetched = await h.svc.prefetchForOuterTx(old);
    h.stripe.statusNow = 'succeeded';
    await deliver(h, succeeded());
    await expect(prisma.$transaction(tx => h.svc.handle(old, fixture<Prisma.TransactionClient>(wiring(tx)), prefetched)))
      .rejects.toMatchObject({ response: { reason: 'purchase_changed' } });
    expect((await deliver(h, old)).reason).toBe('stale_failure');
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('the no-outer-tx decline does not call Stripe under its short transaction and cancels drops atomically', async () => {
    const h = harness();
    await seed();
    let inside = false;
    const raw = { ...wiring(prisma), $transaction: async <T>(cb: (tx: object) => Promise<T>) => {
      inside = true;
      try { return await prisma.$transaction(tx => cb(wiring(tx))); } finally { inside = false; }
    } };
    type C = ConstructorParameters<typeof CheckoutWebhookHandlerService>;
    const svc = new CheckoutWebhookHandlerService(fixture<C[0]>(raw), h.stripe, undefined, undefined, undefined, h.fanout);
    h.stripe.retrievePaymentIntent.mockImplementation(async (id: string) => {
      expect(inside).toBe(false);
      return { id, status: 'requires_payment_method', latest_charge: 'ch_synthetic' };
    });
    await svc.handle(failed());
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'payment_failed', entitlement_active: false });
  });

  it('real failure then successful hosted recovery restores only failure-canceled drops with no second activation/split/notification', async () => {
    const h = harness();
    await seed();
    await activateMarker();
    for (const [id, status, reason] of [
      ['drop_pending', 'pending', null], ['drop_due', 'due', null],
      ['drop_refund', 'canceled', 'canceled:refund'], ['drop_decision', 'canceled', 'canceled:partial_refund_decision'],
      ['drop_fired', 'fired', null],
    ]) {
      await prisma.scheduledDrop.create({ data: {
        id: id!, client_purchase_id: 'purchase', content_id: id!, asset_type: 'pdf', asset_id: 'asset',
        cadence_kind: 'relative_to_purchase', cadence_payload: {}, status: status!, failure_reason: reason,
        fire_at: new Date(0),
      } });
    }
    await deliver(h, failed());
    h.stripe.statusNow = 'succeeded';
    expect(await deliver(h, succeeded())).toMatchObject({ reason: 'payment_recovered', claimed: true });
    const drops = await prisma.scheduledDrop.findMany({ orderBy: { id: 'asc' } });
    expect(drops.map(d => [d.id, d.status, d.failure_reason])).toEqual([
      ['drop_decision', 'canceled', 'canceled:partial_refund_decision'], ['drop_due', 'pending', null],
      ['drop_fired', 'fired', null], ['drop_pending', 'pending', null], ['drop_refund', 'canceled', 'canceled:refund'],
    ]);
    expect(h.entitled).not.toHaveBeenCalled();
    expect(h.first.tryEmitFirstPayment).not.toHaveBeenCalled();
    expect(h.splits.onChargeSucceeded).not.toHaveBeenCalled();
    expect(h.restored).toHaveBeenCalledTimes(1);
    expect(await prisma.purchaseFanout.count()).toBe(1);
    await deliver(h, succeeded('evt_success_2'));
    expect(h.restored).toHaveBeenCalledTimes(1);
  });

  it('restoration failure rolls back the recovery write, then a fresh attempt recovers successfully', async () => {
    const h = harness();
    await seed('payment_failed');
    await activateMarker();
    h.stripe.statusNow = 'succeeded';
    h.restored.mockRejectedValueOnce(new Error('synthetic restoration unavailable'));
    await expect(deliver(h, succeeded())).rejects.toThrow('synthetic restoration unavailable');
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'payment_failed', entitlement_active: false });
    expect((await deliver(h, succeeded())).reason).toBe('payment_recovered');
  });

  it('a committed coach unassign decision during payment failure must remain authoritative after payment recovery', async () => {
    const h = harness();
    await seed();
    await activateMarker();
    await prisma.partialRefundDecision.create({ data: {
      client_purchase_id: 'purchase', stripe_refund_id: 're_synthetic', decision: 'pending',
    } });
    await prisma.scheduledDrop.create({ data: {
      id: 'drop_unassigned', client_purchase_id: 'purchase', content_id: 'content', asset_type: 'pdf',
      asset_id: 'asset', cadence_kind: 'relative_to_purchase', cadence_payload: {}, fire_at: new Date(0),
    } });
    await deliver(h, failed());
    expect(await prisma.scheduledDrop.findUnique({ where: { id: 'drop_unassigned' } })).toMatchObject({
      status: 'canceled', failure_reason: 'canceled:payment_failed',
    });
    type DC = ConstructorParameters<typeof PartialRefundDecisionService>;
    const decisions = new PartialRefundDecisionService(fixture<DC[0]>(prisma), h.fanout);
    const result = await decisions.decide('coach', 're_synthetic', 'unassign_drops');
    expect(result.decision).toBe('unassign_drops');
    expect(await prisma.partialRefundDecision.findUnique({ where: { stripe_refund_id: 're_synthetic' } }))
      .toMatchObject({ decision: 'unassign_drops' });
    h.stripe.statusNow = 'succeeded';
    expect((await deliver(h, succeeded())).reason).toBe('payment_recovered');
    // No mock here: actual decision writer, cancel predicate, restore SQL,
    // and persisted records. Coach's removal is not merely a test annotation.
    expect(await prisma.scheduledDrop.findUnique({ where: { id: 'drop_unassigned' } }))
      .toMatchObject({ status: 'canceled' });
  });

  it('(control) a coach unassign decision before the payment failure remains canceled after recovery', async () => {
    const h = harness();
    await seed();
    await activateMarker();
    await prisma.partialRefundDecision.create({ data: {
      client_purchase_id: 'purchase', stripe_refund_id: 're_synthetic', decision: 'pending',
    } });
    await prisma.scheduledDrop.create({ data: {
      id: 'drop_unassigned', client_purchase_id: 'purchase', content_id: 'content', asset_type: 'pdf',
      asset_id: 'asset', cadence_kind: 'relative_to_purchase', cadence_payload: {}, fire_at: new Date(0),
    } });
    type DC = ConstructorParameters<typeof PartialRefundDecisionService>;
    const decisions = new PartialRefundDecisionService(fixture<DC[0]>(prisma), h.fanout);
    await decisions.decide('coach', 're_synthetic', 'unassign_drops');
    await deliver(h, failed());
    h.stripe.statusNow = 'succeeded';
    await deliver(h, succeeded());
    expect(await prisma.scheduledDrop.findUnique({ where: { id: 'drop_unassigned' } }))
      .toMatchObject({ status: 'canceled', failure_reason: 'canceled:partial_refund_decision' });
  });

  it.each(['refunded', 'canceled', 'expired', 'disputed', 'chargeback_lost'])('a real committed %s wins before the success row lock/read', async terminal => {
    const h = harness();
    await seed('payment_failed', false);
    await other.clientPurchase.update({ where: { id: 'purchase' }, data: { status: terminal, entitlement_active: terminal === 'disputed' } });
    expect((await deliver(h, succeeded())).claimed).toBe(false);
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: terminal, entitlement_active: terminal === 'disputed' });
    expect(h.entitled).not.toHaveBeenCalled();
  });

  it('real concurrent refund blocks on the success lock and becomes authoritative after success commits', async () => {
    const h = harness();
    await seed('payment_failed', false);
    const locked = deferred<void>();
    const release = deferred<void>();
    const successRun = prisma.$transaction(async tx => {
      const result = await h.svc.handle(succeeded(), fixture<Prisma.TransactionClient>(wiring(tx)), {});
      locked.resolve();
      await release.promise;
      return result;
    }, { timeout: 15000 });
    await locked.promise;
    let refundFinished = false;
    const refundRun = other.clientPurchase.update({ where: { id: 'purchase' }, data: { status: 'refunded', entitlement_active: false } })
      .then(row => { refundFinished = true; return row; });
    await new Promise(r => setTimeout(r, 150));
    expect(refundFinished).toBe(false);
    release.resolve();
    expect((await successRun).claimed).toBe(true);
    await refundRun;
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(h.entitled).toHaveBeenCalledTimes(1);
  });

  it('two real simultaneous successful retries activate once', async () => {
    const h = harness();
    await seed('payment_failed', false);
    const results = await Promise.all([deliver(h, succeeded('evt_a')), deliver(h, succeeded('evt_b'))]);
    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(h.entitled).toHaveBeenCalledTimes(1);
    expect(await prisma.purchaseFanout.count()).toBe(1);
  });

  it('never-activated hosted rows still await owning completion; failure after prior activation prevents late reactivation', async () => {
    const h = harness();
    await seed('payment_failed');
    expect((await deliver(h, succeeded())).reason).toBe('checkout_session_activates');
    await activateMarker();
    expect((await deliver(h, completed)).reason).toBe('already_progressed');
    expect(h.entitled).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])('Stripe %s remains retryable with no entitlement write', async code => {
    const h = harness();
    await seed();
    h.stripe.retrievePaymentIntent.mockRejectedValue(new StripeConnectApiError('synthetic-key-canary', code, 'api_key_invalid', 'authentication_error'));
    await expect(deliver(h, failed())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'paid', entitlement_active: true });
  });

  it('a migrated two-row PaymentIntent association must not hide recovery of the activated owning purchase', async () => {
    const h = harness();
    await seed('payment_failed');
    await activateMarker();
    // This is the live two-open-session adoption shape in the candidate's
    // own hosted regression: A owns the session, B was adopted by metadata.
    await prisma.clientPurchase.create({ data: {
      id: 'adopted', client_user_id: 'client', coach_user_id: 'coach', package_id: 'pkg', amount_cents: 10000,
      idempotency_key: 'second-session', stripe_checkout_session_id: 'cs_other', stripe_payment_intent_id: pi,
      status: 'payment_failed', entitlement_active: false,
    } });
    // PostgreSQL is allowed to answer findFirst with either row (no order).
    // Make the legal B-first selection explicit, without changing writes,
    // lock SQL, activation marker, or the owning purchase.
    const wire = wiring(prisma);
    const delegate = { ...wire.clientPurchase, findFirst: jest.fn(async () => prisma.clientPurchase.findUnique({ where: { id: 'adopted' } })) };
    type C = ConstructorParameters<typeof CheckoutWebhookHandlerService>;
    const svc = new CheckoutWebhookHandlerService(
      fixture<C[0]>({ ...wire, clientPurchase: delegate }), h.stripe, undefined, undefined, undefined, h.fanout,
    );
    await prisma.$transaction(tx => svc.handle(succeeded(), fixture<Prisma.TransactionClient>({
      ...wiring(tx), clientPurchase: { ...tx.clientPurchase, findFirst: delegate.findFirst },
    }), {}));
    // Acceptance assertion: real owner is recovered; B remains unentitled.
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'purchase' } })).toMatchObject({ status: 'paid', entitlement_active: true });
    expect(await prisma.clientPurchase.findUnique({ where: { id: 'adopted' } })).toMatchObject({ status: 'payment_failed', entitlement_active: false });
  });
});
