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
    // USDA_API_KEY was promoted from optional → hard as part of the
    // food-logger Trainerize-grade floor. A missing key used to silently
    // return [] from /foods/search; now boot fails loudly instead.
    USDA_API_KEY: 'usda-test-key',
    // DIRECT_URL was promoted from feature to hard tier (security hardening).
    // Required by `prisma migrate deploy` in the Fly release_command.
    DIRECT_URL: 'postgres://x:5432/db',
    // Phase 10 — these are prod-tier (must be set for staging/production
    // boot), so include them in the minimum env that any prod-boot test
    // expects to pass. Tests for missing/invalid values override locally.
    RECENT_AUTH_SECRET: 'test-recent-auth-secret-at-least-32-chars-long',
    RECENT_AUTH_TTL_MS: '300000',
  };
}

function fullProdEnv(): NodeJS.ProcessEnv {
  return {
    ...baseHardEnv(),
    NODE_ENV: 'production',
    PUBLIC_INVITE_BASE_URL: 'https://app.trygrowthproject.com/join',
    PUBLIC_WEB_SIGNUP_URL: 'https://app.example.com/signup',
    APP_STORE_URL: 'https://apps.apple.com/app/x',
    PLAY_STORE_URL: 'https://play.google.com/store/apps/details?id=x',
    CORS_ORIGINS: 'https://console.example.com',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID_FITNESS: 'price_x',
    SENTRY_DSN: 'https://abc@sentry.io/1',
    REDIS_URL: 'redis://localhost:6379',
    APPLE_AUDIENCES: 'com.thegrowthproject.app',
    // Coach AI v1 — feature-tier. Without this the engine is disabled,
    // not crashed; but tests that assert "missingFeature is empty" need
    // a stub value so the rule does not fire.
    ANTHROPIC_API_KEY: 'sk-ant-test',
    // Phase 11 — Exercise Library / Workout Builder (feature-tier).
    // Same situation as ANTHROPIC_API_KEY above: unset means the
    // upstream-only routes return 503 at call time, not a boot crash.
    // Set here so "missingFeature is empty" passes.
    EXERCISEDB_API_KEY: 'rapidapi-test-key',
    // P0 audit fix — prod refuses to boot without explicit Stripe
    // Checkout redirect URLs (their defaults are mobile-only schemes
    // that break web checkouts).
    STRIPE_CHECKOUT_SUCCESS_URL:
      'https://app.trygrowthproject.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://app.trygrowthproject.com/checkout/cancel',
    // Audit #4 P1 — Google OAuth audience(s) for the local Google ID-token
    // verifier (recent-auth re-auth flow). Both are feature-tier; setting
    // at least one is required to keep "google" advertised in /auth/signup-policy.
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    GOOGLE_CLIENT_IDS: 'test.apps.googleusercontent.com',
    // R43 storefront — prod-hardened so links don't fall back to the
    // default https://tgp.app and the storefront origin is registered
    // in CORS automatically.
    STOREFRONT_BASE_URL: 'https://storefront.example.com',
    // R43 — Universal Links / App Links + welcome email feature vars
    // were added alongside the storefront. Set here so missingFeature
    // stays empty for the "clean fullProdEnv" assertion.
    APPLE_TEAM_ID: 'TEAMID1234',
    ANDROID_SHA256_FINGERPRINT:
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    RESEND_API_KEY: 're_test_key',
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
      'DIRECT_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
      'USDA_API_KEY',
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
      'REDIS_URL',
      'APPLE_AUDIENCES',
      'EXERCISEDB_API_KEY',
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

  it('does NOT throw on most missing feature-tier vars under NODE_ENV=production', () => {
    // The feature tier mostly degrades-not-crashes in prod, BUT three
    // URL-config feature vars are prod-hardened because their defaults
    // would silently misroute production traffic (see env-validation.ts:
    // PUBLIC_INVITE_BASE_URL, STRIPE_CHECKOUT_SUCCESS_URL,
    // STRIPE_CHECKOUT_CANCEL_URL). Supply those + REDIS_URL so this test
    // exercises the "everything else is allowed to be missing" path.
    expect(() =>
      assertEnv(
        {
          ...baseHardEnv(),
          NODE_ENV: 'production',
          REDIS_URL: 'redis://localhost:6379',
          PUBLIC_INVITE_BASE_URL: 'https://app.trygrowthproject.com/join',
          STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.trygrowthproject.com/checkout/success',
          STRIPE_CHECKOUT_CANCEL_URL: 'https://app.trygrowthproject.com/checkout/cancel',
          // Added: prod-hardened feature vars promoted since this test was written
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
          ANTHROPIC_API_KEY: 'sk-ant-test',
          STOREFRONT_BASE_URL: 'https://storefront.example.com',
        },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('warns (does not throw) when feature-tier vars are missing under prod NODE_ENV', () => {
    const warn = jest.fn();
    const logger = { ...silentLogger, warn };
    assertEnv(
      {
        ...baseHardEnv(),
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
        // Supply the prod-hardened URL vars so the warn path can run
        // (the throw path is exercised separately below).
        PUBLIC_INVITE_BASE_URL: 'https://app.trygrowthproject.com/join',
        STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.trygrowthproject.com/checkout/success',
        STRIPE_CHECKOUT_CANCEL_URL: 'https://app.trygrowthproject.com/checkout/cancel',
        // Added: prod-hardened feature vars promoted since this test was written
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        STOREFRONT_BASE_URL: 'https://storefront.example.com',
      },
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
  });

  it('throws when prod-hardened URL config is missing under NODE_ENV=production (P0)', () => {
    // PUBLIC_INVITE_BASE_URL / STRIPE_CHECKOUT_SUCCESS_URL /
    // STRIPE_CHECKOUT_CANCEL_URL are feature-tier overall but
    // prod-hardened: the code-baked defaults (legacy app.tgp.com,
    // mobile-only deep-link schemes) would silently misroute production
    // traffic. Boot must fail loudly.
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' },
        { logger: silentLogger as any },
      ),
    ).toThrow(/Production-required URL config is missing/);
  });

  it('throws when REDIS_URL is missing under NODE_ENV=production', () => {
    // Pre-Connect cleanup: REDIS_URL is feature-tier overall (dev/test fall
    // back to in-memory throttler) but production refuses to boot without
    // it. A single-machine in-memory tracker cannot defend a multi-machine
    // Fly deploy from credential stuffing, so this is a fail-fast at boot.
    expect(() =>
      assertEnv(
        { ...baseHardEnv(), NODE_ENV: 'production' },
        { logger: silentLogger as any },
      ),
    ).toThrow(/REDIS_URL is required in production/);
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
    // enforceProd=false relaxes the feature-tier warn-vs-throw split, but
    // the REDIS_URL prod-boot guard AND the prod-hardened URL config
    // (PUBLIC_INVITE_BASE_URL / STRIPE_CHECKOUT_*) are hard fail-fasts
    // regardless of the flag — those defaults would silently misroute
    // production traffic. Supply them so this test stays focused on
    // the enforceProd=false semantics it was originally asserting.
    expect(() =>
      assertEnv(
        {
          ...baseHardEnv(),
          NODE_ENV: 'production',
          REDIS_URL: 'redis://localhost:6379',
          PUBLIC_INVITE_BASE_URL: 'https://app.trygrowthproject.com/join',
          STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.trygrowthproject.com/checkout/success',
          STRIPE_CHECKOUT_CANCEL_URL: 'https://app.trygrowthproject.com/checkout/cancel',
          // Added: prod-hardened feature vars promoted since this test was written
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
          ANTHROPIC_API_KEY: 'sk-ant-test',
          STOREFRONT_BASE_URL: 'https://storefront.example.com',
        },
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

describe('assertEnv — prod-tier validator failures are fatal (Audit #2 P2-B)', () => {
  it('throws when RECENT_AUTH_SECRET is too short under NODE_ENV=production', () => {
    expect(() =>
      assertEnv(
        {
          ...fullProdEnv(),
          // Set but invalid — 31 chars (one below the 32-char minimum).
          RECENT_AUTH_SECRET: 'a'.repeat(31),
        },
        { logger: silentLogger as any },
      ),
    ).toThrow(/RECENT_AUTH_SECRET/);
  });

  it('throws when RECENT_AUTH_SECRET is too short under NODE_ENV=staging', () => {
    expect(() =>
      assertEnv(
        {
          ...fullProdEnv(),
          NODE_ENV: 'staging',
          RECENT_AUTH_SECRET: 'short',
        },
        { logger: silentLogger as any },
      ),
    ).toThrow(/failed validation/);
  });

  it('throws when RECENT_AUTH_TTL_MS is out of range under production', () => {
    expect(() =>
      assertEnv(
        {
          ...fullProdEnv(),
          RECENT_AUTH_TTL_MS: '30000', // below the 60000 minimum
        },
        { logger: silentLogger as any },
      ),
    ).toThrow(/RECENT_AUTH_TTL_MS/);
  });

  it('throws when RECENT_AUTH_TTL_MS is not a finite integer under production', () => {
    expect(() =>
      assertEnv(
        {
          ...fullProdEnv(),
          RECENT_AUTH_TTL_MS: 'not-a-number',
        },
        { logger: silentLogger as any },
      ),
    ).toThrow(/RECENT_AUTH_TTL_MS/);
  });

  it('does NOT throw when prod-tier validator fails under NODE_ENV=development', () => {
    // In dev, validator failures are still logged as warnings but must not
    // crash the boot — keeps `npm run start:dev` usable with throwaway
    // secrets.
    expect(() =>
      assertEnv(
        {
          ...baseHardEnv(),
          NODE_ENV: 'development',
          RECENT_AUTH_SECRET: 'short',
        },
        { logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('does NOT throw when enforceProd=false even with a bad RECENT_AUTH_SECRET', () => {
    expect(() =>
      assertEnv(
        {
          ...fullProdEnv(),
          RECENT_AUTH_SECRET: 'short',
        },
        { enforceProd: false, logger: silentLogger as any },
      ),
    ).not.toThrow();
  });

  it('evaluateEnv exposes validationErrorsProd for prod-tier validator failures', () => {
    const r = evaluateEnv({
      ...fullProdEnv(),
      RECENT_AUTH_SECRET: 'short',
      RECENT_AUTH_TTL_MS: '30000',
    });
    expect(r.validationErrorsProd.some((e) => e.includes('RECENT_AUTH_SECRET'))).toBe(true);
    expect(r.validationErrorsProd.some((e) => e.includes('RECENT_AUTH_TTL_MS'))).toBe(true);
  });
});
