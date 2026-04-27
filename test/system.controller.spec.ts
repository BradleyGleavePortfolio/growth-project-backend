import { SystemController, __testing } from '../src/system/system.controller';

describe('SystemController.getTrustMeta', () => {
  const ORIG = process.env.LAST_SECURITY_DEPLOY_AT;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.LAST_SECURITY_DEPLOY_AT;
    else process.env.LAST_SECURITY_DEPLOY_AT = ORIG;
  });

  it('returns the floor when LAST_SECURITY_DEPLOY_AT is unset', () => {
    delete process.env.LAST_SECURITY_DEPLOY_AT;
    const meta = new SystemController().getTrustMeta();
    expect(meta.lastSecurityUpdate).toBe(__testing.LAST_SECURITY_FLOOR);
    expect(meta.encryptionLevel).toBe('tls1.3 + at-rest aes-256');
    expect(meta.dataResidency).toBe('us-east');
    expect(meta.dataExportSupported).toBe(true);
    expect(meta.accountDeletionSupported).toBe(true);
  });

  it('uses LAST_SECURITY_DEPLOY_AT when set to a valid ISO date', () => {
    process.env.LAST_SECURITY_DEPLOY_AT = '2026-05-12T03:21:00Z';
    const meta = new SystemController().getTrustMeta();
    expect(meta.lastSecurityUpdate).toBe('2026-05-12T03:21:00Z');
  });

  it('accepts a date-only ISO string', () => {
    process.env.LAST_SECURITY_DEPLOY_AT = '2026-06-01';
    const meta = new SystemController().getTrustMeta();
    expect(meta.lastSecurityUpdate).toBe('2026-06-01');
  });

  it('falls back to the floor when LAST_SECURITY_DEPLOY_AT is malformed', () => {
    process.env.LAST_SECURITY_DEPLOY_AT = 'yesterday-ish';
    const meta = new SystemController().getTrustMeta();
    expect(meta.lastSecurityUpdate).toBe(__testing.LAST_SECURITY_FLOOR);
  });

  it('trims surrounding whitespace before validating', () => {
    process.env.LAST_SECURITY_DEPLOY_AT = '   2026-07-01T00:00:00Z   ';
    const meta = new SystemController().getTrustMeta();
    expect(meta.lastSecurityUpdate).toBe('2026-07-01T00:00:00Z');
  });

  it('floor is itself a real ISO date in the past, not a placeholder string', () => {
    expect(__testing.LAST_SECURITY_FLOOR).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    const floorMs = Date.parse(__testing.LAST_SECURITY_FLOOR);
    expect(Number.isFinite(floorMs)).toBe(true);
    expect(floorMs).toBeLessThanOrEqual(Date.now());
  });
});
