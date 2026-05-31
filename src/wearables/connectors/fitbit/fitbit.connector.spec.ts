import { createHash, createHmac } from 'crypto';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import {
  FitbitConnector,
  createFitbitConnector,
  deriveCodeChallenge,
  generateCodeVerifier,
  redactErrorMessage,
} from './fitbit.connector';
import { FitbitRawPayload } from './fitbit.normalizer';
import { FitbitNotification } from './fitbit.types';
import { PrismaService } from '../../../prisma.service';

/**
 * PR-HK-2.e connector tests — real-value assertions (no bare toBeDefined).
 *
 * `ProviderHttpClient` is stubbed so no real network is touched: `request`
 * returns a fake `Response`-like with `.json()`. OAuth env is set in beforeEach
 * so the URL/token-exchange paths are exercised deterministically.
 */

function makePrisma(): { prisma: PrismaService; update: jest.Mock } {
  const update = jest.fn(async () => ({}));
  const prisma = {
    wearableConnection: { update },
  } as unknown as PrismaService;
  return { prisma, update };
}

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeHttp(): {
  client: ProviderHttpClient;
  calls: { url: string; init: Record<string, unknown> }[];
  enqueue: (r: Response | Error) => void;
} {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const queue: (Response | Error)[] = [];
  const client = {
    request: jest.fn(async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('no queued response');
      return next;
    }),
  } as unknown as ProviderHttpClient;
  return { client, calls, enqueue: (r) => queue.push(r) };
}

const ENV = {
  FITBIT_CLIENT_ID: 'client-abc',
  FITBIT_CLIENT_SECRET: 'secret-xyz',
  FITBIT_REDIRECT_URI: 'https://app.example.com/oauth/fitbit/callback',
};

describe('FitbitConnector — metadata', () => {
  it('declares FITBIT provider and oauth2 auth model', () => {
    const { client } = makeHttp();
    const c = new FitbitConnector(client);
    expect(c.provider).toBe(WearableProvider.FITBIT);
    expect(c.authModel).toBe('oauth2');
  });

  it('createFitbitConnector returns a FitbitConnector', () => {
    const { client } = makeHttp();
    expect(createFitbitConnector(client)).toBeInstanceOf(FitbitConnector);
  });
});

describe('FitbitConnector — buildAuthUrl + PKCE', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('includes all required OAuth params + the full scope set + state', () => {
    const { client } = makeHttp();
    const url = new URL(new FitbitConnector(client).buildAuthUrl('user-1', 'st8'));
    expect(url.origin + url.pathname).toBe(
      'https://www.fitbit.com/oauth2/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.FITBIT_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe(
      'activity heartrate sleep weight respiratory_rate oxygen_saturation',
    );
  });

  it('adds S256 PKCE params when a code_challenge is supplied (round-trip)', () => {
    const { client } = makeHttp();
    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    const url = new URL(
      new FitbitConnector(client).buildAuthUrlPkce('u', 's', challenge),
    );
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge is the base64url(sha256(verifier)) — verify the derivation.
    const expected = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('generateCodeVerifier produces a URL-safe 43-char string within RFC bounds', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('throws if FITBIT_CLIENT_ID is not configured', () => {
    delete process.env.FITBIT_CLIENT_ID;
    const { client } = makeHttp();
    expect(() => new FitbitConnector(client).buildAuthUrl('u', 's')).toThrow(
      /FITBIT_CLIENT_ID/,
    );
  });
});

describe('FitbitConnector — exchangeCode', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('POSTs the token endpoint with Basic auth + PKCE verifier and maps the TokenSet', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 28_800,
        token_type: 'Bearer',
        scope: 'activity heartrate sleep',
        user_id: 'fb-user-1',
      }),
    );
    const before = Date.now();
    const ts = await new FitbitConnector(client).exchangeCode('auth-code-1', {
      codeVerifier: 'verifier-123',
    });

    expect(calls[0].url).toBe('https://api.fitbit.com/oauth2/token');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    const expectedBasic = Buffer.from('client-abc:secret-xyz').toString(
      'base64',
    );
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);

    const body = String(calls[0].init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code-1');
    expect(body).toContain('code_verifier=verifier-123');

    expect(ts.accessToken).toBe('at-1');
    expect(ts.refreshToken).toBe('rt-1');
    expect(ts.scopes).toEqual(['activity', 'heartrate', 'sleep']);
    expect(ts.externalAccountId).toBe('fb-user-1');
    expect(ts.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 28_800_000 - 2000,
    );
  });

  it('propagates a ProviderHttpError on a token-endpoint failure', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new ProviderHttpError('fitbit.exchangeCode: HTTP 400', 1, 400));
    await expect(
      new FitbitConnector(client).exchangeCode('bad-code'),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('throws if the token response has no refresh_token', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ access_token: 'at', expires_in: 3600 }));
    await expect(
      new FitbitConnector(client).exchangeCode('code'),
    ).rejects.toThrow(/missing refresh_token/);
  });
});

