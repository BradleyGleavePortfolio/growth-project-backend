// B-676-2 (B-CM1-116): a failed Connect refresh logs a closed code and error
// class only, in CoachConnectService.refreshStatus and in the
// ConnectService.syncFromStripe sink it delegates to. At 564f33bf both logged
// the exception / Stripe message (free text) verbatim.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';
import { ConnectService } from '../src/connect/connect.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';

const CANARY = 'PRIVATE_CANARY_client_at_example_invalid';

describe('B-676-2 — Connect refresh failures log closed codes only', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  afterAll(() => warn.mockRestore());
  const logged = () => JSON.stringify(warn.mock.calls);
  const account = { stripe_account_id: 'acct_1', updated_at: new Date(0) };

  it.each([
    ['Error', new Error(CANARY), 'class=other'],
    ['Stripe error', new StripeConnectApiError(CANARY, 500, CANARY, CANARY), 'class=stripe'],
  ])('refreshStatus: %s', async (_name, err, cls) => {
    warn.mockClear();
    const prisma = { connectAccount: { findUnique: jest.fn(async () => account) } };
    const connect = { syncFromStripe: jest.fn(async () => Promise.reject(err)) };
    const stripe = { isConfigured: () => true };
    const svc: CoachConnectService = Reflect.construct(CoachConnectService, [
      prisma,
      connect,
      stripe,
    ]);
    Reflect.set(svc, 'getStatus', async () => ({}));
    await expect(svc.refreshStatus('coach-1')).resolves.toMatchObject({ refreshed: false });
    expect(logged()).toContain(`code=CONNECT_REFRESH_FAILED ${cls}`);
    expect(logged()).not.toContain(CANARY);
  });

  it('syncFromStripe: a Stripe rejection keeps the mirror and logs no Stripe text', async () => {
    warn.mockClear();
    const prisma = { connectAccount: { findUnique: jest.fn(async () => account) } };
    const stripe = {
      retrieveAccount: jest.fn(async () =>
        Promise.reject(new StripeConnectApiError(CANARY, 404, CANARY, CANARY)),
      ),
    };
    const svc: ConnectService = Reflect.construct(ConnectService, [prisma, stripe]);
    await expect(svc.syncFromStripe('acct_1')).resolves.toBe(account);
    expect(logged()).toContain('code=CONNECT_ACCOUNT_RETRIEVE_FAILED status=404');
    expect(logged()).not.toContain(CANARY);
  });
});
