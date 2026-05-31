import { WearableConnection, WearableProvider } from '@prisma/client';
import { KmsService } from '../../../common/kms/kms.service';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { WhoopConnector, signWhoopWebhook } from './whoop.connector';
import { WHOOP_SIGNATURE_HEADER, WHOOP_SIGNATURE_TIMESTAMP_HEADER } from './whoop.types';

const SECRET = 'whoop-test-secret';

function makeClient(fetchFn: jest.Mock): ProviderHttpClient {
  return new ProviderHttpClient({
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    random: () => 1,
  });
}

/**
 * KMS test double. `decrypt` strips an `enc:` prefix (so a wrapped value
 * round-trips to its plaintext) and `encrypt` adds it — letting specs assert
 * BOTH that the connector unwraps stored tokens before WHOOP calls AND wraps
 * rotated tokens before returning them. Both are jest.fn() so call counts /
 * arguments can be asserted.
 */
function makeKms(): KmsService & {
  decrypt: jest.Mock;
  encrypt: jest.Mock;
} {
  const decrypt = jest.fn((ct: string) =>
    ct.startsWith('enc:') ? ct.slice(4) : ct,
  );
  const encrypt = jest.fn((pt: string) => `enc:${pt}`);
  return { decrypt, encrypt } as unknown as KmsService & {
    decrypt: jest.Mock;
    encrypt: jest.Mock;
  };
}

