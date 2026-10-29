/**
 * Account deletion reaches the vendors (account-deletion.vendors.ts): each
 * vendor is asked once with the right id; a vendor in use without its erasure
 * keys records not_configured, calls nothing and stays pending with only its
 * retry references (STORE-B3), while a vendor this deployment never used is
 * not_applicable; a failure is recorded and only that vendor (with only what
 * it needs) is left to retry, and a repeat finds nothing (not_found). The orchestration around it (after commit, retried by
 * the nightly cron without re-running the deletion) is in lifecycle-races.
 */
import type { Prisma } from '@prisma/client';
import {
  AccountDeletionVendorsService,
  VENDORS,
  VendorWork,
  heldVendors,
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

/** Every setting that shows a vendor in use or lets it erase. */
const VENDOR_ENV = [...Object.keys(KEYS), 'POSTHOG_KEY', 'POSTHOG_HOST'];

beforeEach(() => {
  for (const name of VENDOR_ENV) delete process.env[name];
  Object.assign(process.env, KEYS);
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

  it('STORE-B3: a vendor in use without its erasure keys stays pending, and the retry erases that same identity once configured', async () => {
    // Collection on (PostHog ingest key, Crisp website id), erasure keys
    // absent, Stripe customers on file but Stripe unconfigured.
    for (const name of Object.keys(KEYS)) delete process.env[name];
    process.env.POSTHOG_KEY = 'phc_ingest';
    process.env.CRISP_WEBSITE_ID = 'site-1';
    const { service, stripe, logger } = setup(false);

    const first = await service.erase(UID, WORK);

    expect(first.outcomes).toEqual({
      posthog: 'not_configured',
      crisp: 'not_configured',
      stripe: 'not_configured',
      resend: 'not_applicable',
      sentry: 'not_applicable',
    });
    // Kept: only what each held vendor needs to find the person.
    expect(first.left).toEqual({
      vendors: ['posthog', 'crisp', 'stripe'],
      email: EMAIL,
      stripe_customer_ids: ['cus_a', 'cus_b'],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    // The operator sees the held work; the line carries no personal data.
    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toContain('vendor erasure held for posthog, crisp, stripe');
    expect(warned).not.toContain(EMAIL);
    expect(warned).not.toContain(UID);
    expect(warned).not.toContain('cus_a');

    // The keys are configured; the next retry erases the same identity.
    Object.assign(process.env, KEYS);
    stripe.isConfigured.mockReturnValue(true);
    const retry = await service.erase(UID, first.left!);

    expect(retry).toEqual({
      outcomes: { posthog: 'done', crisp: 'done', stripe: 'done' },
      left: null,
    });
    const [posthog] = calls();
    expect(posthog.key).toBe('POST https://us.posthog.com/api/projects/42/persons/bulk_delete/');
    expect(JSON.parse(String(posthog.init?.body)).distinct_ids).toEqual([UID]);
    expect(calls().map((c) => c.key)).toContain(
      `DELETE https://api.crisp.chat/v1/website/site-1/people/profile/${encodeURIComponent(EMAIL)}`,
    );
    expect(stripe.deleteCustomer.mock.calls).toEqual([['cus_a'], ['cus_b']]);
  });

  it('STORE-B3: half a key pair still holds the vendor (the project id alone, the token alone)', async () => {
    for (const name of Object.keys(KEYS)) delete process.env[name];
    process.env.POSTHOG_PROJECT_ID = '42';
    process.env.CRISP_API_TOKEN = 'ident:secret';
    const { service } = setup();

    const { outcomes, left } = await service.erase(UID, { ...WORK, vendors: ['posthog', 'crisp'] });

    expect(outcomes).toEqual({ posthog: 'not_configured', crisp: 'not_configured' });
    expect(left).toEqual({ vendors: ['posthog', 'crisp'], email: EMAIL, stripe_customer_ids: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('STORE-B3: a vendor that never collected this account\'s data completes as not applicable', async () => {
    // No PostHog or Crisp setting at all outside production, and no Stripe customer.
    for (const name of Object.keys(KEYS)) delete process.env[name];
    const { service, stripe, logger } = setup(false);

    const { outcomes, left } = await service.erase(UID, { ...WORK, stripe_customer_ids: [] });

    expect(outcomes).toEqual({
      posthog: 'not_applicable',
      crisp: 'not_applicable',
      stripe: 'not_found',
      resend: 'not_applicable',
      sentry: 'not_applicable',
    });
    expect(left).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('STORE-B3: in production PostHog and Crisp count as in use (the app ships with both), so missing keys hold them', async () => {
    for (const name of Object.keys(KEYS)) delete process.env[name];
    process.env.NODE_ENV = 'production';
    const { service } = setup();

    const { outcomes, left } = await service.erase(UID, { ...WORK, vendors: ['posthog', 'crisp'] });

    expect(outcomes).toEqual({ posthog: 'not_configured', crisp: 'not_configured' });
    expect(left?.vendors).toEqual(['posthog', 'crisp']);
  });

  it.each(['staging', 'production'])(
    'LS-1182-B1: %s keeps known pending vendor work after all backend keys are removed',
    async (environment) => {
      process.env.NODE_ENV = environment;
      const { service } = setup();
      answer({
        'POST /api/projects/42/persons/bulk_delete/': () => json(503, {}),
        [`GET /v1/website/site-1/people/conversations/${encodeURIComponent(EMAIL)}/list/1`]:
          () => json(503, {}),
      });
      const work: VendorWork = {
        vendors: ['posthog', 'crisp'],
        email: EMAIL,
        stripe_customer_ids: [],
      };

      // This is existing retry work, not evidence that the vendors were unused.
      const first = await service.erase(UID, work);
      expect(first.outcomes).toEqual({ posthog: 'failed', crisp: 'failed' });
      expect(first.left).toEqual(work);

      // Revoked or unavailable backend keys do not remove either vendor's copy.
      for (const name of VENDOR_ENV) delete process.env[name];
      fetchMock.mockClear();
      const retry = await service.erase(UID, first.left!);

      expect(retry.outcomes).toEqual({
        posthog: 'not_configured',
        crisp: 'not_configured',
      });
      expect(retry.left).toEqual(work);
      expect(fetchMock).not.toHaveBeenCalled();

      Object.assign(process.env, KEYS);
      answer();
      const restored = await service.erase(UID, retry.left!);
      expect(restored).toEqual({
        outcomes: { posthog: 'done', crisp: 'done' },
        left: null,
      });
      expect(JSON.parse(String(calls()[0].init?.body)).distinct_ids).toEqual([UID]);
      expect(calls().map((call) => call.key)).toContain(
        `DELETE https://api.crisp.chat/v1/website/site-1/people/profile/${encodeURIComponent(EMAIL)}`,
      );
    },
  );

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

describe('STORE-B3: startup readiness warning', () => {
  it('warns, never throws, naming the missing keys and never a value', () => {
    for (const name of Object.keys(KEYS)) delete process.env[name];
    process.env.POSTHOG_KEY = 'phc_ingest';
    process.env.CRISP_WEBSITE_ID = 'site-1';
    const { service, logger } = setup();

    expect(heldVendors()).toEqual(['posthog', 'crisp']);
    expect(() => service.onModuleInit()).not.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0][0]);
    expect(line).toContain('posthog (POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID)');
    expect(line).toContain('crisp (CRISP_API_TOKEN)');
    expect(line).not.toContain('phc_ingest');
    expect(line).not.toContain('site-1');
  });

  it('is silent when every vendor in use can erase, or none is in use', () => {
    const { service, logger } = setup();
    expect(heldVendors()).toEqual([]);
    service.onModuleInit();
    for (const name of Object.keys(KEYS)) delete process.env[name];
    expect(heldVendors()).toEqual([]);
    service.onModuleInit();
    expect(logger.warn).not.toHaveBeenCalled();
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
