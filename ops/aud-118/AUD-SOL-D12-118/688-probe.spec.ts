import { Logger } from '@nestjs/common';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// Deterministic public-entry probes. No live Stripe, customer data or production database.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-04T02:30:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86400000);
function seed(fake: FakePrisma, id = 'p1', locked = false) {
  fake.seed('clientPurchase', {
    id, client_user_id: 'client-a', coach_user_id: 'coach-a', status: 'past_due',
    entitlement_active: !locked, billing_type: 'recurring', amount_cents: 15000, currency: 'usd',
    stripe_subscription_id: `sub-${id}`,
  });
  fake.seed('dunningState', {
    id: `ds-${id}`, purchase_id: id, status: 'active', step_index: 3, entered_at: T0,
    locked_out_at: locked ? day(10) : null, client_canceled_at: null,
    last_failure_reason: 'card_declined', last_failed_amount_cents: 15000,
  });
}
function service(fake: FakePrisma, db = fake.client()) {
  return new DunningV2Service(db, stub({ recovered: jest.fn(), lockoutExited: jest.fn() }));
}
describe('AUD-SOL-D12-118 D2 replay and read-model acceptance', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });
  it('control: an old lost obligation does not poison a later payment cycle before replay', async () => {
    const fake = new FakePrisma(); seed(fake);
    fake.seed('dunningDisputeObligation', {
      stripe_dispute_id: 'dp-old', purchase_id: 'p1', stripe_charge_id: 'ch-old',
      status: 'lost', closed_at: day(-30),
    });
    expect(await service(fake).isDisputeCycleOpen('p1')).toBe(false);
  });
  it('redelivery of that same old lost dispute must not convert the later payment cycle', async () => {
    const fake = new FakePrisma(); seed(fake, 'p1', true);
    fake.seed('dunningDisputeObligation', {
      stripe_dispute_id: 'dp-old', purchase_id: 'p1', stripe_charge_id: 'ch-old',
      status: 'lost', closed_at: day(-30),
    });
    fake.seed('connectTransfer', { id: 'tr-old', source_stripe_charge_id: 'ch-old', purchase_id: 'p1' });
    const svc = service(fake);
    expect(await svc.isDisputeCycleOpen('p1')).toBe(false);
    await svc.onDisputeClosed({ chargeId: 'ch-old', disputeId: 'dp-old', status: 'lost', now: day(11) });
    expect(fake.find('dunningDisputeObligation', { stripe_dispute_id: 'dp-old' })?.closed_at).toEqual(day(-30));
    expect(await svc.isDisputeCycleOpen('p1')).toBe(false);
    expect((await svc.applyImmediateClear('p1', 'retry')).liftedLockout).toBe(true);
  });
  function postgresOrderDb(fake: FakePrisma) {
    const db = fake.client();
    const findMany = db.dunningState.findMany;
    db.dunningState.findMany = jest.fn(async (args) => {
      const all = await findMany({ ...args, orderBy: undefined, take: undefined });
      const order = args.orderBy?.[0]?.locked_out_at;
      const direction = typeof order === 'object' ? order.sort : order;
      const nullsFirst = typeof order === 'object' ? order.nulls === 'first' : direction === 'desc';
      all.sort((a, b) => {
        if ((a.locked_out_at == null) !== (b.locked_out_at == null))
          return a.locked_out_at == null ? (nullsFirst ? -1 : 1) : (nullsFirst ? 1 : -1);
        if (a.locked_out_at != null && b.locked_out_at != null)
          return direction === 'desc' ? b.locked_out_at - a.locked_out_at : a.locked_out_at - b.locked_out_at;
        return a.entered_at - b.entered_at;
      });
      return typeof args.take === 'number' ? all.slice(0, args.take) : all;
    });
    return db;
  }
  it('control: fewer than ten unlocked cycles do not hide a locked cycle', async () => {
    const fake = new FakePrisma();
    for (let i = 0; i < 9; i++) seed(fake, `p${i}`);
    seed(fake, 'locked', true);
    expect((await service(fake, postgresOrderDb(fake)).getClientStatus('client-a')).state).toBe('locked');
  });
  it('ten unlocked cycles must not hide a locked cycle under PostgreSQL DESC NULLS FIRST', async () => {
    const fake = new FakePrisma();
    for (let i = 0; i < 10; i++) seed(fake, `p${i}`);
    seed(fake, 'locked', true);
    expect((await service(fake, postgresOrderDb(fake)).getClientStatus('client-a')).state).toBe('locked');
  });
});
