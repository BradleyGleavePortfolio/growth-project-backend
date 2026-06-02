import { Logger } from '@nestjs/common';
import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  ProviderHttpClient,
  ProviderHttpError,
} from '../../http/provider-http-client';
import {
  WithingsConnector,
  redactErrorMessage,
} from './withings.connector';
import { WithingsRawPayload } from './withings.normalizer';
import { WithingsNotifyEvent } from './withings.types';
import { PrismaService } from '../../../prisma.service';

/**
 * PR-HK-2.i connector tests — real-value assertions.
 *
 * `ProviderHttpClient` is replaced with a mock so no real network is touched:
 * `request` returns a fake `Response`-like with `.json()`. OAuth + webhook env
 * is set in beforeEach so the URL/token/verify paths are exercised
 * deterministically and asserted against concrete provider-shaped values.
 */

/** Minimal Prisma mock exposing only the connection.update path. */
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
  WITHINGS_CLIENT_ID: 'client-abc',
  WITHINGS_CLIENT_SECRET: 'secret-xyz',
  WITHINGS_REDIRECT_URI: 'https://app.example.com/oauth/withings/callback',
  WITHINGS_WEBHOOK_SECRET: 'hook-secret-1',
};

/** Wrap a body in the Withings `{ status: 0, body }` success envelope. */
function ok(body: unknown): Response {
  return fakeResponse({ status: 0, body });
}

describe('WithingsConnector — metadata', () => {
  it('declares WITHINGS provider and oauth2 auth model', () => {
    const { client } = makeHttp();
    const c = new WithingsConnector(client);
    expect(c.provider).toBe(WearableProvider.WITHINGS);
    expect(c.authModel).toBe('oauth2');
  });
});

describe('WithingsConnector — buildAuthUrl', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('includes all required OAuth params + the comma-joined scope set + state', () => {
    const { client } = makeHttp();
    const url = new URL(
      new WithingsConnector(client).buildAuthUrl('user-1', 'st8'),
    );
    expect(url.origin + url.pathname).toBe(
      'https://account.withings.com/oauth2_user/authorize2',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.WITHINGS_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe('user.metrics,user.activity');
  });

  it('throws if WITHINGS_CLIENT_ID is not configured', () => {
    delete process.env.WITHINGS_CLIENT_ID;
    const { client } = makeHttp();
    expect(() => new WithingsConnector(client).buildAuthUrl('u', 's')).toThrow(
      /WITHINGS_CLIENT_ID/,
    );
  });
});

describe('WithingsConnector — exchangeCode', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('POSTs the token endpoint (action=requesttoken) and maps body → TokenSet', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      ok({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 10800,
        token_type: 'Bearer',
        scope: 'user.metrics user.activity',
        userid: 424242,
      }),
    );
    const before = Date.now();
    const ts = await new WithingsConnector(client).exchangeCode('auth-code-1');

    expect(calls[0].url).toBe('https://wbsapi.withings.net/v2/oauth2');
    expect(calls[0].init.method).toBe('POST');
    const body = String(calls[0].init.body);
    expect(body).toContain('action=requesttoken');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code-1');
    expect(body).toContain('client_secret=secret-xyz');

    expect(ts.accessToken).toBe('at-1');
    expect(ts.refreshToken).toBe('rt-1');
    expect(ts.scopes).toEqual(['user.metrics', 'user.activity']);
    expect(ts.externalAccountId).toBe('424242');
    expect(ts.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 10_800_000 - 2000,
    );
  });

  it('throws on a non-zero Withings application status even with HTTP 200', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(fakeResponse({ status: 401, error: 'invalid client' }));
    await expect(
      new WithingsConnector(client).exchangeCode('bad-code'),
    ).rejects.toThrow(/Withings status 401/);
  });

  it('propagates a ProviderHttpError on a token-endpoint transport failure', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new ProviderHttpError('withings.exchangeCode: HTTP 503', 1, 503));
    await expect(
      new WithingsConnector(client).exchangeCode('code'),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('throws if the token body has no refresh_token', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(ok({ access_token: 'at', expires_in: 3600 }));
    await expect(
      new WithingsConnector(client).exchangeCode('code'),
    ).rejects.toThrow(/missing refresh_token/);
  });
});

