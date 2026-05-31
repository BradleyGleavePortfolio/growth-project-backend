import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { WearableProvider } from '@prisma/client';
import { ConnectionsService } from './connections.service';
import { WearableConnectionStatus } from './types';
import { KmsService } from '../../common/kms/kms.service';
import { randomBytes } from 'crypto';

/**
 * Unit tests for ConnectionsService. All collaborators are mocked so the tests
 * assert real behavior (KMS wrapping, state consumption, IDOR scoping) with
 * real values — no `toBeDefined` placeholders.
 */
describe('ConnectionsService', () => {
  const USER = 'user-1';
  const REDIRECT_BASE = 'https://api.example.com';

  let prisma: any;
  let kms: any;
  let registry: any;
  let oauthState: any;
  let svc: ConnectionsService;

  /** A cloud-OAuth connector double for OURA. */
  function ouraConnector(overrides: Record<string, unknown> = {}) {
    return {
      provider: WearableProvider.OURA,
      authModel: 'oauth2',
      displayName: 'Oura',
      supportsPkce: false,
      buildAuthorizationUrl: jest.fn(
        (redirectUri: string, state: string) =>
          `https://cloud.ouraring.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      ),
      exchangeCode: jest.fn(async () => ({
        refreshToken: 'refresh-XYZ',
        accessToken: 'access-ABC',
        accessTokenExpiresAt: new Date('2026-06-01T00:00:00Z'),
        scopes: ['daily', 'heartrate'],
        externalAccountId: 'oura-acct-9',
      })),
      ...overrides,
    };
  }

  beforeEach(() => {
    process.env.WEARABLES_OAUTH_REDIRECT_BASE_URL = REDIRECT_BASE;
    process.env.NODE_ENV = 'test';

    prisma = {
      wearableConnection: {
        create: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
      },
    };
    kms = {
      encrypt: jest.fn((s: string) => `ENC(${s})`),
      decrypt: jest.fn((s: string) => s),
    };
    registry = {
      has: jest.fn(() => true),
      get: jest.fn(() => ouraConnector()),
    };
    oauthState = {
      issue: jest.fn(async () => ({ state: 'state-123' })),
      consume: jest.fn(async () => ({
        userId: USER,
        provider: WearableProvider.OURA,
        redirectUri: `${REDIRECT_BASE}/v1/wearables/connections/oauth/callback`,
        pkceVerifier: undefined,
      })),
    };
    svc = new ConnectionsService(prisma, kms, registry, oauthState);
  });

  describe('startOauth', () => {
    it('issues state and returns the connector authorization URL', async () => {
      const res = await svc.startOauth(USER, WearableProvider.OURA);
      expect(res.state).toBe('state-123');
      expect(res.authorizationUrl).toContain('cloud.ouraring.com/oauth/authorize');
      expect(res.authorizationUrl).toContain('state=state-123');
      // The callback redirect URI is derived from the configured base.
      expect(oauthState.issue).toHaveBeenCalledWith(
        USER,
        WearableProvider.OURA,
        `${REDIRECT_BASE}/v1/wearables/connections/oauth/callback`,
        { pkce: false },
      );
    });

    it('requests PKCE when the connector supports it', async () => {
      const pkceConnector = ouraConnector({
        provider: WearableProvider.FITBIT,
        supportsPkce: true,
      });
      registry.get.mockReturnValue(pkceConnector);
      oauthState.issue.mockResolvedValue({
        state: 's',
        pkceChallenge: 'challenge-1',
        pkceMethod: 'S256',
      });

      await svc.startOauth(USER, WearableProvider.FITBIT);
      expect(oauthState.issue).toHaveBeenCalledWith(
        USER,
        WearableProvider.FITBIT,
        expect.any(String),
        { pkce: true },
      );
      // The challenge is forwarded into the authorization URL builder.
      expect(pkceConnector.buildAuthorizationUrl).toHaveBeenCalledWith(
        expect.any(String),
        's',
        'challenge-1',
      );
    });

    it('rejects an unregistered provider with 400', async () => {
      registry.has.mockReturnValue(false);
      await expect(svc.startOauth(USER, WearableProvider.WHOOP)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an on-device provider with 400', async () => {
      registry.get.mockReturnValue(
        ouraConnector({ provider: WearableProvider.APPLE_HEALTHKIT, authModel: 'on-device' }),
      );
      await expect(
        svc.startOauth(USER, WearableProvider.APPLE_HEALTHKIT),
      ).rejects.toThrow(/on-device source/);
    });
  });

  describe('handleCallback', () => {
    it('consumes state, exchanges code, KMS-wraps tokens, and creates the connection', async () => {
      const res = await svc.handleCallback({ code: 'auth-code-1', state: 'state-123' });

      expect(res).toEqual({ success: true, provider: WearableProvider.OURA });
      expect(oauthState.consume).toHaveBeenCalledWith('state-123');

      // Both tokens KMS-wrapped before persistence.
      expect(kms.encrypt).toHaveBeenCalledWith('refresh-XYZ');
      expect(kms.encrypt).toHaveBeenCalledWith('access-ABC');

      // No existing row → create path. Lookup is scoped to (user, provider, acct).
      expect(prisma.wearableConnection.findFirst).toHaveBeenCalledWith({
        where: {
          user_id: USER,
          provider: WearableProvider.OURA,
          external_account_id: 'oura-acct-9',
        },
        select: { id: true },
      });
      const createData = prisma.wearableConnection.create.mock.calls[0][0].data;
      expect(createData.encrypted_refresh_token).toBe('ENC(refresh-XYZ)');
      expect(createData.encrypted_access_token).toBe('ENC(access-ABC)');
      expect(createData.user_id).toBe(USER);
      expect(createData.external_account_id).toBe('oura-acct-9');
      expect(createData.scopes).toEqual(['daily', 'heartrate']);
      expect(createData.status).toBe(WearableConnectionStatus.CONNECTED);
      // The persisted token columns are the KMS-WRAPPED values, never raw.
      expect(createData.encrypted_refresh_token).not.toBe('refresh-XYZ');
      expect(createData.encrypted_access_token).not.toBe('access-ABC');
    });

    it('UPDATES (not duplicates) an existing connection on re-link', async () => {
      prisma.wearableConnection.findFirst.mockResolvedValue({ id: 'existing-conn' });
      await svc.handleCallback({ code: 'auth-code-1', state: 'state-123' });
      expect(prisma.wearableConnection.create).not.toHaveBeenCalled();
      const updateArg = prisma.wearableConnection.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'existing-conn' });
      expect(updateArg.data.status).toBe(WearableConnectionStatus.CONNECTED);
      // Re-link clears any prior soft-disconnect/error state.
      expect(updateArg.data.disconnected_at).toBeNull();
      expect(updateArg.data.last_error).toBeNull();
    });

    it('with the REAL KmsService, no plaintext token survives into the upsert', async () => {
      // Configure a real 32-byte AES key so KmsService produces true ciphertext.
      const prevKey = process.env.KMS_MASTER_KEY;
      process.env.KMS_MASTER_KEY = randomBytes(32).toString('base64');
      const realKms = new KmsService();
      realKms.resetForTests();
      const realSvc = new ConnectionsService(prisma, realKms, registry, oauthState);
      try {
        await realSvc.handleCallback({ code: 'auth-code-1', state: 'state-123' });
        const createData = prisma.wearableConnection.create.mock.calls[0][0].data;
        const serialized = JSON.stringify(createData);
        // The ciphertext must not contain the plaintext refresh/access tokens.
        expect(serialized).not.toContain('refresh-XYZ');
        expect(serialized).not.toContain('access-ABC');
        // And the wrapped value round-trips back to the plaintext via decrypt.
        expect(realKms.decrypt(createData.encrypted_refresh_token)).toBe('refresh-XYZ');
        expect(realKms.decrypt(createData.encrypted_access_token)).toBe('access-ABC');
      } finally {
        if (prevKey === undefined) delete process.env.KMS_MASTER_KEY;
        else process.env.KMS_MASTER_KEY = prevKey;
      }
    });

    it('passes the PKCE verifier from state into exchangeCode', async () => {
      const connector = ouraConnector();
      registry.get.mockReturnValue(connector);
      oauthState.consume.mockResolvedValue({
        userId: USER,
        provider: WearableProvider.OURA,
        redirectUri: 'x',
        pkceVerifier: 'verifier-secret',
      });

      await svc.handleCallback({ code: 'auth-code-1', state: 'state-123' });
      expect(connector.exchangeCode).toHaveBeenCalledWith('auth-code-1', 'verifier-secret');
    });

    it('rejects a bad/expired/replayed state BEFORE any exchange', async () => {
      const connector = ouraConnector();
      registry.get.mockReturnValue(connector);
      oauthState.consume.mockRejectedValue(new Error('Invalid or expired OAuth state.'));

      await expect(
        svc.handleCallback({ code: 'auth-code-1', state: 'bad' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Code exchange must NOT run for an invalid state.
      expect(connector.exchangeCode).not.toHaveBeenCalled();
      expect(prisma.wearableConnection.create).not.toHaveBeenCalled();
      expect(prisma.wearableConnection.update).not.toHaveBeenCalled();
    });

    it('surfaces a generic error (no secret leak) when exchange fails', async () => {
      registry.get.mockReturnValue(
        ouraConnector({
          exchangeCode: jest.fn(async () => {
            throw new Error('provider 500 with token=leak');
          }),
        }),
      );
      await expect(
        svc.handleCallback({ code: 'auth-code-1', state: 'state-123' }),
      ).rejects.toThrow(/OAuth code exchange failed/);
    });

    it('NEVER logs the raw connector error message/token material on exchange failure (R1 P1 leak repro)', async () => {
      // Reproduces the R1 auditor's leak class: a connector error whose message
      // embeds token/secret material. The redacted log MUST NOT contain any of
      // those substrings. We spy on EVERY Logger method so a regression that
      // logs the raw message via any level is caught.
      const logSpies = (['error', 'warn', 'log', 'debug', 'verbose'] as const).map(
        (level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      try {
        registry.get.mockReturnValue(
          ouraConnector({
            exchangeCode: jest.fn(async () => {
              throw new Error(
                'provider 500: token=leak123 refresh_token=secret_xyz client_secret=cs_999 code=auth_abc',
              );
            }),
          }),
        );

        await expect(
          svc.handleCallback({ code: 'auth-code-1', state: 'state-123' }),
        ).rejects.toThrow(/OAuth code exchange failed/);

        // Collect every argument passed to every logger call.
        const allCalls = logSpies.flatMap((spy) => spy.mock.calls);
        const serialized = JSON.stringify(allCalls);

        // The crux of the R1 finding: none of the leaked substrings survive.
        expect(serialized.includes('leak123')).toBe(false);
        expect(serialized.includes('secret_xyz')).toBe(false);
        expect(serialized.includes('cs_999')).toBe(false);
        expect(serialized.includes('auth_abc')).toBe(false);
        // Defensive: the raw message must not appear in any form.
        expect(serialized).not.toContain('provider 500: token=leak123');

        // Positive assertion: the sanitized event WAS logged with safe context.
        const errorSpy = logSpies[0];
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const payload = errorSpy.mock.calls[0][0] as Record<string, unknown>;
        expect(payload).toMatchObject({
          msg: 'wearables.oauth.exchange_failure',
          provider: WearableProvider.OURA,
          user_id: USER,
          error_code: 'unknown',
          error_class: 'Error',
        });
        // And the payload itself carries no leaked material.
        expect(JSON.stringify(payload).includes('leak123')).toBe(false);
        expect(JSON.stringify(payload).includes('secret_xyz')).toBe(false);
      } finally {
        logSpies.forEach((spy) => spy.mockRestore());
      }
    });

    it('rejects when the provider returns no refresh token', async () => {
      registry.get.mockReturnValue(
        ouraConnector({ exchangeCode: jest.fn(async () => ({ refreshToken: '' })) }),
      );
      await expect(
        svc.handleCallback({ code: 'auth-code-1', state: 'state-123' }),
      ).rejects.toThrow(/did not return a refresh token/);
    });

    it('stores null access token when the provider omits one', async () => {
      registry.get.mockReturnValue(
        ouraConnector({
          exchangeCode: jest.fn(async () => ({
            refreshToken: 'r-only',
            externalAccountId: 'acct',
          })),
        }),
      );
      await svc.handleCallback({ code: 'c', state: 'state-123' });
      const createData = prisma.wearableConnection.create.mock.calls[0][0].data;
      expect(createData.encrypted_access_token).toBeNull();
      expect(createData.encrypted_refresh_token).toBe('ENC(r-only)');
    });
  });

  describe('list', () => {
    it('scopes the query to the caller and selects the token-free projection', async () => {
      const rows = [
        {
          id: 'c1',
          user_id: USER,
          provider: WearableProvider.OURA,
          status: 'connected',
          scopes: [],
        },
      ];
      prisma.wearableConnection.findMany.mockResolvedValue(rows);

      const res = await svc.list(USER);
      expect(res).toBe(rows);
      const arg = prisma.wearableConnection.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ user_id: USER });
      // The select must exclude every encrypted/secret column.
      expect(arg.select.encrypted_refresh_token).toBeUndefined();
      expect(arg.select.encrypted_access_token).toBeUndefined();
      expect(arg.select.credentials_secret_ref).toBeUndefined();
      expect(arg.select.webhook_secret_ref).toBeUndefined();
      // And it must include the safe columns.
      expect(arg.select.status).toBe(true);
      expect(arg.select.last_synced_at).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('soft-disconnects: clears tokens, sets status + disconnected_at', async () => {
      prisma.wearableConnection.findFirst.mockResolvedValue({
        id: 'conn-1',
        status: 'connected',
      });

      const res = await svc.disconnect(USER, WearableProvider.OURA);
      expect(res).toEqual({ success: true, provider: WearableProvider.OURA });

      // Ownership check scoped to (user_id, provider) — IDOR-safe.
      expect(prisma.wearableConnection.findFirst).toHaveBeenCalledWith({
        where: { user_id: USER, provider: WearableProvider.OURA },
        select: { id: true, status: true },
      });

      const updateArg = prisma.wearableConnection.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: 'conn-1' });
      expect(updateArg.data.status).toBe(WearableConnectionStatus.DISCONNECTED);
      expect(updateArg.data.encrypted_refresh_token).toBeNull();
      expect(updateArg.data.encrypted_access_token).toBeNull();
      expect(updateArg.data.access_token_expires_at).toBeNull();
      expect(updateArg.data.disconnected_at).toBeInstanceOf(Date);
    });

    it('404s when the caller has no connection (no IDOR leak, no update)', async () => {
      prisma.wearableConnection.findFirst.mockResolvedValue(null);
      await expect(
        svc.disconnect(USER, WearableProvider.WHOOP),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.wearableConnection.update).not.toHaveBeenCalled();
    });

    it('only ever updates the row id returned by the user-scoped lookup', async () => {
      // Even if another user's row existed, findFirst is scoped to USER, so the
      // update can only target a row this user owns.
      prisma.wearableConnection.findFirst.mockResolvedValue({
        id: 'owned-by-user-1',
        status: 'connected',
      });
      await svc.disconnect(USER, WearableProvider.OURA);
      expect(prisma.wearableConnection.update.mock.calls[0][0].where).toEqual({
        id: 'owned-by-user-1',
      });
    });
  });
});
