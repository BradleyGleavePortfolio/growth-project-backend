/**
 * Account deletion reaches the vendors (account-deletion.vendors.ts): each
 * vendor is asked once with the right id, an unset key records
 * not_configured and calls nothing, a failure is recorded and only that
 * vendor (with only what it needs) is left to retry, and a repeat finds
 * nothing (not_found). The orchestration around it (after commit, retried by
 * the nightly cron without re-running the deletion) is in lifecycle-races.
 */
import type { Prisma } from '@prisma/client';
import {
  AccountDeletionVendorsService,
  VENDORS,
  VendorWork,
} from '../../src/account-deletion/account-deletion.vendors';
import {
  StripeConnectApiError,
  type StripeConnectApiService,
} from '../../src/connect/stripe-connect-api.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const UID = '3f0c7a52-6a51-4c55-9a0e-0c9d6f1b2a10';
const EMAIL = 'person+tag@example.com';
const WORK: VendorWork = {
  vendors: [...VENDORS],
  email: EMAIL,
  stripe_customer_ids: ['cus_a', 'cus_b'],
};
const KEYS = {
  POSTHOG_PERSONAL_API_KEY: 'phx_test',
  POSTHOG_PROJECT_ID: '42',
  CRISP_WEBSITE_ID: 'site-1',
  CRISP_API_TOKEN: 'ident:secret',
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let fetchMock: jest.SpyInstance;
const savedEnv = { ...process.env };

/** Vendor answers by "METHOD path"; anything unlisted is a successful delete. */
function answer(overrides: Record<string, () => Response> = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    if (overrides[key]) return overrides[key]();
    if (key.endsWith('/bulk_delete/')) {
      return json(202, { persons_found: 1, persons_queued_for_deletion: 1, deletion_errors: [] });
    }
    if (key.endsWith('/list/1')) return json(200, { error: false, data: ['session_1'] });
    if (key.includes('/list/')) return json(200, { error: false, data: [] });
    return json(200, { error: false, reason: 'deleted' });
  });
}

function setup(stripeConfigured = true) {
  const stripe = {
    isConfigured: jest.fn(() => stripeConfigured),
    deleteCustomer: jest.fn(async (id: string) => ({ id, deleted: true })),
  };
  const service = new AccountDeletionVendorsService(stub<StripeConnectApiService>(stripe));
  const logger = { warn: jest.fn() };
  Object.assign(service, { logger });
  return { service, stripe, logger };
}

const calls = () =>
  fetchMock.mock.calls.map(([input, init]: [string, RequestInit | undefined]) => ({
    key: `${init?.method ?? 'GET'} ${String(input)}`,
    init,
  }));

beforeEach(() => {
  Object.assign(process.env, KEYS);
  delete process.env.POSTHOG_HOST;
  fetchMock = jest.spyOn(global, 'fetch');
  answer();
});

afterEach(() => {
  fetchMock.mockRestore();
  process.env = { ...savedEnv };
});