describe('FitbitConnector — refresh', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('refreshes using the connection refresh token and rotates it', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'at-2',
        refresh_token: 'rt-2',
        expires_in: 28_800,
        token_type: 'Bearer',
      }),
    );
    const conn = {
      decryptedRefreshToken: 'rt-old',
    } as unknown as WearableConnection;
    const ts = await new FitbitConnector(client).refresh(conn);

    const body = String(calls[0].init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt-old');
    expect(ts.accessToken).toBe('at-2');
    expect(ts.refreshToken).toBe('rt-2');
  });

  it('falls back to the existing refresh token when the provider omits a rotated one', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ access_token: 'at-3', expires_in: 3600 }));
    const conn = {
      decryptedRefreshToken: 'rt-keep',
    } as unknown as WearableConnection;
    const ts = await new FitbitConnector(client).refresh(conn);
    expect(ts.refreshToken).toBe('rt-keep');
  });

  it('throws when the connection has no refresh token', async () => {
    const { client } = makeHttp();
    await expect(
      new FitbitConnector(client).refresh({} as WearableConnection),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe('FitbitConnector — verifyWebhook (HMAC-SHA1 base64)', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  function sign(rawBody: Buffer, secret: string): string {
    return createHmac('sha1', `${secret}&`).update(rawBody).digest('base64');
  }

  it('accepts a correctly signed delivery', () => {
    const { client } = makeHttp();
    const c = new FitbitConnector(client);
    const rawBody = Buffer.from(JSON.stringify([{ collectionType: 'sleep' }]));
    const signature = sign(rawBody, ENV.FITBIT_CLIENT_SECRET);
    expect(
      c.verifyWebhook({ rawBody, headers: { 'x-fitbit-signature': signature } }),
    ).toBe(true);
  });

  it('rejects a bad signature', () => {
    const { client } = makeHttp();
    expect(
      new FitbitConnector(client).verifyWebhook({
        rawBody: Buffer.from('[]'),
        headers: { 'x-fitbit-signature': 'AAAA' },
      }),
    ).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    const { client } = makeHttp();
    expect(
      new FitbitConnector(client).verifyWebhook({
        rawBody: Buffer.from('[]'),
        headers: {},
      }),
    ).toBe(false);
  });

  it('fails closed when FITBIT_CLIENT_SECRET is unset', () => {
    delete process.env.FITBIT_CLIENT_SECRET;
    const { client } = makeHttp();
    expect(
      new FitbitConnector(client).verifyWebhook({
        rawBody: Buffer.from('[]'),
        headers: { 'x-fitbit-signature': 'X' },
      }),
    ).toBe(false);
  });
});

describe('FitbitConnector — backfill + fetchNotificationRecords', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const conn = {
    id: 'conn-1',
    user_id: 'user-1',
    decryptedAccessToken: 'at-live',
  } as unknown as WearableConnection;

  it('clamps the backfill window to ≤30d and wraps records with context', async () => {
    const { client, calls, enqueue } = makeHttp();
    // 6 backfill collections; queue a body for each.
    enqueue(fakeResponse({ 'activities-steps': [{ dateTime: '2026-05-30', value: '8421' }] }));
    enqueue(fakeResponse({ 'activities-heart': [] }));
    enqueue(fakeResponse({ sleep: [] }));
    enqueue(fakeResponse({ weight: [] }));
    enqueue(fakeResponse({ br: [] }));
    enqueue(fakeResponse([]));

    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1y ago
    const records = await new FitbitConnector(client).backfill(conn, since);

    expect(records).toHaveLength(6);
    // The steps endpoint URL embeds a start date within ~30d of now.
    const stepsCall = calls.find((c) => c.url.includes('/activities/steps/'))!;
    const m = stepsCall.url.match(/date\/(\d{4}-\d{2}-\d{2})\//)!;
    const ageDays = (Date.now() - new Date(`${m[1]}T00:00:00Z`).getTime()) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(31);

    // The Authorization + Accept-Language headers are set on each fetch.
    const headers = stepsCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer at-live');
    expect(headers['Accept-Language']).toBe('en_GB');

    const payload = records[0].payload as FitbitRawPayload;
    expect(payload.collection).toBe('activities/steps');
    expect(payload.userId).toBe('user-1');
    expect(payload.connectionId).toBe('conn-1');
  });

  it('throws when the connection has no access token', async () => {
    const { client } = makeHttp();
    await expect(
      new FitbitConnector(client).backfill(
        { id: 'c', user_id: 'u' } as WearableConnection,
        new Date(),
      ),
    ).rejects.toThrow(/no access token/);
  });

  it('fetchNotificationRecords pulls the just-changed day for the mapped collections', async () => {
    const { client, calls, enqueue } = makeHttp();
    // "activities" maps to steps + heart → two fetches.
    enqueue(fakeResponse({ 'activities-steps': [{ dateTime: '2026-05-30', value: '10' }] }));
    enqueue(fakeResponse({ 'activities-heart': [] }));
    const notification: FitbitNotification = {
      collectionType: 'activities',
      date: '2026-05-30',
      ownerId: 'fb-user-1',
      ownerType: 'user',
      subscriptionId: 'sub-1',
    };
    const out = await new FitbitConnector(client).fetchNotificationRecords(
      conn,
      notification,
    );
    expect(out).toHaveLength(2);
    expect(calls[0].url).toContain('/activities/steps/date/2026-05-30/2026-05-30.json');
    expect(calls[1].url).toContain('/activities/heart/date/2026-05-30/2026-05-30.json');
    expect((out[0].payload as FitbitRawPayload).collection).toBe('activities/steps');
  });

  it('returns no records for an unknown collectionType', async () => {
    const { client } = makeHttp();
    const out = await new FitbitConnector(client).fetchNotificationRecords(conn, {
      collectionType: 'foods',
      date: '2026-05-30',
      ownerId: 'u',
      ownerType: 'user',
      subscriptionId: 's',
    });
    expect(out).toEqual([]);
  });
});

describe('FitbitConnector — outage marking', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const conn = {
    id: 'conn-err-1',
    user_id: 'user-1',
    decryptedAccessToken: 'at-live',
    decryptedRefreshToken: 'rt-live',
  } as unknown as WearableConnection;

  it('marks the connection error with a REDACTED last_error when backfill fails, then rethrows', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(
      new Error(
        'fitbit.fetch.activities/steps: HTTP 502 for Authorization: Bearer at-live-SECRET and client_secret=secret-xyz',
      ),
    );
    const c = new FitbitConnector(client, prisma);
    await expect(c.backfill(conn, new Date())).rejects.toThrow(/HTTP 502/);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'conn-err-1' });
    expect(arg.data.status).toBe('error');
    expect(arg.data.last_error).toContain('HTTP 502');
    expect(arg.data.last_error).toContain('Bearer [REDACTED]');
    expect(arg.data.last_error).toContain('client_secret=[REDACTED]');
    expect(arg.data.last_error).not.toContain('at-live-SECRET');
    expect(arg.data.last_error).not.toContain('secret-xyz');
  });

  it('marks the connection error when refresh fails, then rethrows', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(
      new ProviderHttpError(
        'fitbit.refresh: HTTP 400 invalid_grant refresh_token=rt-live-LEAK',
        1,
        400,
      ),
    );
    const c = new FitbitConnector(client, prisma);
    await expect(c.refresh(conn)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'conn-err-1' },
      data: {
        status: 'error',
        last_error: expect.stringContaining('refresh_token=[REDACTED]'),
      },
    });
    expect(update.mock.calls[0][0].data.last_error).not.toContain('rt-live-LEAK');
  });

  it('still rethrows (and does not crash) when no PrismaService is wired', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new Error('fitbit.fetch.activities/steps: HTTP 500'));
    const c = new FitbitConnector(client);
    await expect(c.backfill(conn, new Date())).rejects.toThrow(/HTTP 500/);
  });
});

