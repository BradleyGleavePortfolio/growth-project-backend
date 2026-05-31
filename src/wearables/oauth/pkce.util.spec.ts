import { createHash } from 'crypto';
import {
  generateVerifier,
  generateChallenge,
  generatePkcePair,
  PKCE_CHALLENGE_METHOD,
  PKCE_VERIFIER_CHARSET,
  PKCE_VERIFIER_MAX_LENGTH,
  PKCE_VERIFIER_MIN_LENGTH,
} from './pkce.util';

describe('pkce.util', () => {
  describe('generateVerifier', () => {
    it('produces a 43-char verifier at the default (32-byte) entropy', () => {
      const v = generateVerifier();
      expect(v.length).toBe(43);
    });

    it('only uses RFC 7636 unreserved characters', () => {
      for (let i = 0; i < 50; i++) {
        const v = generateVerifier();
        expect(v).toMatch(PKCE_VERIFIER_CHARSET);
        // base64url never emits +, /, or = padding.
        expect(v).not.toContain('+');
        expect(v).not.toContain('/');
        expect(v).not.toContain('=');
      }
    });

    it('keeps length within the RFC bounds [43,128] even for extreme inputs', () => {
      expect(generateVerifier(1).length).toBe(PKCE_VERIFIER_MIN_LENGTH); // clamped up to 32 bytes → 43
      expect(generateVerifier(1000).length).toBe(PKCE_VERIFIER_MAX_LENGTH); // clamped to 96 bytes → 128
    });

    it('generates a fresh, unpredictable verifier each call', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        seen.add(generateVerifier());
      }
      // 256 bits of entropy: collisions across 100 draws are astronomically
      // unlikely, so all 100 must be distinct.
      expect(seen.size).toBe(100);
    });
  });

  describe('generateChallenge', () => {
    it('is deterministic: same verifier → same S256 challenge', () => {
      const verifier = 'a'.repeat(43);
      expect(generateChallenge(verifier)).toBe(generateChallenge(verifier));
    });

    it('matches the RFC 7636 reference vector (Appendix B)', () => {
      // RFC 7636 Appendix B worked example.
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      expect(generateChallenge(verifier)).toBe(expected);
    });

    it('equals base64url(SHA256(verifier)) computed independently', () => {
      const verifier = generateVerifier();
      const independent = createHash('sha256')
        .update(verifier, 'ascii')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(generateChallenge(verifier)).toBe(independent);
    });

    it('produces a 43-char base64url challenge (SHA-256 → 32 bytes)', () => {
      const challenge = generateChallenge(generateVerifier());
      expect(challenge.length).toBe(43);
      expect(challenge).toMatch(PKCE_VERIFIER_CHARSET);
    });

    it('rejects a verifier shorter than the RFC minimum', () => {
      expect(() => generateChallenge('tooshort')).toThrow(/at least 43/);
    });
  });

  describe('generatePkcePair', () => {
    it('returns a verifier whose challenge matches generateChallenge', () => {
      const pair = generatePkcePair();
      expect(pair.method).toBe(PKCE_CHALLENGE_METHOD);
      expect(pair.method).toBe('S256');
      expect(pair.challenge).toBe(generateChallenge(pair.verifier));
      expect(pair.verifier).toMatch(PKCE_VERIFIER_CHARSET);
      expect(pair.challenge).toMatch(PKCE_VERIFIER_CHARSET);
    });
  });
});
