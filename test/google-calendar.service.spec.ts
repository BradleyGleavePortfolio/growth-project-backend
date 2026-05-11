// test/google-calendar.service.spec.ts
//
// Coverage for GoogleCalendarService.
//
// All tests use a stubbed fetchImpl. ZERO real network calls.
//
// Cases:
//   1. listBusyBlocks: returns busy[] from /freeBusy.
//   2. listBusyBlocks: returns [] when calendar.primary.busy missing.
//   3. createEvent: success returns event id, writes one audit row.
//   4. createEvent: 4xx returns permanent_error and writes NO audit.
//   5. createEvent: 5xx triggers one retry; on retry success returns ok.
//   6. updateEvent: success.
//   7. deleteEvent: success on 204 with empty body.
//   8. refreshAccessToken: caches new token in process.
//   9. refreshAccessToken: returns needs_reauth on OAuth failure.
//  10. getValidAccessToken: returns cached when not expired.
//  11. getValidAccessToken: refreshes when expired.
//  12. watchCalendar: success returns channel + resource id and audits.
//  13. stopWatch: success returns null, audits.
//  14. 401: refresh + ONE retry; on retry success returns ok.
//  15. not_configured short-circuit when OAuth not configured.

import 'reflect-metadata';
import { GoogleCalendarService } from '../src/scheduling/google-calendar/google-calendar.service';

const ORIGINAL_ENV = { ...process.env };

// Phase 2 master switch — adapter short-circuits when off. Tests
// below exercise the real adapter paths, so flag is on for every
// test. Flag-off behavior is covered by the oauth + webhook specs.
beforeEach(() => {
  process.env.FEATURE_GOOGLE_CALENDAR_SYNC = 'true';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

class TestableCalendar extends GoogleCalendarService {
  public setFetchImpl(impl: typeof fetch): void {
    (this as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl;
  }
}

function buildOAuth(opts: {
  configured?: boolean;
  refreshResult?:
    | { access_token: string; expires_in: number }
    | { throw: string };
} = {}) {
  return {
    isConfigured: jest.fn(() => opts.configured ?? true),
    refreshAccessToken: jest.fn(async () => {
      if (opts.refreshResult && 'throw' in opts.refreshResult) {
        throw new Error(opts.refreshResult.throw);
      }
      return (
        opts.refreshResult ?? { access_token: 'at-fresh', expires_in: 3600 }
      );
    }),
  };
}

function buildAudit() {
  return { write: jest.fn(async () => undefined) };
}

function buildService(opts: {
  configured?: boolean;
  refreshResult?:
    | { access_token: string; expires_in: number }
    | { throw: string };
} = {}) {
  const oauth = buildOAuth(opts);
  const audit = buildAudit();
  const svc = new TestableCalendar(oauth as never, audit as never);
  return { svc, oauth, audit };
}

const conn = {
  id: 'conn-1',
  user_id: 'user-1',
  external_account_id: 'coach@example.test',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  // 204 is the typical case; the Fetch spec forbids a body on 204, so
  // we pass null. For any other code we still use null since the
  // service expects an empty body anyway when we set
  // expectEmptyBody=true.
  return new Response(null, { status });
}

describe('GoogleCalendarService.listBusyBlocks', () => {
  it('returns busy[] from /freeBusy', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const { svc } = buildService();
    svc.setFetchImpl(async () =>
      jsonResponse({
        calendars: {
          primary: { busy: [{ start: '2026-05-12T09:00:00Z', end: '2026-05-12T10:00:00Z' }] },
        },
      }),
    );
    const out = await svc.listBusyBlocks(conn, {
      timeMin: '2026-05-12T00:00:00Z',
      timeMax: '2026-05-13T00:00:00Z',
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.data).toHaveLength(1);
      expect(out.data[0]?.start).toBe('2026-05-12T09:00:00Z');
    }
  });

  it('returns [] when calendars.primary.busy is missing', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const { svc } = buildService();
    svc.setFetchImpl(async () => jsonResponse({ calendars: {} }));
    const out = await svc.listBusyBlocks(conn, {
      timeMin: '2026-05-12T00:00:00Z',
      timeMax: '2026-05-13T00:00:00Z',
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data).toEqual([]);
  });
});

describe('GoogleCalendarService.createEvent', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  });

  it('success returns event id and writes one audit row', async () => {
    const { svc, audit } = buildService();
    svc.setFetchImpl(async () => jsonResponse({ id: 'evt-1', status: 'confirmed' }, 200));
    const out = await svc.createEvent(conn, {
      summary: 'Coaching session',
      start: { dateTime: '2026-05-12T15:00:00Z' },
      end: { dateTime: '2026-05-12T15:30:00Z' },
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data.id).toBe('evt-1');
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect((audit.write.mock.calls[0] as unknown[])?.[0]).toMatchObject({
      action: 'calendar.event_created',
      actorId: 'user-1',
    });
  });

  it('4xx returns permanent_error and writes NO audit row', async () => {
    const { svc, audit } = buildService();
    svc.setFetchImpl(async () =>
      jsonResponse({ error: { message: 'bad request' } }, 400),
    );
    const out = await svc.createEvent(conn, {
      summary: 'x',
      start: { dateTime: '2026-05-12T15:00:00Z' },
      end: { dateTime: '2026-05-12T15:30:00Z' },
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('permanent_error');
    if (out.kind === 'permanent_error') expect(out.status).toBe(400);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('5xx triggers one retry; on retry success returns ok', async () => {
    const { svc } = buildService();
    let calls = 0;
    svc.setFetchImpl(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'flaky' }, 503)
        : jsonResponse({ id: 'evt-1' }, 200);
    });
    const out = await svc.createEvent(conn, {
      summary: 'x',
      start: { dateTime: '2026-05-12T15:00:00Z' },
      end: { dateTime: '2026-05-12T15:30:00Z' },
      idempotencyKey: 'k-1',
    });
    expect(calls).toBe(2);
    expect(out.kind).toBe('ok');
  });

  it('5xx then 5xx: returns transient_error after the one retry', async () => {
    const { svc } = buildService();
    svc.setFetchImpl(async () => jsonResponse({ error: 'still bad' }, 502));
    const out = await svc.createEvent(conn, {
      summary: 'x',
      start: { dateTime: '2026-05-12T15:00:00Z' },
      end: { dateTime: '2026-05-12T15:30:00Z' },
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('transient_error');
  });
});

describe('GoogleCalendarService.updateEvent', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  });

  it('returns ok with the patched event body', async () => {
    const { svc } = buildService();
    svc.setFetchImpl(async () =>
      jsonResponse({ id: 'evt-1', summary: 'New title' }),
    );
    const out = await svc.updateEvent(conn, 'evt-1', { summary: 'New title' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data.summary).toBe('New title');
  });
});

describe('GoogleCalendarService.deleteEvent', () => {
  it('success on 204 with empty body', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
    const { svc, audit } = buildService();
    svc.setFetchImpl(async () => emptyResponse(204));
    const out = await svc.deleteEvent(conn, 'evt-1');
    expect(out.kind).toBe('ok');
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar.event_deleted' }),
    );
  });
});