describe('redactErrorMessage', () => {
  it('strips token=, code=, client_secret=, access_token=, refresh_token= values', () => {
    const out = redactErrorMessage(
      new Error(
        'fail token=abc123 code=xyz client_secret=shh access_token=AT refresh_token=RT keep=ok',
      ),
    );
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('code=[REDACTED]');
    expect(out).toContain('client_secret=[REDACTED]');
    expect(out).toContain('access_token=[REDACTED]');
    expect(out).toContain('refresh_token=[REDACTED]');
    expect(out).toContain('keep=ok');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('shh');
  });

  it('strips bearer tokens and Authorization headers', () => {
    const out = redactErrorMessage(
      'Authorization: Bearer eyJhbGciOi.Jh.signature failed',
    );
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGciOi');
  });

  it('handles non-Error inputs and empty messages', () => {
    expect(redactErrorMessage('plain string')).toBe('plain string');
    expect(redactErrorMessage({ foo: 'bar' })).toContain('foo');
    expect(redactErrorMessage(new Error(''))).toBe('unknown');
  });

  it('caps the message at 500 characters', () => {
    const long = 'x'.repeat(900);
    expect(redactErrorMessage(new Error(long)).length).toBe(500);
  });
});

describe('FitbitConnector — eventId', () => {
  it('builds a stable id from collectionType:ownerId:date:subscriptionId', () => {
    const { client } = makeHttp();
    const id = new FitbitConnector(client).eventId({
      collectionType: 'sleep',
      date: '2026-05-30',
      ownerId: 'owner-1',
      ownerType: 'user',
      subscriptionId: 'sub-9',
    });
    expect(id).toBe('sleep:owner-1:2026-05-30:sub-9');
  });

  it('uses a stable literal for date when absent (userRevokedAccess)', () => {
    const { client } = makeHttp();
    const id = new FitbitConnector(client).eventId({
      collectionType: 'userRevokedAccess',
      ownerId: 'owner-1',
      ownerType: 'user',
      subscriptionId: 'sub-9',
    });
    expect(id).toBe('userRevokedAccess:owner-1:none:sub-9');
  });
});

describe('FitbitConnector — parseWebhook', () => {
  it('parses an array of notifications into provider events', () => {
    const { client } = makeHttp();
    const rawBody = Buffer.from(
      JSON.stringify([
        {
          collectionType: 'sleep',
          date: '2026-05-30',
          ownerId: 'o1',
          ownerType: 'user',
          subscriptionId: 's1',
        },
      ]),
    );
    const events = new FitbitConnector(client).parseWebhook({
      rawBody,
      headers: {},
    });
    expect(events).toHaveLength(1);
    expect(events[0].providerEventId).toBe('sleep:o1:2026-05-30:s1');
    expect(events[0].type).toBe('sleep.updated');
  });

  it('returns [] for a non-JSON body', () => {
    const { client } = makeHttp();
    expect(
      new FitbitConnector(client).parseWebhook({
        rawBody: Buffer.from('not json'),
        headers: {},
      }),
    ).toEqual([]);
  });
});