describe('WithingsConnector — refresh', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  it('refreshes using the connection refresh token and rotates it', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      ok({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    );
    const conn = {
      decryptedRefreshToken: 'rt-old',
    } as unknown as WearableConnection;
    const ts = await new WithingsConnector(client).refresh(conn);

    const body = String(calls[0].init.body);
    expect(body).toContain('action=requesttoken');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rt-old');
    expect(ts.accessToken).toBe('at-2');
    expect(ts.refreshToken).toBe('rt-2');
  });

  it('falls back to the existing refresh token when the provider omits a rotated one', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(ok({ access_token: 'at-3', expires_in: 3600 }));
    const conn = {
      decryptedRefreshToken: 'rt-keep',
    } as unknown as WearableConnection;
    const ts = await new WithingsConnector(client).refresh(conn);
    expect(ts.refreshToken).toBe('rt-keep');
  });

  it('throws when the connection has no refresh token', async () => {
    const { client } = makeHttp();
    await expect(
      new WithingsConnector(client).refresh({} as WearableConnection),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe('WithingsConnector — verifyWebhook (secret callback URL)', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  // The EXACT Withings Health Data notify callback body: four form fields,
  // NO body signature and NO synthetic HMAC header. Authenticity is the
  // secret callback URL we registered, surfaced to the verifier as the
  // normalized `x-webhook-secret` header.
  const CALLBACK_BODY = Buffer.from(
    'userid=424242&startdate=1780182000&enddate=1780210800&appli=44',
  );

  it('accepts a genuine Withings callback that presents the registered secret', () => {
    const { client } = makeHttp();
    const c = new WithingsConnector(client);
    expect(
      c.verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'x-webhook-secret': ENV.WITHINGS_WEBHOOK_SECRET },
      }),
    ).toBe(true);
  });

  it('accepts the secret regardless of header casing', () => {
    const { client } = makeHttp();
    const c = new WithingsConnector(client);
    expect(
      c.verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'X-Webhook-Secret': ENV.WITHINGS_WEBHOOK_SECRET },
      }),
    ).toBe(true);
  });

  it('rejects a callback presenting the wrong secret', () => {
    const { client } = makeHttp();
    expect(
      new WithingsConnector(client).verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'x-webhook-secret': 'not-the-secret' },
      }),
    ).toBe(false);
  });

  it('rejects a callback that presents no secret at all (fail closed)', () => {
    const { client } = makeHttp();
    expect(
      new WithingsConnector(client).verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: {},
      }),
    ).toBe(false);
  });

  it('does NOT require a synthetic HMAC signature header (no x-withings-signature)', () => {
    // Regression: a real Withings callback carries no x-withings-signature.
    // It must still authenticate purely on the secret URL token.
    const { client } = makeHttp();
    expect(
      new WithingsConnector(client).verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'x-webhook-secret': ENV.WITHINGS_WEBHOOK_SECRET },
      }),
    ).toBe(true);
  });

  it('rejects a secret of a different length without throwing (timing-safe length guard)', () => {
    const { client } = makeHttp();
    expect(
      new WithingsConnector(client).verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'x-webhook-secret': 'short' },
      }),
    ).toBe(false);
  });

  it('fails closed when WITHINGS_WEBHOOK_SECRET is unset', () => {
    delete process.env.WITHINGS_WEBHOOK_SECRET;
    const { client } = makeHttp();
    expect(
      new WithingsConnector(client).verifyWebhook({
        rawBody: CALLBACK_BODY,
        headers: { 'x-webhook-secret': 'anything' },
      }),
    ).toBe(false);
  });
});

