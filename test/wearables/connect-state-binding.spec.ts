import { BadRequestException } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { ConnectionsService } from '../../src/wearables/connections/connections.service';
import {
  InMemoryOauthStateStore,
  OAUTH_STATE_TTL_MS,
  OauthStateService,
} from '../../src/wearables/oauth/oauth-state.service';

/**
 * A6 (AUTHB-05) discovery — the REAL state service wired into the REAL
 * connections service: a connect link started by person A can only ever
 * attach a connection to A, once, within the TTL.
 */
describe('Wearable connect state binding (A6 / AUTHB-05)', () => {
  const A = 'user-a';
  const B = 'user-b';
  let prisma: any;
  let connector: any;
  let svc: ConnectionsService;

  beforeEach(() => {
    process.env.WEARABLES_OAUTH_REDIRECT_BASE_URL = 'https://api.example.com';
    prisma = {
      wearableConnection: {
        create: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
      },
    };
    connector = {
      provider: WearableProvider.OURA,
      authModel: 'oauth2',
      supportsPkce: false,
      buildAuthorizationUrl: jest.fn(
        (_r: string, state: string) => `https://provider.example/authorize?state=${state}`,
      ),
      exchangeCode: jest.fn(async () => ({
        refreshToken: 'r',
        accessToken: 'a',
        externalAccountId: 'acct-1',
      })),
    };
    const registry: any = { has: () => true, get: () => connector };
    const kms: any = { encrypt: (s: string) => `ENC(${s})` };
    svc = new ConnectionsService(
      prisma,
      kms,
      registry,
      new OauthStateService(new InMemoryOauthStateStore()),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('mints a random 256-bit state per start', async () => {
    const one = await svc.startOauth(A, WearableProvider.OURA);
    const two = await svc.startOauth(A, WearableProvider.OURA);
    expect(one.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one.state).not.toBe(two.state);
  });

  it("attaches A's link only to A and B's link only to B", async () => {
    const a = await svc.startOauth(A, WearableProvider.OURA);
    const b = await svc.startOauth(B, WearableProvider.OURA);
    await svc.handleCallback({ code: 'code-b', state: b.state });
    await svc.handleCallback({ code: 'code-a', state: a.state });
    const owners = prisma.wearableConnection.create.mock.calls.map(
      (c: any[]) => c[0].data.user_id,
    );
    expect(owners).toEqual([B, A]);
  });

  it('rejects a replayed callback before any token exchange', async () => {
    const a = await svc.startOauth(A, WearableProvider.OURA);
    await svc.handleCallback({ code: 'code-1', state: a.state });
    await expect(
      svc.handleCallback({ code: 'code-2', state: a.state }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(connector.exchangeCode).toHaveBeenCalledTimes(1);
    expect(prisma.wearableConnection.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a link used after the 10-minute window', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    const a = await svc.startOauth(A, WearableProvider.OURA);
    jest.setSystemTime(Date.now() + OAUTH_STATE_TTL_MS + 1);
    await expect(
      svc.handleCallback({ code: 'code-1', state: a.state }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(connector.exchangeCode).not.toHaveBeenCalled();
  });

  it('rejects a made-up state', async () => {
    await expect(
      svc.handleCallback({ code: 'code-1', state: 'x'.repeat(43) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(connector.exchangeCode).not.toHaveBeenCalled();
  });
});
