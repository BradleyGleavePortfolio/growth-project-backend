import { createHmac } from 'crypto';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import { OuraConnector } from './oura.connector';
import { OuraRawPayload } from './oura.normalizer';
import { OuraWebhookEvent } from './oura.types';

/**
 * PR-HK-2.k connector tests — real-value assertions.
 *
 * `ProviderHttpClient` is stubbed so no real network is touched: `request`
 * returns a fake `Response`-like with `.json()`/`.ok`. OAuth env is set in
 * beforeEach so the URL/token-exchange paths are exercised deterministically.
 */

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
  OURA_CLIENT_ID: 'client-abc',
  OURA_CLIENT_SECRET: 'secret-xyz',
  OURA_REDIRECT_URI: 'https://app.example.com/oauth/oura/callback',
};

describe('OuraConnector — metadata', () => {
  it('declares OURA provider and oauth2 auth model', () => {
    const { client } = makeHttp();
    const c = new OuraConnector(client);
    expect(c.provider).toBe(WearableProvider.OURA);
    expect(c.authModel).toBe('oauth2');
  });
});

describe('OuraConnector — buildAuthUrl', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('includes all required OAuth params + the full scope set + state', () => {
    const { client } = makeHttp();
    const url = new URL(new OuraConnector(client).buildAuthUrl('user-1', 'st8'));
    expect(url.origin + url.pathname).toBe(
      'https://cloud.ouraring.com/oauth/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.OURA_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe(
      'daily heartrate workout session spo2 personal',
    );
  });

  it('throws if OURA_CLIENT_ID is not configured', () => {
    delete process.env.OURA_CLIENT_ID;
    const { client } = makeHttp();
    expect(() => new OuraConnector(client).buildAuthUrl('u', 's')).toThrow(
      /OURA_CLIENT_ID/,
    );
  });
});

describe('OuraConnector — exchangeCode', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('POSTs the token endpoint and maps a successful response to a TokenSet', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 86400,
        token_type: 'Bearer',
        scope: 'daily heartrate personal',
      }),
    );
    const before = Date.now();
    const ts = await new OuraConnector(client).exchangeCode('auth-code-1');

    expect(calls[0].url).toBe('https://api.ouraring.com/oauth/token');
    expect(calls[0].init.method).toBe('POST');
    const body = String(calls[0].init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code-1');
    expect(body).toContain('client_secret=secret-xyz');

    expect(ts.accessToken).toBe('at-1');
    expect(ts.refreshToken).toBe('rt-1');
    expect(ts.scopes).toEqual(['daily', 'heartrate', 'personal']);
    expect(ts.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 86_400_000 - 2000,
    );
  });

  it('propagates a ProviderHttpError on a token-endpoint failure', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new ProviderHttpError('oura.exchangeCode: HTTP 400', 1, 400));
    await expect(
      new OuraConnector(client).exchangeCode('bad-code'),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('throws if the token response has no refresh_token', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ access_token: 'at', expires_in: 3600 }));
    await expect(
      new OuraConnector(client).exchangeCode('code'),
    ).rejects.toThrow(/missing refresh_token/);
  });
});

describe('OuraConnector — refresh', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('refreshes using the connection refresh token and rotates it', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'at-2',
        refresh_token: 'rt-2',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
    const conn = {
      decryptedRefreshToken: 'rt-old',
    } as unknown as WearableConnection;
    const ts = await new OuraConnector(client).refresh(conn);

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
    const ts = await new OuraConnector(client).refresh(conn);
    expect(ts.refreshToken).toBe('rt-keep');
  });

  it('throws when the connection has no refresh token', async () => {
    const { client } = makeHttp();
    await expect(
      new OuraConnector(client).refresh({} as WearableConnection),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe('OuraConnector — verifyWebhook', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  function sign(rawBody: Buffer, timestamp: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(timestamp, 'utf8')
      .update(rawBody)
      .digest('hex')
      .toUpperCase();
  }

  it('accepts a correctly signed delivery (timestamp + rawBody, uppercase hex)', () => {
    const { client } = makeHttp();
    const c = new OuraConnector(client);
    const rawBody = Buffer.from(JSON.stringify({ object_id: 'o1' }));
    const timestamp = '2026-05-31T08:00:00Z';
    const signature = sign(rawBody, timestamp, ENV.OURA_CLIENT_SECRET);
    expect(
      c.verifyWebhook({
        rawBody,
        headers: {
          'x-oura-signature': signature,
          'x-oura-timestamp': timestamp,
        },
      }),
    ).toBe(true);
  });

  it('rejects a bad signature', () => {
    const { client } = makeHttp();
    const c = new OuraConnector(client);
    expect(
      c.verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: {
          'x-oura-signature': 'DEADBEEF',
          'x-oura-timestamp': '2026-05-31T08:00:00Z',
        },
      }),
    ).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    const { client } = makeHttp();
    expect(
      new OuraConnector(client).verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { 'x-oura-timestamp': 't' },
      }),
    ).toBe(false);
  });

  it('fails closed when OURA_CLIENT_SECRET is unset', () => {
    delete process.env.OURA_CLIENT_SECRET;
    const { client } = makeHttp();
    expect(
      new OuraConnector(client).verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { 'x-oura-signature': 'X', 'x-oura-timestamp': 't' },
      }),
    ).toBe(false);
  });
});

