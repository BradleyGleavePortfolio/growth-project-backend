import { WearableConnection, WearableProvider } from '@prisma/client';
import { KmsService } from '../../../../src/common/kms/kms.service';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../../../src/wearables/http/provider-http-client';
import { GarminConnector } from '../../../../src/wearables/connectors/garmin/garmin.connector';
import { GARMIN_PUSH_TOKEN_HEADER } from '../../../../src/wearables/connectors/garmin/garmin.types';

const PUSH_TOKEN = 'garmin-push-token-abc';

function makeClient(fetchFn: jest.Mock): ProviderHttpClient {
  return new ProviderHttpClient({
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    random: () => 1,
  });
}

/**
 * KMS test double: `decrypt` strips an `enc:` prefix and `encrypt` adds it, so
 * specs assert the connector UNWRAPS stored tokens before Garmin calls AND
 * RE-WRAPS rotated tokens before returning a TokenSet.
 */
function makeKms(): KmsService & { decrypt: jest.Mock; encrypt: jest.Mock } {
  const decrypt = jest.fn((ct: string) =>
    ct.startsWith('enc:') ? ct.slice(4) : ct,
  );
  const encrypt = jest.fn((pt: string) => `enc:${pt}`);
  return { decrypt, encrypt } as unknown as KmsService & {
    decrypt: jest.Mock;
    encrypt: jest.Mock;
  };
}

