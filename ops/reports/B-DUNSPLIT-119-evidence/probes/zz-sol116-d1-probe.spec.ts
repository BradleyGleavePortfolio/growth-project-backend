import { effectiveLock } from '../src/checkout/dunning-v2/dunning-effective-access';
import { StripeConnectApiError, StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

const NOW = new Date('2026-10-04T02:30:00.000Z');

function accessFixture(blockedCount: number) {
  const fake = new FakePrisma();
  fake.seed('clientPurchase', { id: 'debt', client_user_id: 'client-a' });
  fake.seed('dunningState', {
    id: 'ds-debt', purchase_id: 'debt', status: 'active', locked_out_at: NOW,
  });
  for (let i = 0; i < blockedCount; i++) {
    fake.seed('clientPurchase', {
      id: `blocked-${i}`, client_user_id: 'client-a',
      entitlement_active: true, status: 'active', access_expires_at: null,
    });
    fake.seed('dunningState', {
      id: `ds-blocked-${i}`, purchase_id: `blocked-${i}`, status: 'active', locked_out_at: NOW,
    });
  }
  fake.seed('clientPurchase', {
    id: 'free-grant', client_user_id: 'client-a', entitlement_active: true,
    status: 'paid', access_expires_at: null, amount_cents: 0,
  });
  return fake;
}

class Adapter extends StripeConnectApiService {
  constructor(replayed: boolean) {
    super();
    this.fetchImpl = async () => new Response(JSON.stringify({
      error: { type: 'invalid_request_error', code: 'parameter_unknown', message: 'synthetic refusal' },
    }), { status: 400, headers: replayed ? { 'Idempotent-Replayed': 'true' } : {} });
  }
}

describe('AUD-SOL-D12-116 D1 acceptance probes', () => {
  it('control: a grant within the first page waives a lock', async () => {
    expect(await effectiveLock(accessFixture(19).client(), 'client-a', NOW))
      .toMatchObject({ waived: true, locked: false });
  });

  it('a valid live grant after 20 non-waiving rows must still waive the lock', async () => {
    expect(await effectiveLock(accessFixture(20).client(), 'client-a', NOW))
      .toMatchObject({ waived: true, locked: false });
  });

  it.each([true, false])('control: adapter preserves operation-replay receipt %s', async (replayed) => {
    const old = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic';
    try {
      const error = await new Adapter(replayed).payInvoice({
        invoiceId: 'in_synthetic', paymentMethodId: 'pm_synthetic', idempotencyKey: 'synthetic',
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StripeConnectApiError);
      expect(error).toMatchObject({ httpStatus: 400, idempotentReplayed: replayed });
    } finally {
      if (old === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = old;
    }
  });
});