describe('GoogleCalendarService token management', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  });

  it('refreshAccessToken caches the new token in process', async () => {
    const { svc, oauth } = buildService();
    const out = await svc.refreshAccessToken(conn);
    expect(out.kind).toBe('ok');
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(1);
    // Second call should reuse the cache (no further oauth invocation).
    const cached = await svc.getValidAccessToken(conn);
    expect(cached.kind).toBe('ok');
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('refreshAccessToken returns needs_reauth when OAuth rejects', async () => {
    const { svc } = buildService({
      refreshResult: { throw: 'invalid_grant' },
    });
    const out = await svc.refreshAccessToken(conn);
    expect(out.kind).toBe('needs_reauth');
  });

  it('getValidAccessToken refreshes when the cached token is expired', async () => {
    const { svc, oauth } = buildService();
    // First refresh with a tiny lifetime so the next read forces a re-refresh.
    oauth.refreshAccessToken.mockResolvedValueOnce({
      access_token: 'at-old',
      expires_in: 0,
    });
    oauth.refreshAccessToken.mockResolvedValueOnce({
      access_token: 'at-new',
      expires_in: 3600,
    });
    await svc.refreshAccessToken(conn); // seeds at-old
    const out = await svc.getValidAccessToken(conn);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.data).toBe('at-new');
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('not_configured short-circuit when OAuth is not configured', async () => {
    const { svc } = buildService({ configured: false });
    const out = await svc.refreshAccessToken(conn);
    expect(out.kind).toBe('not_configured');
  });
});

describe('GoogleCalendarService.watchCalendar + stopWatch', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  });

  it('watchCalendar returns channel + resource id and audits', async () => {
    const { svc, audit } = buildService();
    svc.setFetchImpl(async () =>
      jsonResponse({ id: 'ch-1', resourceId: 'res-1', resourceUri: 'uri-1' }),
    );
    const out = await svc.watchCalendar(conn, {
      channelId: 'ch-1',
      webhookUrl: 'https://api.test/webhooks/google-calendar',
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.data.id).toBe('ch-1');
      expect(out.data.resourceId).toBe('res-1');
    }
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar.watch_started' }),
    );
  });

  it('stopWatch returns ok with null body and audits', async () => {
    const { svc, audit } = buildService();
    svc.setFetchImpl(async () => emptyResponse(204));
    const out = await svc.stopWatch(conn, 'ch-1', 'res-1');
    expect(out.kind).toBe('ok');
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'calendar.watch_stopped' }),
    );
  });
});

describe('GoogleCalendarService 401 handling', () => {
  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.test/cb';
  });

  it('401 triggers refresh + one retry; on retry success returns ok', async () => {
    const { svc, oauth } = buildService();
    let calls = 0;
    svc.setFetchImpl(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'unauthorized' }, 401)
        : jsonResponse({ id: 'evt-1' }, 200);
    });
    const out = await svc.createEvent(conn, {
      summary: 'x',
      start: { dateTime: '2026-05-12T15:00:00Z' },
      end: { dateTime: '2026-05-12T15:30:00Z' },
      idempotencyKey: 'k-1',
    });
    expect(out.kind).toBe('ok');
    expect(calls).toBe(2);
    // Refresh was called twice: once seed (no cached token) and once
    // after the 401.
    expect(oauth.refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
