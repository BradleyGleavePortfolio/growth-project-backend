/**
 * Audit #6 P1-1 — credential redaction unit tests for the CRM adapter
 * error path. Every adapter routes thrown axios errors through
 * `safeErrorMessage` before logging or rethrowing; this file pins the
 * patterns that MUST never make it out unredacted.
 */

import {
  redactSecrets,
  safeErrorMessage,
} from '../src/landing-pages/crm/_redact';

describe('_redact / safeErrorMessage', () => {
  describe('JSON-quoted secrets', () => {
    it.each([
      ['"access_token":"sk-live-leak-1234"', 'access_token', 'sk-live-leak-1234'],
      ['"api_key":"mc-us19-leak"', 'api_key', 'mc-us19-leak'],
      ['"api_token":"AC_LEAK"', 'api_token', 'AC_LEAK'],
      ['"secret":"shared-leak"', 'secret', 'shared-leak'],
      ['"refresh_token":"rt_leak"', 'refresh_token', 'rt_leak'],
      ['"client_secret":"cs_leak"', 'client_secret', 'cs_leak'],
    ])('redacts %p', (input, _key, leakedValue) => {
      const out = redactSecrets(input);
      expect(out).not.toContain(leakedValue);
      expect(out).toContain('[REDACTED]');
    });
  });

  describe('header-style secrets', () => {
    it.each([
      [`Authorization: Bearer sk-leak-9999`, 'sk-leak-9999'],
      [`'Api-Token': 'tok_leak_abc'`, 'tok_leak_abc'],
      [`"X-Api-Key": "xak_leak_xyz"`, 'xak_leak_xyz'],
      [`X-Auth-Token=auth_leak_123`, 'auth_leak_123'],
      [`"X-TGP-Signature": "sha256=hmac_leak"`, 'hmac_leak'],
    ])('redacts %p', (input, leakedValue) => {
      const out = redactSecrets(input);
      expect(out).not.toContain(leakedValue);
      expect(out).toContain('[REDACTED]');
    });
  });

  describe('HTTP Basic auth (Audit #6 P1-1)', () => {
    it('redacts a raw "Basic <base64>" pair (Mailchimp pattern)', () => {
      // "anystring:secret-us19" base64 = YW55c3RyaW5nOnNlY3JldC11czE5
      const input =
        'Request failed: Authorization: Basic YW55c3RyaW5nOnNlY3JldC11czE5';
      const out = redactSecrets(input);
      // Primary contract: the base64-encoded credential must be gone.
      expect(out).not.toContain('YW55c3RyaW5nOnNlY3JldC11czE5');
      // Auxiliary contract: [REDACTED] marker present so a downstream
      // reader can see the secret was scrubbed (vs. accidentally empty).
      expect(out).toContain('[REDACTED]');
    });

    it('redacts standalone "Basic <base64>" anywhere in the line', () => {
      const out = redactSecrets('headers={"Authorization":"Basic AAAA"} fail');
      // Either the JSON-quoted Authorization match OR the Basic-prefix
      // match suffices; both should fire on this string.
      expect(out).not.toContain('AAAA');
    });

    it('redacts the pre-encode anystring:<api_key> form', () => {
      const out = redactSecrets('basicAuth: anystring:mc-leak-9999');
      expect(out).not.toContain('mc-leak-9999');
      expect(out).toContain('anystring:[REDACTED]');
    });
  });

  describe('Bearer tokens', () => {
    it('redacts a standalone Bearer header value', () => {
      expect(redactSecrets('Bearer pk_live_AAAA-BBBB.CCCC_DDDD')).toBe(
        'Bearer [REDACTED]',
      );
    });
  });

  describe('safeErrorMessage', () => {
    it('handles an Error with a leaky message', () => {
      const e = new Error(
        'HubSpot rejected: {"Authorization":"Bearer sk_leak","api_key":"k"}',
      );
      const out = safeErrorMessage(e);
      expect(out).not.toContain('sk_leak');
      expect(out).toContain('[REDACTED]');
    });

    it('handles a non-Error value', () => {
      const out = safeErrorMessage({ headers: { 'Api-Token': 'tok_leak' } });
      // The string form of an object is `[object Object]` which has no
      // token in it — but our defensive path must not throw.
      expect(typeof out).toBe('string');
    });

    it('caps output at 500 chars', () => {
      const huge = 'x'.repeat(5_000);
      const out = safeErrorMessage(new Error(huge));
      expect(out.length).toBeLessThanOrEqual(500);
    });
  });
});