describe('WithingsConnector — backfill + fetchChangedRecord', () => {
  beforeEach(() => Object.assign(process.env, ENV));

  const conn = {
    id: 'conn-1',
    user_id: 'user-1',
    decryptedAccessToken: 'at-live',
  } as unknown as WearableConnection;

  it('clamps the backfill window to ≤90d, pages, and wraps records with context', async () => {
    const { client, calls, enqueue } = makeHttp();
    // Measures: page 1 (more=1) then page 2 (more=0). Sleep: single page.
    enqueue(
      ok({
        measuregrps: [
          {
            grpid: 1,
            date: 1780214400,
            measures: [{ type: 1, value: 70000, unit: -3 }],
          },
        ],
        more: 1,
        offset: 1,
      }),
    );
    enqueue(
      ok({
        measuregrps: [
          {
            grpid: 2,
            date: 1780214400,
            measures: [{ type: 6, value: 2000, unit: -2 }],
          },
        ],
        more: 0,
      }),
    );
    enqueue(
      ok({
        series: [
          {
            id: 9,
            startdate: 1780182000,
            enddate: 1780210800,
            data: { total_sleep_time: 25200 },
          },
        ],
        more: 0,
      }),
    );

    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1y ago
    const records = await new WithingsConnector(client).backfill(conn, since);

    // Window clamped: the measure startdate must be within ~90d of now.
    const measCall = calls.find((c) => c.url.includes('/measure'))!;
    const measBody = String(measCall.init.body);
    const startMatch = /startdate=(\d+)/.exec(measBody)!;
    const startEpochMs = Number(startMatch[1]) * 1000;
    const ageDays = (Date.now() - startEpochMs) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(91);

    // 2 measure pages + 1 sleep page = 3 records.
    expect(records).toHaveLength(3);
    const collections = records.map(
      (r) => (r.payload as WithingsRawPayload).collection,
    );
    expect(collections.filter((c) => c === 'measure')).toHaveLength(2);
    expect(collections.filter((c) => c === 'sleep')).toHaveLength(1);
    const first = records[0].payload as WithingsRawPayload;
    expect(first.userId).toBe('user-1');
    expect(first.connectionId).toBe('conn-1');
    // Pagination actually issued a second measure request.
    expect(calls.filter((c) => c.url.includes('/measure'))).toHaveLength(2);
  });

  it('throws when the connection has no access token', async () => {
    const { client } = makeHttp();
    await expect(
      new WithingsConnector(client).backfill(
        { id: 'c', user_id: 'u' } as WearableConnection,
        new Date(),
      ),
    ).rejects.toThrow(/no access token/);
  });

  it('fetchChangedRecord pulls measures for an appli=1 (weight) notification', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      ok({
        measuregrps: [
          {
            grpid: 5,
            date: 1780214400,
            measures: [{ type: 10, value: 118, unit: 0 }],
          },
        ],
        more: 0,
      }),
    );
    const event: WithingsNotifyEvent = {
      userid: '424242',
      startdate: '1780214000',
      enddate: '1780214800',
      appli: '1',
    };
    const out = await new WithingsConnector(client).fetchChangedRecord(
      conn,
      event,
    );
    expect(calls[0].url).toBe('https://wbsapi.withings.net/measure');
    expect(out).toHaveLength(1);
    expect((out[0].payload as WithingsRawPayload).collection).toBe('measure');
  });

  it('fetchChangedRecord pulls sleep summaries for an appli=44 notification', async () => {
    const { client, calls, enqueue } = makeHttp();
    enqueue(
      ok({
        series: [
          {
            id: 3,
            startdate: 1780182000,
            enddate: 1780210800,
            data: { total_sleep_time: 25200 },
          },
        ],
        more: 0,
      }),
    );
    const out = await new WithingsConnector(client).fetchChangedRecord(conn, {
      userid: '424242',
      startdate: '1780182000',
      enddate: '1780210800',
      appli: '44',
    });
    expect(calls[0].url).toBe('https://wbsapi.withings.net/v2/sleep');
    expect(out).toHaveLength(1);
    expect((out[0].payload as WithingsRawPayload).collection).toBe('sleep');
  });

  it('returns no records for an unknown appli category', async () => {
    const { client } = makeHttp();
    const out = await new WithingsConnector(client).fetchChangedRecord(conn, {
      userid: '1',
      startdate: '1',
      enddate: '2',
      appli: '99',
    });
    expect(out).toEqual([]);
  });
});

