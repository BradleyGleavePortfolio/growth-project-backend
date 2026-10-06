/**
 * C-636-5: with tracesSampleRate 0.1, about one in ten `GET
 * /v1/me/data-export/download?token=<jwt>` transactions used to reach Sentry
 * with the live 5-minute bearer token in `http.url` / `http.target`, and
 * outgoing spans to storage carried signed URLs. beforeSend never sees
 * transactions, so the options now carry a beforeSendTransaction scrub.
 *
 * C-636-4: error events keep application-owned `code` / `stage` tags (they
 * were dropped by the tag allowlist), but only values shaped like a code.
 */
jest.mock('@sentry/node', () => ({ init: jest.fn() }));

import {
  buildSentryOptions,
  scrubTransactionEvent,
  SentryTransactionEvent,
} from '../../src/observability/sentry-config';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';

function transaction(): SentryTransactionEvent {
  return {
    type: 'transaction',
    transaction: `GET /v1/me/data-export/download?token=${TOKEN}`,
    request: {
      url: `https://api.example.test/v1/me/data-export/download?token=${TOKEN}`,
      method: 'GET',
      query_string: `token=${TOKEN}`,
    },
    contexts: {
      trace: {
        span_id: 'a',
        trace_id: 'b',
        op: 'http.server',
        data: {
          'http.url': `https://api.example.test/v1/me/data-export/download?token=${TOKEN}`,
          'http.target': `/v1/me/data-export/download?token=${TOKEN}`,
          'url.query': `token=${TOKEN}`,
          'http.method': 'GET',
          'http.route': '/v1/me/data-export/download',
        },
      },
    },
    spans: [
      {
        span_id: 'c',
        trace_id: 'b',
        start_timestamp: 1,
        op: 'http.client',
        description:
          'GET https://storage.example.test/object/sign/data-exports/x.json?token=signed',
        data: {
          'url.full': 'https://storage.example.test/object/sign/data-exports/x.json?token=signed',
        },
      },
      {
        span_id: 'd',
        trace_id: 'b',
        start_timestamp: 1,
        op: 'db',
        description: 'SELECT 1 WHERE a = ?',
        data: {},
      },
    ],
  };
}

describe('Sentry transaction scrub (C-636-5)', () => {
  it('removes every query string from the transaction, request, trace and HTTP spans', () => {
    const out = scrubTransactionEvent(transaction());
    const text = JSON.stringify(out);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('token=signed');
    expect(out.transaction).toBe('GET /v1/me/data-export/download');
    expect(out.request?.url).toBe('https://api.example.test/v1/me/data-export/download');
    expect(out.request?.query_string).toBeUndefined();
    expect(out.contexts?.trace?.data).toEqual({
      'http.url': 'https://api.example.test/v1/me/data-export/download',
      'http.target': '/v1/me/data-export/download',
      'http.method': 'GET',
      'http.route': '/v1/me/data-export/download',
    });
    expect(out.spans?.[0].description).toBe(
      'GET https://storage.example.test/object/sign/data-exports/x.json',
    );
  });

  it('leaves non-HTTP span descriptions alone and does not mutate the input', () => {
    const input = transaction();
    const out = scrubTransactionEvent(input);
    expect(out.spans?.[1].description).toBe('SELECT 1 WHERE a = ?');
    expect(input.request?.query_string).toBe(`token=${TOKEN}`);
  });

  it('is wired as beforeSendTransaction in the init options', async () => {
    const opts = buildSentryOptions('https://k@o.ingest.sentry.io/1', { NODE_ENV: 'test' });
    expect(typeof opts.beforeSendTransaction).toBe('function');
    const out = await opts.beforeSendTransaction?.(transaction(), {});
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

describe('Sentry error tags keep machine codes (C-636-4)', () => {
  async function tagsOf(tags: Record<string, string>) {
    const opts = buildSentryOptions('https://k@o.ingest.sentry.io/1', { NODE_ENV: 'test' });
    const out = await opts.beforeSend?.(
      { type: undefined, event_id: 'e', message: 'data export storage unavailable', tags },
      {},
    );
    return out?.tags;
  }

  it('forwards code and stage when they look like codes', async () => {
    expect(
      await tagsOf({ code: 'STORAGE_TIMEOUT', stage: 'download-link', request_id: 'r1' }),
    ).toEqual({
      code: 'STORAGE_TIMEOUT',
      stage: 'download-link',
      request_id: 'r1',
    });
  });

  it('drops code or stage values that are not code-shaped', async () => {
    expect(
      await tagsOf({ code: 'person@example.com has no file', stage: `x?token=${TOKEN}` }),
    ).toEqual({});
  });
});
