/**
 * H6 — erasureToken() HMAC primitive (D-H6-4 LOCKED).
 *
 * Targets two real failure modes:
 *   1. Silent secret-misconfig at boot — a deploy missing
 *      AUDIT_LOG_ERASURE_HMAC_SECRET must fail fast at module import, not
 *      lazily on first call (which would let unkeyed/guessable tokens ship).
 *   2. Non-deterministic / input-independent tokens — erasure tokens must be a
 *      stable, one-way function of (secret, plaintext) so erased audit rows
 *      stay correlatable across redactions without reversing to plaintext.
 *
 * Each case (re)loads the module under a chosen env so the import-time secret
 * check is exercised directly.
 */

const MODULE = '../../src/audit-log/erasure-token';

function loadFresh(secret: string | undefined): typeof import('../../src/audit-log/erasure-token') {
  jest.resetModules();
  if (secret === undefined) {
    delete process.env.AUDIT_LOG_ERASURE_HMAC_SECRET;
  } else {
    process.env.AUDIT_LOG_ERASURE_HMAC_SECRET = secret;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(MODULE);
}

describe('erasureToken (GDPR Art. 17 HMAC, D-H6-4)', () => {
  const ORIGINAL = process.env.AUDIT_LOG_ERASURE_HMAC_SECRET;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.AUDIT_LOG_ERASURE_HMAC_SECRET;
    } else {
      process.env.AUDIT_LOG_ERASURE_HMAC_SECRET = ORIGINAL;
    }
    jest.resetModules();
  });

  it('fails fast at module import when the secret is missing (not lazily on first call)', () => {
    jest.resetModules();
    delete process.env.AUDIT_LOG_ERASURE_HMAC_SECRET;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(() => require(MODULE)).toThrow(/AUDIT_LOG_ERASURE_HMAC_SECRET/);
  });

  it('is deterministic: same (secret, plaintext) -> same token', () => {
    const { erasureToken } = loadFresh('secret-A');
    expect(erasureToken('alice@example.com')).toBe(erasureToken('alice@example.com'));
  });

  it('matches the tok_<16 lowercase hex> format', () => {
    const { erasureToken, ERASURE_TOKEN_RE } = loadFresh('secret-A');
    const tok = erasureToken('alice@example.com');
    expect(tok).toMatch(/^tok_[a-f0-9]{16}$/);
    expect(ERASURE_TOKEN_RE.test(tok)).toBe(true);
  });

  it('different secrets produce different tokens for the same plaintext', () => {
    const a = loadFresh('secret-A').erasureToken('alice@example.com');
    const b = loadFresh('secret-B').erasureToken('alice@example.com');
    expect(a).not.toBe(b);
  });

  it('is input-dependent: different plaintexts produce different tokens under one secret', () => {
    const { erasureToken } = loadFresh('secret-A');
    expect(erasureToken('alice@example.com')).not.toBe(erasureToken('bob@example.com'));
  });
});