describe('OuraConnector — backfill + fetchChangedRecord', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const conn = {
    id: 'conn-1',
    user_id: 'user-1',
    decryptedAccessToken: 'at-live',
  } as unknown as WearableConnection;

  it('clamps the backfill window to ≤30d and wraps records with context', async () => {
    const { client, calls, enqueue } = makeHttp();
    // 4 daily + 3 longform + 1 datetime = 8 collection fetches; queue empty
    // pages for all but daily_activity.
    for (let i = 0; i < 8; i++) {
      if (i === 2) {
        // daily_activity position (daily_sleep, daily_readiness, daily_activity)
        enqueue(
          fakeResponse({
            data: [{ id: 'a1', day: '2026-05-29', steps: 8421 }],
            next_token: null,
          }),
        );
      } else {
        enqueue(fakeResponse({ data: [], next_token: null }));
      }
    }
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1y ago
    const records = await new OuraConnector(client).backfill(conn, since);

    // Window clamped: the start_date sent must be within ~30d of now.
    const dailyCall = calls.find((c) => c.url.includes('daily_activity'))!;
    const startDate = new URL(dailyCall.url).searchParams.get('start_date')!;
    const ageDays =
      (Date.now() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(31);

    expect(records).toHaveLength(1);
    const payload = records[0].payload as OuraRawPayload;
    expect(payload.collection).toBe('daily_activity');
    expect(payload.userId).toBe('user-1');
    expect(payload.connectionId).toBe('conn-1');
  });

  it('throws when the connection has no access token', async () => {
    const { client } = makeHttp();
    await expect(
      new OuraConnector(client).backfill(
        { id: 'c', user_id: 'u' } as WearableConnection,
        new Date(),
      ),
    ).rejects.toThrow(/no access token/);
  });

  it('fetchChangedRecord pulls the single object and wraps it', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(fakeResponse({ id: 'sleep-9', day: '2026-05-31', score: 80 }));
    const event: OuraWebhookEvent = {
      event_type: 'update',
      data_type: 'daily_sleep',
      object_id: 'sleep-9',
      event_time: '2026-05-31T08:00:00Z',
      user_id: 'oura-user-1',
    };
    const out = await new OuraConnector(client).fetchChangedRecord(conn, event);
    expect(calls[0].url).toBe(
      'https://api.ouraring.com/v2/usercollection/daily_sleep/sleep-9',
    );
    expect(out).toHaveLength(1);
    expect((out[0].payload as OuraRawPayload).collection).toBe('daily_sleep');
  });

  it('returns no records for an unknown data_type', async () => {
    const { client } = makeHttp();
    const out = await new OuraConnector(client).fetchChangedRecord(conn, {
      event_type: 'create',
      data_type: 'pregnancy',
      object_id: 'x',
      event_time: 't',
      user_id: 'u',
    });
    expect(out).toEqual([]);
  });
});

describe('OuraConnector — eventId', () => {
  it('builds a stable id from data_type:object_id:event_type:event_time', () => {
    const { client } = makeHttp();
    const id = new OuraConnector(client).eventId({
      event_type: 'update',
      data_type: 'sleep',
      object_id: 'abc',
      event_time: '2026-05-31T08:00:00Z',
      user_id: 'u',
    });
    expect(id).toBe('sleep:abc:update:2026-05-31T08:00:00Z');
  });
});
