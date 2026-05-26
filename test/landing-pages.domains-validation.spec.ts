/**
 * R49 hostname validation tests.
 *
 * Stand-alone — `validateCustomDomain` is a pure function so no DI.
 */

import { validateCustomDomain } from '../src/landing-pages/domains/domain-validation';

describe('validateCustomDomain', () => {
  describe('accepts', () => {
    it.each([
      ['coaching.example.com'],
      ['app.coach.io'],
      ['my-coaching-page.example.co.uk'],
      ['xn--bcher-kva.example.com'], // punycode IDN
    ])('%s', (input) => {
      const out = validateCustomDomain(input);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.domain).toBe(input.toLowerCase());
    });

    it('normalizes to lowercase', () => {
      const out = validateCustomDomain('Coaching.EXAMPLE.com');
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.domain).toBe('coaching.example.com');
    });

    it('trims surrounding whitespace', () => {
      const out = validateCustomDomain('   coach.example.com  ');
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.domain).toBe('coach.example.com');
    });
  });

  describe('rejects', () => {
    it('non-string', () => {
      const out = validateCustomDomain(123 as unknown);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('not_string');
    });

    it('empty', () => {
      const out = validateCustomDomain('   ');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('empty');
    });

    it('scheme', () => {
      const out = validateCustomDomain('https://example.com');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('has_scheme');
    });

    it('path', () => {
      const out = validateCustomDomain('example.com/landing');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('has_path');
    });

    it('port', () => {
      const out = validateCustomDomain('example.com:8443');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('has_port_or_ipv6');
    });

    it('userinfo', () => {
      const out = validateCustomDomain('user@example.com');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('has_userinfo');
    });

    it('query / fragment', () => {
      expect(validateCustomDomain('example.com?x').ok).toBe(false);
      expect(validateCustomDomain('example.com#y').ok).toBe(false);
    });

    it('ipv4', () => {
      const out = validateCustomDomain('192.168.1.1');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('is_ipv4');
    });

    it('single-label hostname (no TLD)', () => {
      const out = validateCustomDomain('localhost');
      expect(out.ok).toBe(false);
      if (!out.ok) {
        // Single-label fails on both no_tld AND reserved_suffix.  The
        // function returns the first failure it hits — currently
        // reserved_suffix has its own check earlier than label split,
        // but we accept either as a valid rejection signal.
        expect(['no_tld', 'reserved_suffix']).toContain(out.reason);
      }
    });

    it('label too long', () => {
      const longLabel = 'a'.repeat(64);
      const out = validateCustomDomain(`${longLabel}.example.com`);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_label');
    });

    it('label starts with hyphen', () => {
      const out = validateCustomDomain('-bad.example.com');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_label');
    });

    it('label ends with hyphen', () => {
      const out = validateCustomDomain('bad-.example.com');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_label');
    });

    it('total length > 253', () => {
      const big = ('a'.repeat(60) + '.').repeat(5) + 'example.com';
      const out = validateCustomDomain(big);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('too_long');
    });

    it.each([
      ['anything.tgp.app'],
      ['something.thegrowthproject.app'],
      ['coaching.trygrowthproject.com'],
      ['custom.joingrowthproject.com'],
      ['foo.fly.dev'],
    ])('reserved suffix %s', (input) => {
      const out = validateCustomDomain(input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('reserved_suffix');
    });
  });
});
