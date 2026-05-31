import { WearableConnection, WearableProvider } from '@prisma/client';
import { ProviderHttpClient } from '../../http/provider-http-client';
import { StravaConnector } from './strava.connector';

/**
 * PR-HK-2.f — Strava connector unit tests.
 *
 * The {@link ProviderHttpClient} is constructed with a stub `fetchFn` (and a
 * synchronous sleep + deterministic RNG so any backoff path runs without
 * wall-clock waits). Env is injected via `getEnv` so no real secrets are read.
 */

/** Minimal Response stub: json() + headers.get(). */
function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const headers = new Headers(init?.headers ?? {});
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers,
    json: async () => body,
  } as unknown as Response;
}

const ENV: Record<string, string> = {
  STRAVA_CLIENT_ID: 'client-123',
  STRAVA_CLIENT_SECRET: 'secret-xyz',
  STRAVA_REDIRECT_URI: 'https://api.example.com/v1/wearables/oauth/strava/callback',
};

function makeConnector(fetchFn: jest.Mock): StravaConnector {
  const http = new ProviderHttpClient({
    fetchFn: fetchFn as unknown as typeof fetch,
    sleep: async () => undefined,
    random: () => 0,
  });
  return new StravaConnector({ http, getEnv: (k) => ENV[k] });
}

describe('StravaConnector.buildAuthUrl', () => {
  it('builds the correct authorization URL with all required params', () => {
    const c = makeConnector(jest.fn());
    const url = new URL(c.buildAuthUrl('user-1', 'state-token-abc'));
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.STRAVA_REDIRECT_URI);
    expect(url.searchParams.get('approval_prompt')).toBe('auto');
    expect(url.searchParams.get('scope')).toBe(
      'activity:read_all,profile:read_all',
    );
    expect(url.searchParams.get('state')).toBe('state-token-abc');
  });

  it('throws loud when a required env var is missing', () => {
    const http = new ProviderHttpClient({ fetchFn: jest.fn() as never });
    const c = new StravaConnector({ http, getEnv: () => undefined });
    expect(() => c.buildAuthUrl('u', 's')).toThrow(/STRAVA_CLIENT_ID/);
  });
});

describe('StravaConnector.exchangeCode', () => {
  it('exchanges a code and returns the token set with athlete id', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        token_type: 'Bearer',
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_at: 1_900_000_000,
        athlete: { id: 42 },
      }),
    );
    const c = makeConnector(fetchFn);
    const ts = await c.exchangeCode('auth-code');

    expect(ts.accessToken).toBe('at-1');
    expect(ts.refreshToken).toBe('rt-1');
    expect(ts.externalAccountId).toBe('42');
    expect(ts.accessTokenExpiresAt?.getTime()).toBe(1_900_000_000 * 1000);
    expect(ts.scopes).toEqual(['activity:read_all', 'profile:read_all']);

    // Sent the right grant + secret to the token endpoint.
    const [calledUrl, init] = fetchFn.mock.calls[0];
    expect(calledUrl).toBe('https://www.strava.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('grant_type=authorization_code');
    expect(init.body).toContain('code=auth-code');
  });

  it('throws on a token error response (missing tokens)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Bad Request', errors: [] }));
    const c = makeConnector(fetchFn);
    await expect(c.exchangeCode('bad')).rejects.toThrow(/missing access\/refresh/);
  });

  it('throws on a permanent HTTP failure (e.g. 400)', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'Bad Request' }, { status: 400 }));
    const c = makeConnector(fetchFn);
    await expect(c.exchangeCode('bad')).rejects.toThrow(/token request failed/);
  });
});

describe('StravaConnector refresh rotation', () => {
  it('rotates the refresh token (returns the NEW one)', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        access_token: 'at-2',
        refresh_token: 'rt-ROTATED',
        expires_at: 1_900_000_500,
      }),
    );
    const c = makeConnector(fetchFn);
    const ts = await c.refreshAccessToken('rt-OLD');

    expect(ts.refreshToken).toBe('rt-ROTATED');
    expect(ts.refreshToken).not.toBe('rt-OLD');
    expect(ts.accessToken).toBe('at-2');

    const [, init] = fetchFn.mock.calls[0];
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=rt-OLD');
  });

  it('refresh(conn) reads the connection transient token then rotates', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        access_token: 'at-3',
        refresh_token: 'rt-NEW',
        expires_at: 1_900_000_600,
      }),
    );
    const c = makeConnector(fetchFn);
    const conn = {
      id: 'conn-1',
      decryptedRefreshToken: 'rt-CONN',
    } as unknown as WearableConnection;
    const ts = await c.refresh(conn);
    expect(ts.refreshToken).toBe('rt-NEW');
  });

  it('refresh(conn) throws loud when the connection has no refresh token', async () => {
    const c = makeConnector(jest.fn());
    const conn = { id: 'conn-2' } as unknown as WearableConnection;
    await expect(c.refresh(conn)).rejects.toThrow(/no refresh token/);
  });
});

