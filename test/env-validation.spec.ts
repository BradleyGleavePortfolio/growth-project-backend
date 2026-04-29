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

  it('classifies feature-tier vars as missingFeature (not missingProd or missingHard)', () => {
    // Same shape as a real prod boot with only the hard tier provided —
    // exactly the situation that was crashing Fly boot before this PR.
    // None of CORS_ORIGINS / Stripe / Sentry / public-launch URLs may end
    // up in missingHard or missingProd, otherwise assertEnv would throw
    // and force operators to invent placeholder values.
    const r = evaluateEnv({ ...baseHardEnv(), NODE_ENV: 'production' });
    expect(r.missingHard).toEqual([]);
    expect(r.missingProd).toEqual([]);
    for (const name of [
      'PUBLIC_INVITE_BASE_URL',
      'PUBLIC_WEB_SIGNUP_URL',
      'APP_STORE_URL',
      'PLAY_STORE_URL',
      'CORS_ORIGINS',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_ID_FITNESS',
      'SENTRY_DSN',
    ]) {
      expect(r.missingFeature).toContain(name);
      expect(r.missingProd).not.toContain(name);
      expect(r.missingHard).not.toContain(name);
    }
  });

  it('reports a clean run when fullProdEnv is supplied', () => {
    const r = evaluateEnv(fullProdEnv());
    expect(r.missingHard).toEqual([]);
    expect(r.missingProd).toEqual([]);
    expect(r.missingFeature).toEqual([]);
    expect(r.validationWarnings).toEqual([]);
  });

  it('flags CORS_ORIGINS=* as a validation warning', () => {
    const r = evaluateEnv({ ...fullProdEnv(), CORS_ORIGINS: '*' });
    expect(r.validationWarnings.some((w) => w.startsWith('CORS_ORIGINS:'))).toBe(true);
  });

  it('accepts a hosted Stripe Customer Portal login link without warning', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      STRIPE_CUSTOMER_PORTAL_LOGIN_URL: 'https://billing.stripe.com/p/login/test_abc123',
    });
    expect(
      r.validationWarnings.some((w) => w.startsWith('STRIPE_CUSTOMER_PORTAL_LOGIN_URL:')),
    ).toBe(false);
  });

  it('warns when STRIPE_CUSTOMER_PORTAL_LOGIN_URL points outside billing.stripe.com', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      STRIPE_CUSTOMER_PORTAL_LOGIN_URL: 'https://evil.example.com/login',
    });
    expect(
      r.validationWarnings.some((w) => w.startsWith('STRIPE_CUSTOMER_PORTAL_LOGIN_URL:')),
    ).toBe(true);
  });

  it('treats whitespace-only values as missing', () => {
    const r = evaluateEnv({ ...baseHardEnv(), DATABASE_URL: '   ' });
    expect(r.missingHard).toContain('DATABASE_URL');
  });

  it('FINANCE_API_BASE_URL accepts http(s) URLs', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      FINANCE_API_BASE_URL: 'https://finance.example.test',
    });
    expect(r.validationWarnings.some((w) => w.startsWith('FINANCE_API_BASE_URL:'))).toBe(false);
  });

  it('FINANCE_API_BASE_URL warns on non-http schemes', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      FINANCE_API_BASE_URL: 'finance.example.test',
    });
    expect(r.validationWarnings.some((w) => w.startsWith('FINANCE_API_BASE_URL:'))).toBe(true);
  });
});

describe('assertEnv', () => {
  it('throws on missing hard vars regardless of NODE_ENV', () => {
    expect(() => assertEnv({}, { logger: silentLogger as any })).toThrow(
      /Missing required env vars/,
    );
  });

  it('does NOT throw on missing feature-tier vars under NODE_ENV=production', () => {
    // The whole point of the feature tier: prod boot must succeed when
    // Stripe/Sentry/public-launch URLs are unset. The corresponding routes
    // return 4xx at request time (or fall back to documented defaults);
    // crashing the entire API on boot is the wrong default.
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'production' },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('warns (does not throw) when feature-tier vars are missing under prod NODE_ENV', () => {
    const warn = jest.fn();
    const logger = { ...silentLogger, warn };
    assertEnv(
      { ...baseHardEnv(), NODE_ENV: 'production' },
      { logger: logger as any },
    );
    const featureWarning = warn.mock.calls.find((args) =>
      String(args[0]).startsWith('Feature-tier env vars missing'),
    );
    expect(featureWarning).toBeDefined();
    // Warning lists every missing feature-tier var by name so operators
    // can audit what's degraded without grepping the rule list.
    expect(String(featureWarning![0])).toContain('STRIPE_SECRET_KEY');
    expect(String(featureWarning![0])).toContain('SENTRY_DSN');
    expect(String(featureWarning![0])).toContain('PUBLIC_INVITE_BASE_URL');
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

  it('does not flag placeholders for feature-tier vars (warn-only tier never blocks boot)', () => {
    // Feature-tier vars are intentionally not checked for placeholders —
    // see env-validation.ts header. Operators should leave them unset
    // until they have real values, rather than invent placeholder text.
    const r = evaluateEnv({
      ...fullProdEnv(),
      STRIPE_SECRET_KEY: 'sk_test_XXXXXXXXXXXXXXXX',
    });
    expect(r.missingFeature).not.toContain('STRIPE_SECRET_KEY');
    expect(r.placeholderProd).not.toContain('STRIPE_SECRET_KEY');
    expect(r.placeholderHard).not.toContain('STRIPE_SECRET_KEY');
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

  it('does not throw when a feature-tier var contains placeholder text under prod', () => {
    // STRIPE_WEBHOOK_SECRET is now feature-tier — it is intentionally not
    // placeholder-checked. The webhook controller rejects unsigned requests
    // at runtime, so a placeholder boot is no worse than an unset boot.
    expect(() =>
      assertEnv(
        { ...fullProdEnv(), STRIPE_WEBHOOK_SECRET: 'whsec_XXXXXXXX' },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('does not throw when a feature-tier var contains placeholder text in dev', () => {
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
  });

  it('does not throw when fullProdEnv has real-looking values', () => {
    expect(() =>
      assertEnv(fullProdEnv(), { logger: silentLogger as any }),
    ).not.toThrow();
  });
});
