import { createHmac } from 'crypto';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import {
  WahooConnector,
  redactErrorMessage,
  computeWahooDedupKey,
  hashForLog,
} from './wahoo.connector';
import { PrismaService } from '../../../prisma.service';
import { WahooWebhookEvent } from './wahoo.types';

/**
 * PR-HK-2.h connector tests — real-value assertions. `ProviderHttpClient` is
 * stubbed so no real network is touched. OAuth env is set in beforeEach.
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

function makePrisma(): { prisma: PrismaService; update: jest.Mock } {
  const update = jest.fn(async () => ({}));
  const prisma = {
    wearableConnection: { update },
  } as unknown as PrismaService;
  return { prisma, update };
}

function conn(extra: Record<string, unknown> = {}): WearableConnection {
  return {
    id: 'conn-1',
    user_id: 'user-1',
    provider: WearableProvider.WAHOO,
    ...extra,
  } as unknown as WearableConnection;
}

const ENV = {
  WAHOO_CLIENT_ID: 'client-abc',
  WAHOO_CLIENT_SECRET: 'secret-xyz',
  WAHOO_REDIRECT_URI: 'https://app.example.com/oauth/wahoo/callback',
};

describe('WahooConnector — metadata', () => {
  it('declares WAHOO provider and oauth2 auth model', () => {
    const { client } = makeHttp();
    const c = new WahooConnector(client);
    expect(c.provider).toBe(WearableProvider.WAHOO);
    expect(c.authModel).toBe('oauth2');
  });
});

describe('WahooConnector — buildAuthUrl', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('round-trips all OAuth params, the scope set, and state', () => {
    const { client } = makeHttp();
    const url = new URL(new WahooConnector(client).buildAuthUrl('user-1', 'st8'));
    expect(url.origin + url.pathname).toBe(
      'https://api.wahooligan.com/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.WAHOO_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe(
      'user_read workouts_read offline_data',
    );
  });

  it('throws (fail-loud) when a required env var is missing', () => {
    delete process.env.WAHOO_CLIENT_ID;
    const { client } = makeHttp();
    expect(() => new WahooConnector(client).buildAuthUrl('u', 's')).toThrow(
      /WAHOO_CLIENT_ID/,
    );
    Object.assign(process.env, ENV);
  });
});

describe('WahooConnector — exchangeCode', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('exchanges a code and returns a TokenSet (rotated refresh + expiry + account)', async () => {
    const { client, enqueue, calls } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'acc-1',
        refresh_token: 'ref-1',
        expires_in: 7200,
        scope: 'user_read workouts_read offline_data',
        user: { id: 9988 },
      }),
    );
    const before = Date.now();
    const set = await new WahooConnector(client).exchangeCode('the-code');
    expect(set.accessToken).toBe('acc-1');
    expect(set.refreshToken).toBe('ref-1');
    expect(set.externalAccountId).toBe('9988');
    expect(set.scopes).toEqual(['user_read', 'workouts_read', 'offline_data']);
    expect(set.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 7200 * 1000 - 1000,
    );
    // POSTs to the token URL with a form body.
    expect(calls[0].url).toBe('https://api.wahooligan.com/oauth/token');
    expect((calls[0].init as { method: string }).method).toBe('POST');
  });

  it('throws (redacted) on a permanent token error', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new ProviderHttpError('bad', 1, 400));
    await expect(
      new WahooConnector(client).exchangeCode('bad-code'),
    ).rejects.toThrow(/status=400/);
  });
});

describe('WahooConnector — refresh (rotation + fail-explicit)', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('rotates the refresh token and returns the NEW one', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(
      fakeResponse({
        access_token: 'acc-2',
        refresh_token: 'ref-ROTATED',
        expires_in: 7200,
      }),
    );
    const set = await new WahooConnector(client).refresh(
      conn({ refresh_token: 'ref-OLD' }),
    );
    expect(set.refreshToken).toBe('ref-ROTATED');
    expect(set.accessToken).toBe('acc-2');
  });

  it('falls back to the prior refresh token if the provider omits it', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ access_token: 'acc-3', expires_in: 7200 }));
    const set = await new WahooConnector(client).refresh(
      conn({ refresh_token: 'ref-KEEP' }),
    );
    expect(set.refreshToken).toBe('ref-KEEP');
  });

  it('marks the connection status=error on a 401 then rethrows', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(new ProviderHttpError('unauthorized', 1, 401));
    const c = new WahooConnector(client, prisma);
    await expect(c.refresh(conn({ refresh_token: 'ref-x' }))).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0] as {
      where: { id: string };
      data: { status: string; last_error: string };
    };
    expect(arg.where.id).toBe('conn-1');
    expect(arg.data.status).toBe('error');
    expect(typeof arg.data.last_error).toBe('string');
  });

  it('throws when the connection has no refresh token', async () => {
    const { client } = makeHttp();
    await expect(new WahooConnector(client).refresh(conn())).rejects.toThrow(
      /no refresh token/,
    );
  });
});

describe('WahooConnector — backfill (pagination + outage)', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const w = (id: number) => ({
    id,
    starts: '2026-05-30T13:00:00.000Z',
    minutes: 30,
    workout_summary: { distance_accum: '1000.0', heart_rate_avg: '110.0' },
  });

  it('returns wrapped raw records for a single short page', async () => {
    const { client, enqueue, calls } = makeHttp();
    enqueue(fakeResponse({ workouts: [w(1), w(2)] }));
    const records = await new WahooConnector(client).backfill(
      conn({ decryptedAccessToken: 'acc' }),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(records).toHaveLength(2);
    expect(records[0].provider).toBe(WearableProvider.WAHOO);
    expect(records[0].id).toBe('1');
    // Bearer auth header present.
    const init = calls[0].init as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer acc');
  });

  it('pages until a short page is returned', async () => {
    const { client, enqueue, calls } = makeHttp();
    const full = { workouts: Array.from({ length: 100 }, (_, i) => w(i + 1)) };
    enqueue(fakeResponse(full));
    enqueue(fakeResponse({ workouts: [w(101)] }));
    const records = await new WahooConnector(client).backfill(
      conn({ decryptedAccessToken: 'acc' }),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(records).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('page=2');
  });

  it('marks status=error and rethrows on a provider outage', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(new ProviderHttpError('boom', 4, 503));
    const c = new WahooConnector(client, prisma);
    await expect(
      c.backfill(conn({ decryptedAccessToken: 'acc' }), new Date(0)),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    expect(
      (update.mock.calls[0][0] as { data: { status: string } }).data.status,
    ).toBe('error');
  });

  it('throws when the connection has no access token', async () => {
    const { client } = makeHttp();
    await expect(
      new WahooConnector(client).backfill(conn(), new Date(0)),
    ).rejects.toThrow(/no access token/);
  });
});

describe('WahooConnector — verifyWebhook (HMAC + shared token, fail-closed)', () => {
  const SECRET = 'whsec-123';
  const TOKEN = 'wt-abc';

  function signed(bodyObj: unknown, ts = '1717000000'): {
    rawBody: Buffer;
    headers: Record<string, string>;
  } {
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const sig = createHmac('sha256', SECRET)
      .update(ts, 'utf8')
      .update(rawBody)
      .digest('hex');
    return {
      rawBody,
      headers: { 'x-wahoo-signature': sig, 'x-wahoo-timestamp': ts },
    };
  }

  beforeEach(() => {
    process.env.WAHOO_WEBHOOK_SECRET = SECRET;
    process.env.WAHOO_WEBHOOK_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.WAHOO_WEBHOOK_SECRET;
    delete process.env.WAHOO_WEBHOOK_TOKEN;
  });

  it('accepts a valid HMAC + matching webhook_token', () => {
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: TOKEN });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(true);
  });

  it('rejects a tampered body (HMAC mismatch)', () => {
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: TOKEN });
    req.rawBody = Buffer.from(
      JSON.stringify({ event_type: 'tampered', webhook_token: TOKEN }),
    );
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('rejects a wrong webhook_token even with a valid HMAC', () => {
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: 'WRONG' });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    delete process.env.WAHOO_WEBHOOK_SECRET;
    delete process.env.WAHOO_CLIENT_SECRET;
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: TOKEN });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('fails closed when WAHOO_WEBHOOK_TOKEN is unset, even with a valid HMAC', () => {
    // Regression for R1 Finding 1: the shared-token control must be REQUIRED.
    // A valid HMAC delivery with NO configured webhook_token must reject
    // rather than fail open. The body even carries a token; with no expected
    // value configured the connector still refuses to enforce-then-accept.
    delete process.env.WAHOO_WEBHOOK_TOKEN;
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: TOKEN });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('fails closed when WAHOO_WEBHOOK_TOKEN is empty string', () => {
    process.env.WAHOO_WEBHOOK_TOKEN = '';
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary', webhook_token: TOKEN });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('rejects when the body carries no webhook_token even though one is configured', () => {
    const { client } = makeHttp();
    const req = signed({ event_type: 'workout_summary' });
    expect(new WahooConnector(client).verifyWebhook(req)).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    const { client } = makeHttp();
    const rawBody = Buffer.from(JSON.stringify({ event_type: 'x' }));
    expect(
      new WahooConnector(client).verifyWebhook({ rawBody, headers: {} }),
    ).toBe(false);
  });
});

describe('WahooConnector — parseWebhook / eventId / extractWorkoutRecords', () => {
  it('produces a stable provider event id', () => {
    const { client } = makeHttp();
    const event: WahooWebhookEvent = {
      event_type: 'workout_summary',
      workout_summary: {
        id: 77,
        workout: { id: 555, starts: 's', updated_at: '2026-05-30T14:00:00Z' },
      },
    };
    const id = new WahooConnector(client).eventId(event);
    expect(id).toBe('workout_summary:77:555:2026-05-30T14:00:00Z');
  });

  it('extractWorkoutRecords wraps the embedded workout with the summary', () => {
    const { client } = makeHttp();
    const event: WahooWebhookEvent = {
      event_type: 'workout_summary',
      user: { id: 9 },
      workout_summary: {
        distance_accum: '5000.0',
        heart_rate_avg: '130.0',
        workout: { id: 555, starts: '2026-05-30T13:00:00.000Z', minutes: 20 },
      },
    };
    const records = new WahooConnector(client).extractWorkoutRecords(
      conn(),
      event,
    );
    expect(records).toHaveLength(1);
    const samples = new WahooConnector(client).normalize(records);
    const metrics = samples.map((s) => s.metric).sort();
    expect(metrics).toEqual([
      'HEART_RATE_BPM',
      'WORKOUT_DISTANCE_M',
      'WORKOUT_DURATION_MIN',
    ]);
  });

  it('extractWorkoutRecords returns [] when no workout embedded', () => {
    const { client } = makeHttp();
    expect(
      new WahooConnector(client).extractWorkoutRecords(conn(), {
        event_type: 'workout_summary',
      }),
    ).toEqual([]);
  });
});

describe('WahooConnector — helpers', () => {
  it('redactErrorMessage strips bearer tokens and secrets', () => {
    const msg = redactErrorMessage(
      new Error('failed Authorization: Bearer abc.def.ghi and refresh_token=zzz'),
    );
    expect(msg).not.toContain('abc.def.ghi');
    expect(msg).not.toContain('zzz');
    expect(msg).toContain('[REDACTED]');
  });

  it('computeWahooDedupKey is deterministic and provider-scoped', () => {
    const at = new Date('2026-05-30T13:00:00.000Z');
    const a = computeWahooDedupKey('u', 'HEART_RATE_BPM', at, 124);
    const b = computeWahooDedupKey('u', 'HEART_RATE_BPM', at, 124);
    const c = computeWahooDedupKey('u', 'HEART_RATE_BPM', at, 125);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it('hashForLog produces a short non-reversible token', () => {
    const h = hashForLog('user-1');
    expect(h).toHaveLength(16);
    expect(h).not.toContain('user-1');
  });
});
