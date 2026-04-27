import {
  evaluateEnv,
  assertEnv,
  isProdLike,
  looksLikePlaceholder,
} from '../src/common/env-validation';

// Silent logger — assertEnv normally writes to NestJS Logger; we don't want
// every test that exercises a missing-var path to scribble to stdout.
const silentLogger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function baseHardEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://x',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
  };
}

function fullProdEnv(): NodeJS.ProcessEnv {
  return {
    ...baseHardEnv(),
    NODE_ENV: 'production',
    PUBLIC_INVITE_BASE_URL: 'https://app.example.com/join',
    PUBLIC_WEB_SIGNUP_URL: 'https://app.example.com/signup',
    APP_STORE_URL: 'https://apps.apple.com/app/x',
    PLAY_STORE_URL: 'https://play.google.com/store/apps/details?id=x',
    CORS_ORIGINS: 'https://console.example.com',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID_FITNESS: 'price_x',
    SENTRY_DSN: 'https://abc@sentry.io/1',
  };
}

describe('isProdLike', () => {
  it('returns true for production / staging only', () => {
    expect(isProdLike('production')).toBe(true);
    expect(isProdLike('staging')).toBe(true);
    expect(isProdLike('Production')).toBe(true);
    expect(isProdLike('development')).toBe(false);
    expect(isProdLike(undefined)).toBe(false);
    expect(isProdLike('')).toBe(false);
  });
});

describe('evaluateEnv', () => {
  it('returns hard misses when required vars are absent', () => {
    const r = evaluateEnv({});
    expect(r.missingHard.sort()).toEqual([
      'DATABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  it('flags prod-only vars as missing-prod, not missing-hard', () => {
    const r = evaluateEnv({ ...baseHardEnv(), NODE_ENV: 'production' });
    expect(r.missingHard).toEqual([]);
    expect(r.missingProd).toContain('CORS_ORIGINS');
    expect(r.missingProd).toContain('STRIPE_WEBHOOK_SECRET');
    expect(r.missingProd).toContain('SENTRY_DSN');
  });

  it('reports a clean run when fullProdEnv is supplied', () => {
    const r = evaluateEnv(fullProdEnv());
    expect(r.missingHard).toEqual([]);
    expect(r.missingProd).toEqual([]);
    expect(r.validationWarnings).toEqual([]);
  });

  it('flags CORS_ORIGINS=* as a validation warning', () => {
    const r = evaluateEnv({ ...fullProdEnv(), CORS_ORIGINS: '*' });
    expect(r.validationWarnings.some((w) => w.startsWith('CORS_ORIGINS:'))).toBe(true);
  });

  it('treats whitespace-only values as missing', () => {
    const r = evaluateEnv({ ...baseHardEnv(), DATABASE_URL: '   ' });
    expect(r.missingHard).toContain('DATABASE_URL');
  });
});

describe('assertEnv', () => {
  it('throws on missing hard vars regardless of NODE_ENV', () => {
    expect(() => assertEnv({}, { logger: silentLogger as any })).toThrow(
      /Missing required env vars/,
    );
  });

  it('throws on missing prod vars when NODE_ENV=production', () => {
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'production' },
        { logger: silentLogger as any },
      ),
    ).toThrow(/Missing production-required env vars/);
  });

  it('does not throw on missing prod vars in dev', () => {
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'development' },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('does not throw when fullProdEnv is supplied', () => {
    expect(() =>
      assertEnv(fullProdEnv(), { logger: silentLogger as any }),
    ).not.toThrow();
  });

  it('respects explicit enforceProd=false even when NODE_ENV=production', () => {
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'production' },
        { enforceProd: false, logger: silentLogger as any },
      ),
    ).not.toThrow();
  });
});

