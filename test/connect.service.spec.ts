import { ConnectService } from '../src/connect/connect.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';

// Override fetchImpl so we never reach the network.
class FakeStripeConnect extends StripeConnectApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override fetchImpl: any = jest.fn();
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makePrismaStub() {
  const accounts: any[] = [];
  const users: any[] = [
    { id: 'coach-1', email: 'coach1@example.com' },
    { id: 'coach-2', email: 'coach2@example.com' },
  ];
  return {
    _accounts: accounts,
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
      ),
    },
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) =>
        accounts.find((a) =>
          Object.entries(where).every(([k, v]) => (a as any)[k] === v),
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'ca-' + (accounts.length + 1),
          country: 'US',
          default_currency: 'usd',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          requirements_due: null,
          disabled_reason: null,
          deauthorized_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        accounts.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = accounts.find((a) =>
          Object.entries(where).every(([k, v]) => (a as any)[k] === v),
        );
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
    },
  };
}

describe('ConnectService', () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    process.env.STRIPE_CONNECT_REFRESH_URL = 'growthproject://connect/refresh';
    process.env.STRIPE_CONNECT_RETURN_URL = 'growthproject://connect/return';
  });
  afterEach(() => {
    for (const k of [
      'STRIPE_SECRET_KEY',
      'STRIPE_CONNECT_REFRESH_URL',
      'STRIPE_CONNECT_RETURN_URL',
    ]) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  });

  it('creates a fresh ConnectAccount when none exists', async () => {
    const prisma = makePrismaStub();
    const stripe = new FakeStripeConnect();
    stripe.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'acct_abc',
        country: 'US',
        default_currency: 'usd',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: { currently_due: ['external_account'] },
      }),
    );
    const svc = new ConnectService(prisma as any, stripe);
    const out = await svc.createAccountForCoach('coach-1');
    expect(out.stripe_account_id).toBe('acct_abc');
    expect(out.is_fully_onboarded).toBe(false);
    expect(prisma._accounts).toHaveLength(1);

    // Verify Stripe was called with the Express type + capabilities form.
    const [url, init] = stripe.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/accounts');
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('type')).toBe('express');
    expect(form.get('country')).toBe('US');
    expect(form.get('capabilities[card_payments][requested]')).toBe('true');
    expect(form.get('capabilities[transfers][requested]')).toBe('true');
    expect(form.get('metadata[tgp_coach_user_id]')).toBe('coach-1');
    expect(init.headers['Idempotency-Key']).toBe('connect-account-coach-1');
  });

  it('createAccountForCoach is idempotent — returns existing row', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_xyz',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const stripe = new FakeStripeConnect();
    const svc = new ConnectService(prisma as any, stripe);
    const out = await svc.createAccountForCoach('coach-1');
    expect(out.stripe_account_id).toBe('acct_xyz');
    expect(out.is_fully_onboarded).toBe(true);
    // No Stripe call should have been made.
    expect(stripe.fetchImpl).not.toHaveBeenCalled();
  });

  it('createOnboardingLink mints an account_links with both URLs', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const stripe = new FakeStripeConnect();
    stripe.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        object: 'account_link',
        url: 'https://connect.stripe.com/setup/c/abc',
        expires_at: 1764554400,
        created: 1764553800,
      }),
    );
    const svc = new ConnectService(prisma as any, stripe);
    const link = await svc.createOnboardingLink('coach-1');
    expect(link.url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(link.expires_at).toBe(1764554400);
    const [, init] = stripe.fetchImpl.mock.calls[0];
    const form = new URLSearchParams(init.body as string);
    expect(form.get('account')).toBe('acct_abc');
    expect(form.get('type')).toBe('account_onboarding');
    expect(form.get('refresh_url')).toBe('growthproject://connect/refresh');
    expect(form.get('return_url')).toBe('growthproject://connect/return');
  });

  it('createOnboardingLink fails 503 when refresh URL env is unset', async () => {
    delete process.env.STRIPE_CONNECT_REFRESH_URL;
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const svc = new ConnectService(prisma as any, new FakeStripeConnect());
    await expect(svc.createOnboardingLink('coach-1')).rejects.toThrow(
      /STRIPE_CONNECT_REFRESH_URL is unset/,
    );
  });

  it('createDashboardLoginLink rejects with 409 until onboarded', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const svc = new ConnectService(prisma as any, new FakeStripeConnect());
    await expect(svc.createDashboardLoginLink('coach-1')).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it('createDashboardLoginLink returns the Stripe login URL once onboarded', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const stripe = new FakeStripeConnect();
    stripe.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        object: 'login_link',
        url: 'https://connect.stripe.com/express/abc',
        created: 1764554400,
      }),
    );
    const svc = new ConnectService(prisma as any, stripe);
    const out = await svc.createDashboardLoginLink('coach-1');
    expect(out.url).toMatch(/^https:\/\/connect\.stripe\.com\/express\//);
  });

  it('syncFromStripe pulls latest state and updates mirror', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const stripe = new FakeStripeConnect();
    stripe.fetchImpl.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'acct_abc',
        country: 'US',
        default_currency: 'usd',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      }),
    );
    const svc = new ConnectService(prisma as any, stripe);
    const updated = await svc.syncFromStripe('acct_abc');
    expect(updated?.charges_enabled).toBe(true);
    expect(updated?.payouts_enabled).toBe(true);
    expect(updated?.details_submitted).toBe(true);
  });

  it('syncFromStripe no-ops when the account is unknown', async () => {
    const prisma = makePrismaStub();
    const stripe = new FakeStripeConnect();
    const svc = new ConnectService(prisma as any, stripe);
    const result = await svc.syncFromStripe('acct_missing');
    expect(result).toBeNull();
    expect(stripe.fetchImpl).not.toHaveBeenCalled();
  });

  it('markDeauthorized clears capabilities and stamps deauthorized_at', async () => {
    const prisma = makePrismaStub();
    prisma._accounts.push({
      id: 'ca-1',
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_abc',
      country: 'US',
      default_currency: 'usd',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements_due: null,
      disabled_reason: null,
      deauthorized_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const svc = new ConnectService(prisma as any, new FakeStripeConnect());
    await svc.markDeauthorized('acct_abc');
    expect(prisma._accounts[0].deauthorized_at).toBeInstanceOf(Date);
    expect(prisma._accounts[0].charges_enabled).toBe(false);
    expect(prisma._accounts[0].payouts_enabled).toBe(false);
  });

  it('propagates Stripe errors as StripeConnectApiError', async () => {
    const prisma = makePrismaStub();
    const stripe = new FakeStripeConnect();
    stripe.fetchImpl.mockResolvedValueOnce(
      jsonResponse(402, {
        error: {
          message: 'Connect not enabled on this account',
          code: 'account_invalid',
          type: 'invalid_request_error',
        },
      }),
    );
    const svc = new ConnectService(prisma as any, stripe);
    await expect(svc.createAccountForCoach('coach-1')).rejects.toBeInstanceOf(
      StripeConnectApiError,
    );
  });
});

describe('StripeConnectApiService.requireSecret', () => {
  const ORIGINAL = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL;
  });

  it('throws when STRIPE_SECRET_KEY is unset', () => {
    delete process.env.STRIPE_SECRET_KEY;
    const svc = new StripeConnectApiService();
    expect(() => svc.requireSecret()).toThrow(/STRIPE_SECRET_KEY is unset/);
  });

  it('throws when STRIPE_SECRET_KEY has the wrong shape', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_test_clearly_a_pub_key';
    const svc = new StripeConnectApiService();
    expect(() => svc.requireSecret()).toThrow(
      /does not look like a Stripe secret key/,
    );
  });

  it('accepts sk_test_* and sk_live_* keys', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    expect(() => new StripeConnectApiService().requireSecret()).not.toThrow();
    process.env.STRIPE_SECRET_KEY = 'sk_live_xyz';
    expect(() => new StripeConnectApiService().requireSecret()).not.toThrow();
  });
});
