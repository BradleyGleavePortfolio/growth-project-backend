import { createHmac } from 'crypto';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import { PolarConnector, redactErrorMessage } from './polar.connector';
import { PolarRawPayload } from './polar.normalizer';
import { PolarWebhookEvent } from './polar.types';
import { PrismaService } from '../../../prisma.service';

/**
 * PR-HK-2.g connector tests — real-value assertions.
 *
 * `ProviderHttpClient` is stubbed so no real network is touched: `request`
 * returns a fake `Response`-like with `.json()`/`.text()`/`.ok`/`.status`.
 * OAuth env is set in beforeEach so the URL/token-exchange paths are
 * exercised deterministically.
 */

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
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

function makePrisma(): { prisma: PrismaService; update: jest.Mock } {
  const update = jest.fn(async () => ({}));
  const prisma = {
    wearableConnection: { update },
  } as unknown as PrismaService;
  return { prisma, update };
}

const ENV = {
  POLAR_CLIENT_ID: 'client-abc',
  POLAR_CLIENT_SECRET: 'secret-xyz',
  POLAR_REDIRECT_URI: 'https://app.example.com/oauth/polar/callback',
  POLAR_WEBHOOK_SECRET: 'whsec-123',
};

describe('PolarConnector — metadata', () => {
  it('declares POLAR provider and oauth2 auth model', () => {
    const { client } = makeHttp();
    const c = new PolarConnector(client);
    expect(c.provider).toBe(WearableProvider.POLAR);
    expect(c.authModel).toBe('oauth2');
  });
});

describe('PolarConnector — buildAuthUrl', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('round-trips all required OAuth params + the accesslink scope + state', () => {
    const { client } = makeHttp();
    const url = new URL(new PolarConnector(client).buildAuthUrl('user-1', 'st8'));
    expect(url.origin + url.pathname).toBe(
      'https://flow.polar.com/oauth2/authorization',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.POLAR_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe('accesslink.read_all');
  });

  it('throws if POLAR_CLIENT_ID is not configured', () => {
    delete process.env.POLAR_CLIENT_ID;
    const { client } = makeHttp();
    expect(() => new PolarConnector(client).buildAuthUrl('u', 's')).toThrow(
      /POLAR_CLIENT_ID/,
    );
  });
});

describe('PolarConnector — exchangeCode', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('POSTs the token endpoint with HTTP Basic auth and maps the response', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'at-1',
        token_type: 'bearer',
        expires_in: 86400,
        x_user_id: 475,
      }),
    );
    const ts = await new PolarConnector(client).exchangeCode('auth-code-1');

    expect(calls[0].url).toBe('https://polarremote.com/v2/oauth2/token');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    const expectedBasic = Buffer.from('client-abc:secret-xyz').toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);
    const body = String(calls[0].init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code-1');

    // Polar issues no refresh token; the access token is the durable cred.
    expect(ts.accessToken).toBe('at-1');
    expect(ts.refreshToken).toBe('at-1');
    expect(ts.externalAccountId).toBe('475');
    expect(ts.scopes).toEqual(['accesslink.read_all']);
  });

  it('propagates a ProviderHttpError on a token-endpoint failure', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new ProviderHttpError('polar.exchangeCode: HTTP 400', 1, 400));
    await expect(
      new PolarConnector(client).exchangeCode('bad-code'),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('throws if the token response carries no access_token', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ token_type: 'bearer' }));
    await expect(
      new PolarConnector(client).exchangeCode('code'),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe('PolarConnector — refresh', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('re-presents the stored durable token (Polar tokens do not rotate)', async () => {
    const { client } = makeHttp();
    const conn = {
      decryptedAccessToken: 'at-durable',
    } as unknown as WearableConnection;
    const ts = await new PolarConnector(client).refresh(conn);
    expect(ts.refreshToken).toBe('at-durable');
    expect(ts.accessToken).toBe('at-durable');
    expect(ts.scopes).toEqual(['accesslink.read_all']);
  });

  it('marks the connection error and rethrows when no token is present', async () => {
    const { client } = makeHttp();
    const { prisma, update } = makePrisma();
    const conn = { id: 'conn-1', user_id: 'u' } as unknown as WearableConnection;
    await expect(
      new PolarConnector(client, prisma).refresh(conn),
    ).rejects.toThrow(/no stored token/);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.status).toBe('error');
  });
});