describe('looksLikePlaceholder', () => {
  it('flags angle-bracket placeholders', () => {
    expect(looksLikePlaceholder('<value>')).toBe(true);
    expect(looksLikePlaceholder('<staging-db-url>')).toBe(true);
    expect(looksLikePlaceholder('<supabase-service-role-key>')).toBe(true);
  });

  it('flags bare sentinels regardless of case', () => {
    expect(looksLikePlaceholder('changeme')).toBe(true);
    expect(looksLikePlaceholder('CHANGEME')).toBe(true);
    expect(looksLikePlaceholder('REPLACE_ME')).toBe(true);
    expect(looksLikePlaceholder('TODO')).toBe(true);
    expect(looksLikePlaceholder('placeholder')).toBe(true);
  });

  it('flags long runs of capital X (template marker)', () => {
    expect(looksLikePlaceholder('sk_test_XXXXXXXXXXXXXXXX')).toBe(true);
    expect(looksLikePlaceholder('whsec_XXXXXXXX')).toBe(true);
  });

  it('does not flag genuine secret-shaped values', () => {
    expect(looksLikePlaceholder('sk_test_51HabcDef0123456789')).toBe(false);
    expect(looksLikePlaceholder('sk_live_zZyYxXwWvVuUtTsSrR')).toBe(false);
    expect(looksLikePlaceholder('postgres://user:pass@host:5432/db')).toBe(false);
    expect(looksLikePlaceholder('https://abc.supabase.co')).toBe(false);
    expect(looksLikePlaceholder('whsec_a1b2c3d4e5f6g7h8i9j0')).toBe(false);
    expect(looksLikePlaceholder('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe(false);
  });

  it('does not flag empty / whitespace (those are handled as missing)', () => {
    expect(looksLikePlaceholder('')).toBe(false);
    expect(looksLikePlaceholder('   ')).toBe(false);
  });
});

describe('evaluateEnv — placeholder detection', () => {
  it('reports hard-tier placeholders separately from missing', () => {
    const r = evaluateEnv({
      ...baseHardEnv(),
      DATABASE_URL: '<staging-db-url>',
    });
    expect(r.missingHard).not.toContain('DATABASE_URL');
    expect(r.placeholderHard).toContain('DATABASE_URL');
  });

  it('reports prod-tier placeholders only as placeholderProd', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      STRIPE_SECRET_KEY: 'sk_test_XXXXXXXXXXXXXXXX',
    });
    expect(r.missingProd).not.toContain('STRIPE_SECRET_KEY');
    expect(r.placeholderProd).toContain('STRIPE_SECRET_KEY');
  });

  it('does not flag placeholders for optional-tier vars', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      POSTHOG_KEY: 'phc_XXXXXXXXXXXXXXXX',
    });
    expect(r.placeholderProd).not.toContain('POSTHOG_KEY');
    expect(r.placeholderHard).not.toContain('POSTHOG_KEY');
  });
});

describe('assertEnv — placeholder enforcement', () => {
  it('throws when a hard-tier var is a placeholder, regardless of NODE_ENV', () => {
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), DATABASE_URL: '<value>' },
        { logger: silentLogger as any },
      ),
    ).toThrow(/placeholder values/);
  });

  it('throws when a prod-tier var is a placeholder under NODE_ENV=production', () => {
    expect(() =>
      assertEnv(
        { ...fullProdEnv(), STRIPE_WEBHOOK_SECRET: 'whsec_XXXXXXXX' },
        { logger: silentLogger as any },
      ),
    ).toThrow(/placeholder values/);
  });

  it('warns but does not throw when prod-tier placeholder is present in dev', () => {
    (silentLogger.warn as jest.Mock).mockClear();
    expect(() =>
      assertEnv(
        {
          ...baseHardEnv(),
          NODE_ENV: 'development',
          STRIPE_SECRET_KEY: 'sk_test_XXXXXXXXXXXXXXXX',
        },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
    // Verify a warning was logged about the placeholder so the dev still sees
    // the signal even though boot continues.
    const warnCalls = (silentLogger.warn as jest.Mock).mock.calls.flat().join(' ');
    expect(warnCalls).toMatch(/placeholder/);
  });

  it('does not throw when fullProdEnv has real-looking values', () => {
    expect(() =>
      assertEnv(fullProdEnv(), { logger: silentLogger as any }),
    ).not.toThrow();
  });
});
