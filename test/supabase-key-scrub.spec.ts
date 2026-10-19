/**
 * KEYS-READY: a Supabase secret or publishable API key value never reaches a
 * log line, a Sentry error event or search text. The key values below are
 * made up and joined at run time so no secret scanner can match this file.
 * The body carries a long digit run so the search stripper's phone rule
 * cannot split a key and leave part of it behind.
 */
jest.mock('@sentry/node', () => ({ init: jest.fn() }));

import { redactSecrets } from '../src/common/redact-secrets';
import {
  composeSearchExcerpt,
  stripPiiForSearch,
} from '../src/community/search/search-pii-strip';
import { AppLoggerService } from '../src/observability/app-logger.service';
import {
  redactLogLine,
  redactObject,
  redactStripeSecretValues,
} from '../src/observability/log-redaction';
import { buildSentryOptions } from '../src/observability/sentry-config';

const BODY = 'KeysReady_Test-0123456789abcdef';
const SB_SECRET = ['sb', 'secret', BODY].join('_');
const SB_PUBLISHABLE = ['sb', 'publishable', BODY].join('_');
const KEYS: Array<[string, string]> = [
  ['secret', SB_SECRET],
  ['publishable', SB_PUBLISHABLE],
];

function expectNoKey(text: string, key: string): void {
  expect(text).not.toContain(key);
  expect(text).not.toContain('KeysReady');
}

describe.each(KEYS)('Supabase %s key value', (_kind, key) => {
  describe('log scrub (src/observability/log-redaction.ts)', () => {
    it('strips the key from plain, URL-encoded and JSON text', () => {
      for (const text of [
        `supabase call failed with apikey=${key}`,
        `GET /realtime/v1/websocket?apikey%3D${key}&vsn=1.0.0`,
        JSON.stringify({ message: `Bearer ${key}` }),
      ]) {
        const out = redactStripeSecretValues(text);
        expectNoKey(out, key);
        expect(out).toContain('[REDACTED]');
      }
    });

    it('strips the key from nested objects and serialised lines', () => {
      expectNoKey(JSON.stringify(redactObject({ detail: { note: `key ${key} here` } })), key);
      expectNoKey(redactLogLine(JSON.stringify({ message: `key ${key}` })), key);
    });

    it('leaves the bare prefix in prose alone', () => {
      expect(redactStripeSecretValues('set the sb_secret_ key')).toBe('set the sb_secret_ key');
    });
  });

  describe.each(['json', 'pretty'])('AppLoggerService stdout (%s)', (format) => {
    const saved = { format: process.env.LOG_FORMAT, level: process.env.LOG_LEVEL };
    let written: string[];
    let spy: jest.SpyInstance;

    beforeEach(() => {
      process.env.LOG_FORMAT = format;
      process.env.LOG_LEVEL = 'verbose';
      written = [];
      spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      spy.mockRestore();
      if (saved.format === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = saved.format;
      if (saved.level === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = saved.level;
    });

    it('never writes the key, from the message, the trace or extra fields', () => {
      const logger = new AppLoggerService();
      logger.error(`supabase admin call failed: ${key}`, `Error: ${key}\n    at x`, 'Auth');
      logger.warn({ apikey_value: key }, 'Auth');
      logger.logStructured('log', `GET /x?apikey=${key}`, { detail: key }, 'HTTP');
      const out = written.join('');
      expect(written).toHaveLength(3);
      expectNoKey(out, key);
      expect(out).toContain('supabase admin call failed');
    });
  });

  describe('Sentry beforeSend (src/observability/sentry-config.ts)', () => {
    it('strips the key from exception, message and logentry text', async () => {
      const opts = buildSentryOptions('https://k@o.ingest.sentry.io/1', { NODE_ENV: 'test' });
      const out = await opts.beforeSend?.(
        {
          type: undefined,
          event_id: 'e1',
          message: `failed with ${key}`,
          logentry: { message: `failed with ${key}`, params: [] },
          exception: { values: [{ type: 'Error', value: `supabase rejected ${key}` }] },
          tags: { request_id: 'r1' },
        },
        { originalException: new Error(`supabase rejected ${key}`) },
      );
      expectNoKey(JSON.stringify(out), key);
      expect(out?.exception?.values?.[0]).toEqual({
        type: 'Error',
        value: 'supabase rejected [REDACTED]',
      });
      expect(out?.message).toBe('failed with [REDACTED]');
      expect(out?.logentry?.message).toBe('failed with [REDACTED]');
    });
  });

  describe('search text (src/community/search/search-pii-strip.ts)', () => {
    it('strips the whole key from an excerpt field', () => {
      const out = stripPiiForSearch(`Week one ${key} recap`);
      expectNoKey(out, key);
      expect(out).toBe('Week one [redacted] recap');
      expectNoKey(composeSearchExcerpt(['Week one', `notes ${key}`]), key);
    });
  });

  describe('redactSecrets (src/common/redact-secrets.ts)', () => {
    it('redacts the key as a value under any key name', () => {
      expect(redactSecrets(key)).toBe('[REDACTED]');
      expect(redactSecrets({ note: key, list: [key] })).toEqual({
        note: '[REDACTED]',
        list: ['[REDACTED]'],
      });
    });
  });
});
