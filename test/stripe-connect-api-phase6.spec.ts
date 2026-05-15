import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

// Test subclass that captures fetch arguments rather than hitting the
// network. Mirrors the pattern used elsewhere in this repo for Stripe
// API services (real-or-flagged: tests never call the real Stripe API).
class TestableStripeConnectApi extends StripeConnectApiService {
  public requests: Array<{ url: string; init?: RequestInit }> = [];
  public responder: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response(JSON.stringify({}), { status: 200 });

  constructor() {
    super();
    (this as any).fetchImpl = async (url: any, init?: any) => {
      this.requests.push({ url: String(url), init });
      return this.responder(String(url), init);
    };
  }
}

describe('StripeConnectApiService Phase 6 methods', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_phase6dummy12345';
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('retrieveBalance scopes the request to a connected account', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(
        JSON.stringify({
          available: [{ amount: 12_345, currency: 'usd' }],
          pending: [],
        }),
        { status: 200 },
      );
    const result = await svc.retrieveBalance('acct_test_1');
    expect(svc.requests).toHaveLength(1);
    const req = svc.requests[0];
    expect(req.url).toContain('/balance');
    expect((req.init?.headers as any)['Stripe-Account']).toBe('acct_test_1');
    expect(result.available[0].amount).toBe(12_345);
  });

  it('listPayouts passes limit + status as query params', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    await svc.listPayouts({
      connectedAccountId: 'acct_test_2',
      limit: 5,
      status: 'in_transit',
    });
    expect(svc.requests[0].url).toContain('limit=5');
    expect(svc.requests[0].url).toContain('status=in_transit');
  });

  it('listBalanceTransactions filters by type', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });
    await svc.listBalanceTransactions({
      connectedAccountId: 'acct_test_3',
      type: 'charge',
    });
    expect(svc.requests[0].url).toContain('type=charge');
  });

  it('createRefund sets reverse_transfer + refund_application_fee by default', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(
        JSON.stringify({ id: 'rf_abc', amount: 500, status: 'succeeded' }),
        { status: 200 },
      );
    await svc.createRefund({
      charge_id: 'ch_xyz',
      amount: 500,
      idempotencyKey: 'tgp-refund-test',
    });
    const body = svc.requests[0].init?.body as string;
    expect(body).toContain('charge=ch_xyz');
    expect(body).toContain('reverse_transfer=true');
    expect(body).toContain('refund_application_fee=true');
    expect((svc.requests[0].init?.headers as any)['Idempotency-Key']).toBe(
      'tgp-refund-test',
    );
  });

  it('retrieveDispute hits the disputes endpoint', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(JSON.stringify({ id: 'dp_1', status: 'won' }), { status: 200 });
    const result = await svc.retrieveDispute('dp_1');
    expect(svc.requests[0].url).toContain('/disputes/dp_1');
    expect(result.status).toBe('won');
  });

  it('throws StripeConnectApiError on a Stripe error envelope', async () => {
    const svc = new TestableStripeConnectApi();
    svc.responder = async () =>
      new Response(
        JSON.stringify({
          error: { message: 'No such charge', code: 'resource_missing', type: 'invalid_request_error' },
        }),
        { status: 404 },
      );
    await expect(svc.retrieveRefund('rf_missing')).rejects.toMatchObject({
      message: 'No such charge',
    });
  });
});