describe('StravaConnector.backfill pagination', () => {
  function activity(id: number, start = '2024-01-02T07:30:00Z') {
    return {
      id,
      moving_time: 1800,
      distance: 5000,
      start_date: start,
    };
  }

  function conn(): WearableConnection {
    return {
      id: 'conn-bf',
      decryptedAccessToken: 'at-live',
    } as unknown as WearableConnection;
  }

  it('pages until a short page and returns all raw records', async () => {
    // page 1: full 200 → keep paging; page 2: 3 records (short) → stop.
    const fullPage = Array.from({ length: 200 }, (_, i) => activity(i + 1));
    const shortPage = [activity(201), activity(202), activity(203)];
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse(shortPage));

    const c = makeConnector(fetchFn);
    const out = await c.backfill(conn(), new Date('2024-01-01T00:00:00Z'));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(203);
    expect(out[0].provider).toBe(WearableProvider.STRAVA);
    expect(out[0].id).toBe('1');

    // First call had the right paging + after params + bearer auth.
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/athlete/activities?per_page=200&page=1&after=');
    expect(init.headers.Authorization).toBe('Bearer at-live');
  });

  it('stops on an empty first page', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(jsonResponse([]));
    const c = makeConnector(fetchFn);
    const out = await c.backfill(conn(), new Date('2024-01-01T00:00:00Z'));
    expect(out).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('pauses paging when rate-limit headers approach the window', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => activity(i + 1));
    // page 1 full but usage 190/200 (95% ≥ 90%) → pause after page 1.
    const fetchFn = jest.fn().mockResolvedValueOnce(
      jsonResponse(fullPage, {
        headers: {
          'x-ratelimit-limit': '200,2000',
          'x-ratelimit-usage': '190,400',
        },
      }),
    );
    const c = makeConnector(fetchFn);
    const out = await c.backfill(conn(), new Date('2024-01-01T00:00:00Z'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(200);
  });

  it('throws loud when the connection has no access token', async () => {
    const c = makeConnector(jest.fn());
    const bare = { id: 'conn-x' } as unknown as WearableConnection;
    await expect(
      c.backfill(bare, new Date('2024-01-01T00:00:00Z')),
    ).rejects.toThrow(/no access token/);
  });
});

describe('StravaConnector.shouldPauseForRateLimit', () => {
  const c = makeConnector(jest.fn());
  const res = (limit?: string, usage?: string) =>
    ({
      headers: new Headers({
        ...(limit ? { 'x-ratelimit-limit': limit } : {}),
        ...(usage ? { 'x-ratelimit-usage': usage } : {}),
      }),
    }) as unknown as Response;

  it('pauses when the 15-min window is ≥ 90%', () => {
    expect(c.shouldPauseForRateLimit(res('200,2000', '180,100'))).toBe(true);
  });
  it('pauses when the daily window is ≥ 90%', () => {
    expect(c.shouldPauseForRateLimit(res('200,2000', '10,1900'))).toBe(true);
  });
  it('does not pause well under both windows', () => {
    expect(c.shouldPauseForRateLimit(res('200,2000', '10,100'))).toBe(false);
  });
  it('does not pause when headers are missing/malformed', () => {
    expect(c.shouldPauseForRateLimit(res())).toBe(false);
    expect(c.shouldPauseForRateLimit(res('200', 'nope'))).toBe(false);
  });
});

describe('StravaConnector.normalize (contract method)', () => {
  it('returns [] for empty input', () => {
    const c = makeConnector(jest.fn());
    expect(c.normalize([])).toEqual([]);
  });
  it('throws (fail-loud) when called with records but no connection context', () => {
    const c = makeConnector(jest.fn());
    expect(() =>
      c.normalize([{ provider: WearableProvider.STRAVA, payload: {} }]),
    ).toThrow(/normalizeStravaActivities/);
  });

  it('declares provider STRAVA and oauth2 auth model', () => {
    const c = makeConnector(jest.fn());
    expect(c.provider).toBe(WearableProvider.STRAVA);
    expect(c.authModel).toBe('oauth2');
  });
});