describe('WithingsConnector — outage marking', () => {
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
        'withings.backfill.measure: HTTP 502 for Authorization: Bearer at-live-SECRET and client_secret=secret-xyz',
      ),
    );
    const c = new WithingsConnector(client, prisma);
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

  it('marks the connection error when refresh fails (redacts refresh_token), then rethrows', async () => {
    const { client, enqueue } = makeHttp();
    const { prisma, update } = makePrisma();
    enqueue(
      new ProviderHttpError(
        'withings.refresh: HTTP 401 invalid_grant refresh_token=rt-live-LEAK',
        1,
        401,
      ),
    );
    const c = new WithingsConnector(client, prisma);
    await expect(c.refresh(conn)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'conn-err-1' },
      data: {
        status: 'error',
        last_error: expect.stringContaining('refresh_token=[REDACTED]'),
      },
    });
    expect(update.mock.calls[0][0].data.last_error).not.toContain(
      'rt-live-LEAK',
    );
  });

  it('still rethrows (and does not crash) when no PrismaService is wired', async () => {
    const { client, enqueue } = makeHttp();
    enqueue(new Error('withings.backfill.measure: HTTP 500'));
    const c = new WithingsConnector(client);
    await expect(c.backfill(conn, new Date())).rejects.toThrow(/HTTP 500/);
  });

  it('rethrows the ORIGINAL provider error and logs (does not swallow) when the error-status persistence itself fails', async () => {
    const { client, enqueue } = makeHttp();
    const update = jest.fn(async () => {
      throw new Error('db connection lost while persisting last_error');
    });
    const prisma = {
      wearableConnection: { update },
    } as unknown as PrismaService;
    enqueue(new Error('withings.backfill.measure: HTTP 502 upstream down'));
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const c = new WithingsConnector(client, prisma);

    // The original provider failure must still propagate, NOT the DB error.
    await expect(c.backfill(conn, new Date())).rejects.toThrow(/HTTP 502/);
    expect(update).toHaveBeenCalledTimes(1);

    // The marking failure must be observable via a structured log, not silent.
    const markFailLog = errorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        (call[0] as { msg?: string }).msg ===
          'wearables.withings.error_marking_failed',
    );
    expect(markFailLog).toBeDefined();
    const logged = markFailLog![0] as {
      conn_id?: string;
      error_message?: string;
    };
    expect(logged.conn_id).toBe('conn-err-1');
    expect(logged.error_message).toContain('db connection lost');
    errorSpy.mockRestore();
  });
});

describe('redactErrorMessage', () => {
  it('strips token=, code=, client_secret=, access_token=, refresh_token=, signature= values', () => {
    const out = redactErrorMessage(
      new Error(
        'fail token=abc code=xyz client_secret=shh access_token=AT refresh_token=RT signature=SIG keep=ok',
      ),
    );
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('code=[REDACTED]');
    expect(out).toContain('client_secret=[REDACTED]');
    expect(out).toContain('access_token=[REDACTED]');
    expect(out).toContain('refresh_token=[REDACTED]');
    expect(out).toContain('signature=[REDACTED]');
    expect(out).toContain('keep=ok');
    expect(out).not.toContain('abc');
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

describe('WithingsConnector — eventId', () => {
  it('builds a stable id from userid:appli:startdate:enddate', () => {
    const { client } = makeHttp();
    const id = new WithingsConnector(client).eventId({
      userid: '424242',
      startdate: '1780182000',
      enddate: '1780210800',
      appli: '44',
    });
    expect(id).toBe('424242:44:1780182000:1780210800');
  });
});