/** Build a connector with both deps mocked; returns the kms mock too. */
function makeConnector(fetchFn: jest.Mock) {
  const kms = makeKms();
  const connector = new WhoopConnector(makeClient(fetchFn), kms);
  return { connector, kms };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('WhoopConnector', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.WHOOP_CLIENT_ID = 'client-123';
    process.env.WHOOP_CLIENT_SECRET = SECRET;
    process.env.WHOOP_REDIRECT_URI = 'https://app.example.com/oauth/whoop';
    delete process.env.WHOOP_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  describe('buildAuthUrl', () => {
    it('builds the WHOOP v2 auth URL with offline scope + all required scopes', () => {
      const connector = makeConnector(jest.fn()).connector;
      const url = connector.buildAuthUrl('user-1', 'state-xyz');
      expect(url).not.toBeNull();
      const u = url as string;
      expect(u).toContain('https://api.prod.whoop.com/oauth/oauth2/auth');
      expect(u).toContain('response_type=code');
      expect(u).toContain('client_id=client-123');
      expect(u).toContain('state=state-xyz');
      // Scopes are space-delimited then URL-encoded as %20 / +.
      const decoded = decodeURIComponent(u);
      expect(decoded).toContain('read:recovery');
      expect(decoded).toContain('read:cycles');
      expect(decoded).toContain('read:workout');
      expect(decoded).toContain('read:sleep');
      expect(decoded).toContain('read:profile');
      expect(decoded).toContain('read:body_measurement');
      expect(decoded).toContain('offline');
    });

    it('exposes provider=WHOOP and authModel=oauth2', () => {
      const connector = makeConnector(jest.fn()).connector;
      expect(connector.provider).toBe(WearableProvider.WHOOP);
      expect(connector.authModel).toBe('oauth2');
    });
  });

  describe('exchangeCode', () => {
    it('POSTs the token endpoint and returns a TokenSet', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
          scope: 'read:recovery offline',
          user_id: 42,
        }),
      );
      const connector = makeConnector(fetchFn).connector;
      const tokens = await connector.exchangeCode('auth-code');
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchFn.mock.calls[0];
      expect(calledUrl).toBe('https://api.prod.whoop.com/oauth/oauth2/token');
      expect((init as RequestInit).method).toBe('POST');
      expect(tokens.refreshToken).toBe('rt-1');
      expect(tokens.accessToken).toBe('at-1');
      expect(tokens.externalAccountId).toBe('42');
      expect(tokens.scopes).toContain('offline');
      expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
    });
  });

  describe('refreshAccessToken (rotation)', () => {
    it('requests offline scope and returns the NEW rotated refresh token', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          access_token: 'at-2',
          refresh_token: 'rt-2-rotated',
          expires_in: 3600,
          scope: 'offline',
        }),
      );
      const connector = makeConnector(fetchFn).connector;
      const tokens = await connector.refreshAccessToken('rt-1-old');
      // refreshAccessToken is the low-level raw path: it returns the rotated
      // token in PLAINTEXT (KMS-wrapping happens in refresh()).
      expect(tokens.refreshToken).toBe('rt-2-rotated');
      const [, init] = fetchFn.mock.calls[0];
      const sentBody = (init as RequestInit).body as string;
      expect(sentBody).toContain('grant_type=refresh_token');
      expect(sentBody).toContain('refresh_token=rt-1-old');
      expect(sentBody).toContain('scope=offline');
    });

    it('throws (fail loud) when the token response omits refresh_token', async () => {
      const fetchFn = jest
        .fn()
        .mockResolvedValue(jsonResponse({ access_token: 'at-only' }));
      const connector = makeConnector(fetchFn).connector;
      await expect(connector.refreshAccessToken('rt')).rejects.toThrow(
        /missing refresh_token/,
      );
    });

    it('refresh(conn) KMS-unwraps the stored refresh token, rotates, then KMS-wraps the rotated tokens', async () => {
      const fetchFn = jest.fn().mockResolvedValue(
        jsonResponse({
          access_token: 'at-2',
          refresh_token: 'rt-2-rotated',
          expires_in: 3600,
          scope: 'offline',
        }),
      );
      const { connector, kms } = makeConnector(fetchFn);
      const conn = {
        id: 'conn-1',
        user_id: 'user-1',
        provider: WearableProvider.WHOOP,
        encrypted_refresh_token: 'enc:rt-1-old',
      } as unknown as WearableConnection;

      const tokens = await connector.refresh(conn);

      // (1) the stored refresh token was DECRYPTED before the WHOOP call.
      expect(kms.decrypt).toHaveBeenCalledWith('enc:rt-1-old');
      // (2) the WHOOP refresh used the PLAINTEXT token.
      const [, init] = fetchFn.mock.calls[0];
      const sentBody = (init as RequestInit).body as string;
      expect(sentBody).toContain('refresh_token=rt-1-old');
      // (3) rotated tokens are returned KMS-WRAPPED (encrypt called on both).
      expect(kms.encrypt).toHaveBeenCalledWith('rt-2-rotated');
      expect(kms.encrypt).toHaveBeenCalledWith('at-2');
      expect(tokens.refreshToken).toBe('enc:rt-2-rotated');
      expect(tokens.accessToken).toBe('enc:at-2');
    });

    it('refresh(conn) throws (re-consent) when there is no stored refresh token', async () => {
      const { connector } = makeConnector(jest.fn());
      await expect(
        connector.refresh({
          id: 'c',
          user_id: 'u',
          provider: WearableProvider.WHOOP,
        } as unknown as WearableConnection),
      ).rejects.toThrow(/no refresh token/);
    });
  });

  describe('backfill', () => {
    function conn(): WearableConnection {
      return {
        id: 'conn-1',
        user_id: 'user-1',
        provider: WearableProvider.WHOOP,
        // Real WearableConnection shape: KMS-wrapped access token cache that
        // is still fresh (expiry in the future).
        encrypted_access_token: 'enc:at-live',
        access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      } as unknown as WearableConnection;
    }

    it('pages each of the 4 collections and follows next_token, returning tagged RawRecords', async () => {
      // recovery: 2 pages; others: 1 page each.
      const fetchFn = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/recovery')) {
          if (url.includes('nextToken=NT1')) {
            return Promise.resolve(
              jsonResponse({
                records: [{ id: 'rec-2', score_state: 'PENDING_SCORE' }],
                next_token: null,
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              records: [{ id: 'rec-1', score_state: 'PENDING_SCORE' }],
              next_token: 'NT1',
            }),
          );
        }
        if (url.includes('/cycle')) {
          return Promise.resolve(
            jsonResponse({ records: [{ id: 'cyc-1' }], next_token: null }),
          );
        }
        if (url.includes('/activity/sleep')) {
          return Promise.resolve(
            jsonResponse({ records: [{ id: 'slp-1' }], next_token: '' }),
          );
        }
        if (url.includes('/activity/workout')) {
          return Promise.resolve(
            jsonResponse({ records: [{ id: 'wo-1' }] }),
          );
        }
        return Promise.resolve(jsonResponse({ records: [] }));
      });

      const { connector, kms } = makeConnector(fetchFn);
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const records = await connector.backfill(conn(), since);

      // The cached access token was KMS-UNWRAPPED before the WHOOP calls.
      expect(kms.decrypt).toHaveBeenCalledWith('enc:at-live');

      // 2 recovery + 1 cycle + 1 sleep + 1 workout = 5 records.
      expect(records).toHaveLength(5);
      // Every record is tagged WHOOP + carries ctx on the payload.
      for (const r of records) {
        expect(r.provider).toBe(WearableProvider.WHOOP);
        const p = r.payload as { userId?: string; connectionId?: string };
        expect(p.userId).toBe('user-1');
        expect(p.connectionId).toBe('conn-1');
      }
      // Bearer auth on every call.
      for (const call of fetchFn.mock.calls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Bearer at-live',
        );
      }
      // recovery requested with limit=25.
      expect(
        fetchFn.mock.calls.some((c) => String(c[0]).includes('limit=25')),
      ).toBe(true);
    });

    it('throws if the connection has neither an access nor a refresh token', async () => {
      const connector = makeConnector(jest.fn()).connector;
      await expect(
        connector.backfill({ id: 'c', user_id: 'u' } as unknown as WearableConnection, new Date()),
      ).rejects.toThrow(/no access or refresh token/);
    });

    it('falls back to a refresh (KMS-unwrapping the refresh token) when no cached access token exists', async () => {
      const fetchFn = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/oauth/oauth2/token')) {
          return Promise.resolve(
            jsonResponse({
              access_token: 'at-fresh',
              refresh_token: 'rt-rotated',
              expires_in: 3600,
              scope: 'offline',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ records: [], next_token: null }));
      });
      const { connector, kms } = makeConnector(fetchFn);
      const conn = {
        id: 'conn-2',
        user_id: 'user-2',
        provider: WearableProvider.WHOOP,
        encrypted_refresh_token: 'enc:rt-stored',
      } as unknown as WearableConnection;

      await connector.backfill(conn, new Date(Date.now() - 1000));

      // The stored refresh token was decrypted to mint a fresh access token.
      expect(kms.decrypt).toHaveBeenCalledWith('enc:rt-stored');
      // Backfill GETs used the freshly-minted (plaintext) access token.
      const getCalls = fetchFn.mock.calls.filter(
        (c) => !String(c[0]).includes('/oauth/oauth2/token'),
      );
      expect(getCalls.length).toBeGreaterThan(0);
      for (const call of getCalls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Bearer at-fresh',
        );
      }
    });

    it('re-mints the access token when the cached one is expired', async () => {
      const fetchFn = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/oauth/oauth2/token')) {
          return Promise.resolve(
            jsonResponse({
              access_token: 'at-refreshed',
              refresh_token: 'rt-rotated',
              expires_in: 3600,
              scope: 'offline',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ records: [], next_token: null }));
      });
      const { connector } = makeConnector(fetchFn);
      const conn = {
        id: 'conn-3',
        user_id: 'user-3',
        provider: WearableProvider.WHOOP,
        encrypted_access_token: 'enc:at-stale',
        access_token_expires_at: new Date(Date.now() - 60 * 1000), // expired
        encrypted_refresh_token: 'enc:rt-stored',
      } as unknown as WearableConnection;

      await connector.backfill(conn, new Date(Date.now() - 1000));

      // It did NOT use the stale cached token; it refreshed.
      const tokenCall = fetchFn.mock.calls.some((c) =>
        String(c[0]).includes('/oauth/oauth2/token'),
      );
      expect(tokenCall).toBe(true);
      const getCalls = fetchFn.mock.calls.filter(
        (c) => !String(c[0]).includes('/oauth/oauth2/token'),
      );
      for (const call of getCalls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Bearer at-refreshed',
        );
      }
    });
  });

  describe('verifyWebhook', () => {
    function freshHeaders(rawBody: Buffer, secret = SECRET) {
      const ts = String(Date.now());
      const sig = signWhoopWebhook({ rawBody, timestamp: ts, secret });
      return {
        [WHOOP_SIGNATURE_HEADER]: sig,
        [WHOOP_SIGNATURE_TIMESTAMP_HEADER]: ts,
      };
    }

    it('accepts a correctly signed, fresh webhook', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from(
        JSON.stringify({ id: 'evt-1', type: 'recovery.updated', user_id: 1 }),
      );
      const ok = connector.verifyWebhook({
        rawBody,
        headers: freshHeaders(rawBody),
      });
      expect(ok).toBe(true);
    });

    it('rejects a bad signature (401 path)', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1' }));
      const headers = freshHeaders(rawBody);
      headers[WHOOP_SIGNATURE_HEADER] = 'AAAAtampered-signature-value-AAAA';
      expect(connector.verifyWebhook({ rawBody, headers })).toBe(false);
    });

    it('rejects when the signature is computed with the wrong secret', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1' }));
      expect(
        connector.verifyWebhook({
          rawBody,
          headers: freshHeaders(rawBody, 'WRONG-SECRET'),
        }),
      ).toBe(false);
    });

    it('rejects a stale (replayed) timestamp beyond tolerance', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from(JSON.stringify({ id: 'evt-1' }));
      const staleTs = String(Date.now() - 10 * 60 * 1000); // 10 min old
      const sig = signWhoopWebhook({ rawBody, timestamp: staleTs, secret: SECRET });
      expect(
        connector.verifyWebhook({
          rawBody,
          headers: {
            [WHOOP_SIGNATURE_HEADER]: sig,
            [WHOOP_SIGNATURE_TIMESTAMP_HEADER]: staleTs,
          },
        }),
      ).toBe(false);
    });

    it('rejects when signature or timestamp header is missing', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from('{}');
      expect(connector.verifyWebhook({ rawBody, headers: {} })).toBe(false);
    });
  });

  describe('parseWebhook + revocation helpers', () => {
    it('parses a verified body into a ProviderEvent keyed by the UUID id', () => {
      const connector = makeConnector(jest.fn()).connector;
      const rawBody = Buffer.from(
        JSON.stringify({
          id: 'evt-uuid-1',
          type: 'sleep.updated',
          user_id: 7,
        }),
      );
      const events = connector.parseWebhook({ rawBody, headers: {} });
      expect(events).toHaveLength(1);
      expect(events[0].providerEventId).toBe('evt-uuid-1');
      expect(events[0].type).toBe('sleep.updated');
      expect(events[0].records[0].provider).toBe(WearableProvider.WHOOP);
    });

    it('returns [] for malformed JSON', () => {
      const connector = makeConnector(jest.fn()).connector;
      const events = connector.parseWebhook({
        rawBody: Buffer.from('not json'),
        headers: {},
      });
      expect(events).toEqual([]);
    });

    it('recognises user.deauthorized as a revocation event', () => {
      const connector = makeConnector(jest.fn()).connector;
      expect(connector.isRevocationEvent('user.deauthorized')).toBe(true);
      expect(connector.isRevocationEvent('recovery.updated')).toBe(false);
    });

    it('resolves the fetch descriptor for each data event type', () => {
      const connector = makeConnector(jest.fn()).connector;
      expect(connector.fetchDescriptorFor('recovery.updated')?.kind).toBe(
        'recovery',
      );
      expect(connector.fetchDescriptorFor('cycle.updated')?.kind).toBe('cycle');
      expect(connector.fetchDescriptorFor('sleep.updated')?.kind).toBe('sleep');
      expect(connector.fetchDescriptorFor('workout.updated')?.kind).toBe(
        'workout',
      );
      expect(connector.fetchDescriptorFor('user.deauthorized')).toBeNull();
    });
  });
});