function makeConnector(fetchFn: jest.Mock) {
  const kms = makeKms();
  const connector = new GarminConnector(makeClient(fetchFn), kms);
  return { connector, kms };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function conn(overrides: Partial<WearableConnection> = {}): WearableConnection {
  return {
    id: 'conn-1',
    user_id: 'user-1',
    provider: WearableProvider.GARMIN,
    external_account_id: 'garmin-99',
    credentials_secret_ref: null,
    encrypted_refresh_token: 'enc:refresh-token-1',
    encrypted_access_token: null,
    access_token_expires_at: null,
    scopes: [],
    webhook_subscription_id: null,
    webhook_secret_ref: null,
    channel_expires_at: null,
    status: 'connected',
    last_error: null,
    last_synced_at: null,
    backfilled_until: null,
    disconnected_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as WearableConnection;
}

describe('GarminConnector', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.GARMIN_CLIENT_ID = 'client-123';
    process.env.GARMIN_CLIENT_SECRET = 'client-secret';
    process.env.GARMIN_REDIRECT_URI = 'https://app.example.com/oauth/garmin';
    process.env.GARMIN_PUSH_TOKEN = PUSH_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  describe('identity', () => {
    it('exposes provider=GARMIN and authModel=oauth2', () => {
      const { connector } = makeConnector(jest.fn());
      expect(connector.provider).toBe(WearableProvider.GARMIN);
      expect(connector.authModel).toBe('oauth2');
    });
  });

  describe('buildAuthUrl', () => {
    it('builds the Garmin auth URL with all scopes and the state round-trip', () => {
      const { connector } = makeConnector(jest.fn());
      const url = connector.buildAuthUrl('user-1', 'state-xyz');
      expect(url).not.toBeNull();
      const u = url as string;
      expect(u).toContain('https://connect.garmin.com/oauth2Confirm');
      expect(u).toContain('response_type=code');
      expect(u).toContain('client_id=client-123');
      expect(u).toContain('state=state-xyz');
      const decoded = decodeURIComponent(u);
      for (const scope of ['activities', 'dailies', 'sleeps', 'hrv', 'bodyComps']) {
        expect(decoded).toContain(scope);
      }
    });

    it('fails loud (configuration error) when GARMIN_CLIENT_ID is missing', () => {
      // Fail-loud parity with the other six OAuth2 connectors: a blank client
      // id must raise a clean server-side error, never emit a malformed auth
      // URL with an empty client_id.
      delete process.env.GARMIN_CLIENT_ID;
      const { connector } = makeConnector(jest.fn());
      expect(() => connector.buildAuthUrl('user-1', 'state-xyz')).toThrow(
        /GARMIN_CLIENT_ID/,
      );
    });

    it('fails loud when GARMIN_REDIRECT_URI is missing', () => {
      delete process.env.GARMIN_REDIRECT_URI;
      const { connector } = makeConnector(jest.fn());
      expect(() => connector.buildAuthUrl('user-1', 'state-xyz')).toThrow(
        /GARMIN_REDIRECT_URI/,
      );
    });
  });

  describe('exchangeCode', () => {
    it('exchanges a code and KMS-wraps the returned tokens', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'dailies sleeps',
          user_id: 'garmin-99',
        }),
      );
      const { connector, kms } = makeConnector(fetchFn);
      const tokens = await connector.exchangeCode('auth-code');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Tokens returned WRAPPED (enc: prefix from the kms double).
      expect(tokens.refreshToken).toBe('enc:refresh-1');
      expect(tokens.accessToken).toBe('enc:access-1');
      expect(kms.encrypt).toHaveBeenCalledWith('refresh-1');
      expect(kms.encrypt).toHaveBeenCalledWith('access-1');
      expect(tokens.externalAccountId).toBe('garmin-99');
      expect(tokens.scopes).toEqual(['dailies', 'sleeps']);
      expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
    });

    it('throws (fail-loud) when the token response omits a refresh token', async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValue(jsonResponse({ access_token: 'access-only' }));
      const { connector } = makeConnector(fetchFn);
      await expect(connector.exchangeCode('auth-code')).rejects.toThrow(
        /missing refresh_token/,
      );
    });
  });

  describe('refresh', () => {
    it('unwraps the stored refresh token, rotates, and re-wraps the new tokens', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
      );
      const { connector, kms } = makeConnector(fetchFn);
      const tokens = await connector.refresh(conn());

      // Unwrapped the stored token before calling Garmin.
      expect(kms.decrypt).toHaveBeenCalledWith('enc:refresh-token-1');
      const sentBody = String(fetchFn.mock.calls[0][1].body);
      expect(sentBody).toContain('grant_type=refresh_token');
      expect(sentBody).toContain('refresh_token=refresh-token-1');
      // Re-wrapped the rotated tokens.
      expect(tokens.refreshToken).toBe('enc:refresh-2');
      expect(tokens.accessToken).toBe('enc:access-2');
    });

    it('throws when the connection has no refresh token (re-consent required)', async () => {
      const { connector } = makeConnector(jest.fn());
      await expect(
        connector.refresh(conn({ encrypted_refresh_token: null })),
      ).rejects.toThrow(/no refresh token/);
    });

    it('propagates a 401 from Garmin as a ProviderHttpError so the connection layer can mark status=expired', async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 401));
      const { connector } = makeConnector(fetchFn);
      const err = await connector.refresh(conn()).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect((err as ProviderHttpError).status).toBe(401);
      // 401 is non-retryable: exactly one attempt, no silent success.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('backfill', () => {
    it('pages all five collections by ≤24h windows and wraps records with ctx', async () => {
      // 2 days window → 2 windows per collection × 5 collections = 10 calls.
      const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const fetchFn = jest.fn((url: string) => {
        // Only the dailies endpoint returns a record; others are empty.
        if (typeof url === 'string' && url.includes('/dailies')) {
          return Promise.resolve(
            jsonResponse([
              {
                summaryId: 'daily-1',
                userId: 'garmin-99',
                startTimeInSeconds: Math.floor(since.getTime() / 1000),
                durationInSeconds: 86_400,
                steps: 5000,
                activeKilocalories: 400,
              },
            ]),
          );
        }
        return Promise.resolve(jsonResponse([]));
      });
      const { connector } = makeConnector(
        fetchFn as unknown as jest.Mock,
      );
      const records = await connector.backfill(
        conn({
          encrypted_access_token: 'enc:access-cached',
          access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        }),
        since,
      );

      // dailies returns once per window (2 windows) → 2 raw records.
      expect(records).toHaveLength(2);
      expect(records[0].provider).toBe(WearableProvider.GARMIN);
      const payload = records[0].payload as { kind: string; userId: string; connectionId: string };
      expect(payload.kind).toBe('dailies');
      expect(payload.userId).toBe('user-1');
      expect(payload.connectionId).toBe('conn-1');
      // The records normalize to STEPS + ACTIVE_ENERGY_KCAL.
      const samples = connector.normalize(records);
      expect(samples.length).toBe(4); // 2 records × 2 metrics
    });

    it('uses the cached access token when present and unexpired (no refresh call)', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const fetchFn = jest.fn().mockResolvedValue(jsonResponse([]));
      const { connector, kms } = makeConnector(fetchFn);
      await connector.backfill(
        conn({
          encrypted_access_token: 'enc:cached-access',
          access_token_expires_at: new Date(Date.now() + 3_600_000),
        }),
        since,
      );
      // Decrypted the cached access token, never the refresh token.
      expect(kms.decrypt).toHaveBeenCalledWith('enc:cached-access');
      const bearerCalls = fetchFn.mock.calls.filter((c) =>
        String(c[1]?.headers?.Authorization ?? '').includes('cached-access'),
      );
      expect(bearerCalls.length).toBeGreaterThan(0);
    });

    it('propagates a provider outage (503) so the connection layer marks status=error', async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, 503));
      const { connector } = makeConnector(fetchFn);
      await expect(
        connector.backfill(
          conn({
            encrypted_access_token: 'enc:access',
            access_token_expires_at: new Date(Date.now() + 3_600_000),
          }),
          since,
        ),
      ).rejects.toBeInstanceOf(ProviderHttpError);
    });
  });

  describe('verifyWebhook', () => {
    it('returns true for a matching push token (constant-time)', () => {
      const { connector } = makeConnector(jest.fn());
      const ok = connector.verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { [GARMIN_PUSH_TOKEN_HEADER]: PUSH_TOKEN },
      });
      expect(ok).toBe(true);
    });

    it('returns false for a mismatched token', () => {
      const { connector } = makeConnector(jest.fn());
      const ok = connector.verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { [GARMIN_PUSH_TOKEN_HEADER]: 'wrong-token' },
      });
      expect(ok).toBe(false);
    });

    it('fails closed when GARMIN_PUSH_TOKEN is unconfigured', () => {
      delete process.env.GARMIN_PUSH_TOKEN;
      const { connector } = makeConnector(jest.fn());
      const ok = connector.verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { [GARMIN_PUSH_TOKEN_HEADER]: 'anything' },
      });
      expect(ok).toBe(false);
    });

    it('returns false when the header is absent', () => {
      const { connector } = makeConnector(jest.fn());
      expect(
        connector.verifyWebhook({ rawBody: Buffer.from('{}'), headers: {} }),
      ).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('emits one namespaced event per summary record across collections', () => {
      const { connector } = makeConnector(jest.fn());
      const body = JSON.stringify({
        dailies: [
          {
            summaryId: 'd1',
            userId: 'garmin-99',
            startTimeInSeconds: 1_700_000_000,
            steps: 100,
          },
        ],
        hrv: [
          {
            summaryId: 'h1',
            userId: 'garmin-99',
            startTimeInSeconds: 1_700_000_000,
            lastNightAvg: 45,
          },
        ],
      });
      const events = connector.parseWebhook({
        rawBody: Buffer.from(body),
        headers: {},
      });
      expect(events).toHaveLength(2);
      const ids = events.map((e) => e.providerEventId).sort();
      expect(ids).toEqual(['garmin:dailies:d1', 'garmin:hrv:h1']);
      expect(events[0].records).toHaveLength(1);
    });

    it('returns [] for a malformed envelope (unknown top-level key — strict)', () => {
      const { connector } = makeConnector(jest.fn());
      const events = connector.parseWebhook({
        rawBody: Buffer.from(JSON.stringify({ unknownCollection: [] })),
        headers: {},
      });
      expect(events).toHaveLength(0);
    });

    it('returns [] for non-JSON', () => {
      const { connector } = makeConnector(jest.fn());
      expect(
        connector.parseWebhook({ rawBody: Buffer.from('not json'), headers: {} }),
      ).toHaveLength(0);
    });
  });
});