describe('PolarConnector — verifyWebhook', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  function sign(rawBody: Buffer, secret: string): string {
    return createHmac('sha256', secret).update(rawBody).digest('hex');
  }

  it('accepts a correctly signed delivery (lowercase hex HMAC of raw body)', () => {
    const { client } = makeHttp();
    const c = new PolarConnector(client);
    const rawBody = Buffer.from(JSON.stringify({ event: 'PING' }));
    const signature = sign(rawBody, ENV.POLAR_WEBHOOK_SECRET);
    expect(
      c.verifyWebhook({
        rawBody,
        headers: { 'polar-webhook-signature': signature },
      }),
    ).toBe(true);
  });

  it('accepts an uppercase-hex signature too (case-insensitive compare)', () => {
    const { client } = makeHttp();
    const c = new PolarConnector(client);
    const rawBody = Buffer.from('{"event":"PING"}');
    const signature = sign(rawBody, ENV.POLAR_WEBHOOK_SECRET).toUpperCase();
    expect(
      c.verifyWebhook({
        rawBody,
        headers: { 'polar-webhook-signature': signature },
      }),
    ).toBe(true);
  });

  it('rejects a bad signature', () => {
    const { client } = makeHttp();
    expect(
      new PolarConnector(client).verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { 'polar-webhook-signature': 'deadbeef' },
      }),
    ).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    const { client } = makeHttp();
    expect(
      new PolarConnector(client).verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: {},
      }),
    ).toBe(false);
  });

  it('fails closed when POLAR_WEBHOOK_SECRET is unset', () => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    const { client } = makeHttp();
    expect(
      new PolarConnector(client).verifyWebhook({
        rawBody: Buffer.from('{}'),
        headers: { 'polar-webhook-signature': 'X' },
      }),
    ).toBe(false);
  });
});