describe('AccountDeletionVendorsService.erase', () => {
  it('asks each vendor once with the right id', async () => {
    const { service, stripe } = setup();
    const result = await service.erase(UID, WORK);

    expect(result).toEqual({
      outcomes: {
        posthog: 'done',
        crisp: 'done',
        stripe: 'done',
        resend: 'not_applicable',
        sentry: 'not_applicable',
      },
      left: null,
    });
    const crisp = 'https://api.crisp.chat/v1/website/site-1';
    const people = encodeURIComponent(EMAIL);
    expect(calls().map((c) => c.key)).toEqual([
      'POST https://us.posthog.com/api/projects/42/persons/bulk_delete/',
      `GET ${crisp}/people/conversations/${people}/list/1`,
      `GET ${crisp}/people/conversations/${people}/list/2`,
      `DELETE ${crisp}/conversation/session_1`,
      `DELETE ${crisp}/people/profile/${people}`,
    ]);
    const [posthog, crispList] = calls();
    expect(posthog.init?.headers).toEqual({
      Authorization: 'Bearer phx_test',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(posthog.init?.body))).toEqual({
      distinct_ids: [UID],
      delete_events: true,
    });
    expect(crispList.init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from('ident:secret').toString('base64')}`,
      'X-Crisp-Tier': 'website',
    });
    expect(stripe.deleteCustomer.mock.calls).toEqual([['cus_a'], ['cus_b']]);
  });

  it('an unset key records not_configured and calls nothing', async () => {
    for (const name of Object.keys(KEYS)) delete process.env[name];
    const { service, stripe } = setup(false);

    const { outcomes, left } = await service.erase(UID, WORK);

    expect(outcomes).toMatchObject({
      posthog: 'not_configured',
      crisp: 'not_configured',
      stripe: 'not_configured',
    });
    expect(left).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
  });

  it('records a failure and leaves only that vendor, with only what it needs, to retry', async () => {
    const { service, stripe, logger } = setup();
    answer({ 'POST /api/projects/42/persons/bulk_delete/': () => json(503, {}) });
    stripe.deleteCustomer.mockRejectedValueOnce(
      // Vendor error text can echo the email; the log must never print it.
      new StripeConnectApiError(`No such customer for ${EMAIL}`, 500, null, 'api_error'),
    );

    const first = await service.erase(UID, WORK);

    expect(first.outcomes).toMatchObject({ posthog: 'failed', crisp: 'done', stripe: 'failed' });
    expect(first.left).toEqual({
      vendors: ['posthog', 'stripe'],
      email: null,
      stripe_customer_ids: ['cus_a', 'cus_b'],
    });
    // Only the vendor, the error class and the HTTP status reach the log.
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('posthog erasure failed');
    expect(logged).toContain('error=Error status=503');
    expect(logged).toContain('stripe erasure failed');
    expect(logged).toContain('error=StripeConnectApiError');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('No such customer');
    expect(logged).not.toContain('answered');

    // The retry calls only what is left; Crisp is not asked again.
    fetchMock.mockClear();
    stripe.deleteCustomer.mockClear();
    answer();
    const retry = await service.erase(UID, first.left!);
    expect(retry).toEqual({ outcomes: { posthog: 'done', stripe: 'done' }, left: null });
    expect(calls().map((c) => c.key)).toEqual([
      'POST https://us.posthog.com/api/projects/42/persons/bulk_delete/',
    ]);
    expect(stripe.deleteCustomer).toHaveBeenCalledTimes(2);
  });

  it('a vendor that reports deletion errors counts as failed', async () => {
    const { service } = setup();
    answer({
      'POST /api/projects/42/persons/bulk_delete/': () =>
        json(202, { persons_found: 1, deletion_errors: [{ distinct_id: UID }] }),
    });
    const { outcomes } = await service.erase(UID, { ...WORK, vendors: ['posthog'] });
    expect(outcomes).toEqual({ posthog: 'failed' });
  });

  it('a person the vendors no longer have is not_found, so a repeat is harmless', async () => {
    const { service, stripe } = setup();
    answer({
      'POST /api/projects/42/persons/bulk_delete/': () =>
        json(202, { persons_found: 0, deletion_errors: [] }),
      [`GET /v1/website/site-1/people/conversations/${encodeURIComponent(EMAIL)}/list/1`]: () =>
        json(404, { error: true, reason: 'not_found' }),
      [`DELETE /v1/website/site-1/people/profile/${encodeURIComponent(EMAIL)}`]: () =>
        json(404, { error: true, reason: 'not_found' }),
    });
    stripe.deleteCustomer.mockRejectedValue(
      new StripeConnectApiError(
        'No such customer',
        404,
        'resource_missing',
        'invalid_request_error',
      ),
    );

    const { outcomes, left } = await service.erase(UID, WORK);

    expect(outcomes).toMatchObject({
      posthog: 'not_found',
      crisp: 'not_found',
      stripe: 'not_found',
    });
    expect(left).toBeNull();
  });
});

describe('AccountDeletionVendorsService.collect', () => {
  it("collects the person's own Stripe customers only, deduplicated", async () => {
    const rows = (...ids: Array<string | null>) =>
      jest.fn(async () => ids.map((stripe_customer_id) => ({ stripe_customer_id })));
    const tx = {
      connectCustomer: { findMany: rows('cus_client') },
      coachProfile: { findMany: rows('cus_coach') },
      coachSubscription: { findMany: rows('cus_coach', null) },
      clientPurchase: { findMany: rows('cus_client') },
      guestCheckout: { findMany: rows('cus_guest') },
    };
    const { service } = setup();

    const work = await service.collect(stub<Prisma.TransactionClient>(tx), UID, EMAIL);

    expect(work).toEqual({
      vendors: [...VENDORS],
      email: EMAIL,
      stripe_customer_ids: ['cus_client', 'cus_coach', 'cus_guest'],
    });
    // A coach's sales are their clients' customers and are never collected.
    expect(tx.clientPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { client_user_id: UID } }),
    );
    expect(tx.guestCheckout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ created_user_id: UID }, { guest_email: EMAIL }] },
      }),
    );
  });
});