describe('PolarConnector — backfill + fetchChangedRecord', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const conn = {
    id: 'conn-1',
    user_id: 'user-1',
    decryptedAccessToken: 'at-live',
  } as unknown as WearableConnection;

  it('lists exercises + clamps the per-date window to ≤28d and wraps records', async () => {
    const { client, calls, enqueue } = makeHttp();
    // 1 exercises list call, then sleep+recharge for each of 29 days
    // (clamped from a 1-year `since`). Exercises returns one session; all
    // date calls return 204 (no data) so we assert only the clamp + wrap.
    enqueue(
      fakeResponse([
        {
          id: 99,
          'start-time': '2026-05-30T06:00:00',
          'start-time-utc-offset': 0,
          duration: 'PT40M',
          distance: 8000,
          'heart-rate': { average: 140 },
        },
      ]),
    );
    // Queue 204s for the remaining date-keyed calls.
    for (let i = 0; i < 200; i++) enqueue(fakeResponse(undefined, true, 204));

    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const records = await new PolarConnector(client).backfill(conn, since);

    expect(calls[0].url).toBe('https://www.polaraccesslink.com/v3/exercises');
    // The earliest date-keyed URL must be within ~29d of now (clamp).
    const dateCalls = calls.filter((c) => c.url.includes('/users/sleep/'));
    const firstDate = dateCalls[0].url.split('/users/sleep/')[1];
    const ageDays =
      (Date.now() - new Date(`${firstDate}T00:00:00Z`).getTime()) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(29);

    // Only the single exercise produced records (3 metrics → 1 wrapped record).
    const exerciseRecords = records.filter(
      (r) => (r.payload as PolarRawPayload).resource === 'exercises',
    );
    expect(exerciseRecords).toHaveLength(1);
    const payload = exerciseRecords[0].payload as PolarRawPayload;
    expect(payload.userId).toBe('user-1');
    expect(payload.connectionId).toBe('conn-1');
  });

  it('throws when the connection has no access token', async () => {
    const { client } = makeHttp();
    await expect(
      new PolarConnector(client).backfill(
        { id: 'c', user_id: 'u' } as WearableConnection,
        new Date(),
      ),
    ).rejects.toThrow(/no access token/);
  });

  it('marks the connection error with a REDACTED last_error on a backfill outage, then rethrows', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(
      new Error(
        'polar.backfill.exercises: HTTP 503 for Authorization: Bearer at-live-SECRET and client_secret=secret-xyz',
      ),
    );
    const c = new PolarConnector(client, prisma);
    await expect(c.backfill(conn, new Date())).rejects.toThrow(/HTTP 503/);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'conn-1' });
    expect(arg.data.status).toBe('error');
    expect(arg.data.last_error).toContain('HTTP 503');
    expect(arg.data.last_error).toContain('Bearer [REDACTED]');
    expect(arg.data.last_error).toContain('client_secret=[REDACTED]');
    expect(arg.data.last_error).not.toContain('at-live-SECRET');
    expect(arg.data.last_error).not.toContain('secret-xyz');
  });

  it('fetchChangedRecord trusts the event url only for the AccessLink host', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(fakeResponse({ id: 5, 'start-time': '2026-05-31T06:00:00' }));
    const event: PolarWebhookEvent = {
      event: 'EXERCISE',
      user_id: 475,
      entity_id: 'aQlC83',
      timestamp: '2026-05-31T08:00:00Z',
      url: 'https://www.polaraccesslink.com/v3/exercises/aQlC83',
    };
    const out = await new PolarConnector(client).fetchChangedRecord(conn, event);
    expect(calls[0].url).toBe(
      'https://www.polaraccesslink.com/v3/exercises/aQlC83',
    );
    expect(out).toHaveLength(1);
    expect((out[0].payload as PolarRawPayload).resource).toBe('exercises');
  });

  it('fetchChangedRecord rejects a spoofed (non-AccessLink) url and reconstructs the path', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(fakeResponse({ id: 5, 'start-time': '2026-05-31T06:00:00' }));
    const event: PolarWebhookEvent = {
      event: 'EXERCISE',
      user_id: 475,
      entity_id: 'aQlC83',
      timestamp: '2026-05-31T08:00:00Z',
      url: 'https://evil.example.com/steal',
    };
    await new PolarConnector(client).fetchChangedRecord(conn, event);
    // The SSRF guard ignored the evil host and rebuilt the canonical URL.
    expect(calls[0].url).toBe(
      'https://www.polaraccesslink.com/v3/exercises/aQlC83',
    );
  });

  it('returns no records for a PING / non-data event', async () => {
    const { client } = makeHttp();
    const out = await new PolarConnector(client).fetchChangedRecord(conn, {
      event: 'PING',
      timestamp: '2026-05-31T08:00:00Z',
    });
    expect(out).toEqual([]);
  });
});

describe('PolarConnector — eventId', () => {
  it('builds a stable id from event:user:subject:timestamp', () => {
    const { client } = makeHttp();
    const id = new PolarConnector(client).eventId({
      event: 'EXERCISE',
      user_id: 475,
      entity_id: 'aQlC83',
      timestamp: '2026-05-31T08:00:00Z',
    });
    expect(id).toBe('EXERCISE:475:aQlC83:2026-05-31T08:00:00Z');
  });

  it('uses date as the subject for date-keyed events', () => {
    const { client } = makeHttp();
    const id = new PolarConnector(client).eventId({
      event: 'SLEEP',
      user_id: 475,
      date: '2026-05-31',
      timestamp: '2026-05-31T08:00:00Z',
    });
    expect(id).toBe('SLEEP:475:2026-05-31:2026-05-31T08:00:00Z');
  });
});

describe('redactErrorMessage', () => {
  it('strips token/secret patterns and bearer tokens', () => {
    const out = redactErrorMessage(
      new Error(
        'fail token=abc client_secret=shh access_token=AT Authorization: Bearer eyJ.signature keep=ok',
      ),
    );
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('client_secret=[REDACTED]');
    expect(out).toContain('access_token=[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('keep=ok');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('shh');
    expect(out).not.toContain('eyJ.signature');
  });

  it('caps the message at 500 characters and handles empty', () => {
    expect(redactErrorMessage(new Error('x'.repeat(900))).length).toBe(500);
    expect(redactErrorMessage(new Error(''))).toBe('unknown');
  });
});
