import { Logger } from '@nestjs/common';

// Centralized boot-time environment validation. Replaces the small
// `assertRequiredEnv()` helper that lived inline in src/main.ts. The goals
// here are:
//
//   * Fail loudly in production when something the platform depends on is
//     missing — production deploys without `DATABASE_URL` or
//     `STRIPE_WEBHOOK_SECRET` should crash on boot, not on the first user
//     request that happens to hit that code path.
//   * Stay quiet in development. Most contributors only need Supabase +
//     `DATABASE_URL` configured; warning them about Stripe and PostHog on
//     every `npm run start:dev` is just noise.
//   * Give operators a single, readable summary of what's missing on a
//     staging / production boot, so they don't have to scroll through Fly
//     logs hunting for individual `Logger.warn` lines.
//
// Each rule below carries a tier:
//
//   * `hard`    — required everywhere, including dev. Boot crashes if missing
//                 (or contains an obvious placeholder). Use this *only* for
//                 values without which the process cannot serve a single
//                 request safely (DB connection, Supabase JWKS).
//   * `prod`    — required in `staging` and `production` (NODE_ENV). Boot
//                 crashes when missing under prod-like NODE_ENV. In dev the
//                 absence is logged as info-level, not warn-level. Reserve
//                 for things genuinely needed at boot under prod (currently
//                 none in the default rule set; the tier remains as a hook).
//   * `feature` — disables or degrades a single feature/route when missing.
//                 Logged at warn-level in prod-like environments so operators
//                 can see what's off, but boot does NOT crash. This is the
//                 right tier for Stripe (controllers return 400 at request
//                 time), Sentry (init no-ops), public launch URLs (fallback
//                 strings exist in the controllers), and CORS_ORIGINS
//                 (empty = deny-all, which is the safe mobile-only default).
//   * `optional`— always optional; absence is logged at warn-level only when
//                 a related feature would otherwise silently degrade
//                 (PostHog, Perplexity, USDA).
//
// The tier split exists so that operators are not forced to invent
// placeholder values to get past assertEnv on first boot. A placeholder is
// always worse than a missing value: an absent feature returns a
// deterministic 400 / falls back to a documented default, but a placeholder
// that slips into a real Stripe call leaks an obviously-broken state to
// users. See looksLikePlaceholder for the placeholder rejection that
// applies to hard/prod rules — feature-tier rules are *not* checked for
// placeholders because the right behavior there is "leave it unset until
// you have the real value."

export type EnvTier = 'hard' | 'prod' | 'feature' | 'optional';

export interface EnvRule {
  name: string;
  tier: EnvTier;
  // Short description shown in the boot summary so operators know *why* the
  // var matters without cross-referencing .env.example.
  reason: string;
  // Optional predicate that runs only when the var is set. Lets us flag
  // obvious misconfigurations (e.g. live Stripe key in staging) without
  // blocking boot — we warn rather than throw because the operator's intent
  // can't be inferred from the env var alone.
  validate?: (value: string) => string | null;
}

export const ENV_RULES: EnvRule[] = [
  // --- Hard: cannot start without these in any environment ---
  {
    name: 'DATABASE_URL',
    tier: 'hard',
    reason: 'Postgres connection string for Prisma. Required at boot.',
  },
  {
    name: 'SUPABASE_URL',
    tier: 'hard',
    reason: 'Supabase project URL for JWKS verification + admin API.',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    tier: 'hard',
    reason: 'Supabase service-role key for server-side admin calls.',
  },

  // --- Feature-tier: warn in prod, never block boot. The corresponding
  // route/feature handles the missing-value case at request time. ---
  {
    name: 'PUBLIC_INVITE_BASE_URL',
    tier: 'feature',
    reason:
      'Base URL used in /api/invite-codes responses and invite landing pages. Falls back to https://app.tgp.com/join when unset; set to the real public domain before public launch.',
  },
  {
    name: 'PUBLIC_WEB_SIGNUP_URL',
    tier: 'feature',
    reason:
      'Web signup target the invite landing page links to when the user has no app installed. Falls back to PUBLIC_INVITE_BASE_URL/<code> when unset.',
  },
  {
    name: 'APP_STORE_URL',
    tier: 'feature',
    reason:
      'iOS App Store URL surfaced on the public invite landing page. Falls back to a placeholder TestFlight-style link when unset; set once the App Store listing exists.',
  },
  {
    name: 'PLAY_STORE_URL',
    tier: 'feature',
    reason:
      'Google Play Store URL surfaced on the public invite landing page. Falls back to com.tgp.app placeholder when unset; set once the Play Store listing exists.',
  },
  {
    name: 'CORS_ORIGINS',
    tier: 'feature',
    reason:
      'Comma-separated allow-list of browser origins. Empty = deny all browsers (the safe mobile-only default). Set to the coach console origin once a browser client ships.',
    validate: (v) => {
      if (v.trim() === '*') {
        return 'CORS_ORIGINS=* is not allowed — list explicit origins (the wildcard is rejected at boot in main.ts as well).';
      }
      return null;
    },
  },
  {
    name: 'STRIPE_SECRET_KEY',
    tier: 'feature',
    reason:
      'Stripe API key used by BillingService for portal/subscription calls. Coach/owner billing routes return 400 STRIPE_NOT_CONFIGURED when unset, so leaving it unset is the right state until Stripe is provisioned.',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    tier: 'feature',
    reason:
      'HMAC signing secret for /v1/webhooks/stripe. Without it the webhook controller rejects every request with 400 — no boot dependency. Set this *before* pointing Stripe at the webhook URL.',
  },
  {
    name: 'STRIPE_PRICE_ID_FITNESS',
    tier: 'feature',
    reason:
      'Stripe price id for the flat coach SaaS plan. Read at request time by start-subscription / portal-session controllers; safe to leave unset until Stripe is configured.',
  },
  {
    name: 'SENTRY_DSN',
    tier: 'feature',
    reason:
      'Sentry DSN for server-side error reporting. instrument.ts no-ops when unset, so absence is safe at boot — but prod errors are invisible until set. Treat the warn as a release blocker for production traffic.',
  },

  // --- Optional everywhere; warn-only in prod when missing ---
  {
    name: 'POSTHOG_KEY',
    tier: 'optional',
    reason: 'PostHog project key for product analytics. AnalyticsModule is a no-op when unset.',
  },
  {
    name: 'PERPLEXITY_API_KEY',
    tier: 'optional',
    reason: 'Perplexity API key. AI chat falls back to a deterministic responder when unset.',
  },
  {
    name: 'USDA_API_KEY',
    tier: 'optional',
    reason: 'USDA FoodData Central API key. Food search returns errors at call time when unset.',
  },
  {
    name: 'COACH_CODE_GATE_ENABLED',
    tier: 'optional',
    reason: 'Feature flag — when "true", signup is blocked unless the user supplies a valid coach invite code.',
  },
  {
    name: 'BILLING_ENFORCEMENT',
    tier: 'optional',
    reason: 'SubscriptionGuard mode. "enforce" blocks writes for past_due/canceled coaches; anything else observes only.',
  },
  {
    name: 'STRIPE_PRICE_ID_FINANCE',
    tier: 'optional',
    reason: 'Stripe price id for the finance vertical. Currently unused — set when a second price exists.',
  },
  {
    name: 'STRIPE_BILLING_PORTAL_RETURN_URL',
    tier: 'optional',
    reason: 'Return URL Stripe redirects coaches to after the Customer Portal session ends. Defaults to the console billing screen when unset.',
  },
  {
    name: 'STRIPE_CUSTOMER_PORTAL_LOGIN_URL',
    tier: 'optional',
    reason:
      'Hosted Stripe Customer Portal login link (https://billing.stripe.com/p/login/...). Used as a static fallback by /v1/coach/me/billing/portal-session when STRIPE_SECRET_KEY is unset; returns this URL with fallback=true instead of STRIPE_NOT_CONFIGURED.',
    validate: (v) => {
      const trimmed = v.trim();
      if (!/^https:\/\/billing\.stripe\.com\/p\/login\//.test(trimmed)) {
        return 'STRIPE_CUSTOMER_PORTAL_LOGIN_URL must be an https://billing.stripe.com/p/login/... link copied from the Stripe dashboard.';
      }
      return null;
    },
  },
  {
    name: 'FINANCE_API_BASE_URL',
    tier: 'optional',
    reason:
      'Base URL of the finance backend (e.g. https://api.finance.thegrowthproject.app). When unset, admin federation endpoints return fitness-only payloads with finance.status="not_configured" — never fake data.',
    validate: (v) => {
      if (!/^https?:\/\//i.test(v.trim())) {
        return 'FINANCE_API_BASE_URL must be an absolute http(s) URL.';
      }
      return null;
    },
  },
  {
    name: 'FINANCE_SERVICE_TOKEN',
    tier: 'optional',
    reason:
      'Service-to-service bearer token sent on every admin federation call as Authorization: Bearer <token>. Required whenever FINANCE_API_BASE_URL is set; without it, federation degrades to finance.status="auth_unconfigured".',
  },
  {
    name: 'FINANCE_FEDERATION_TIMEOUT_MS',
    tier: 'optional',
    reason:
      'Per-call timeout for outbound finance federation requests in milliseconds. Defaults to 2500ms; clamp range is 250..15000.',
  },
  {
    name: 'ALLOW_SELF_SERVICE_BECOME_COACH',
    tier: 'optional',
    reason: 'Feature flag — when "true", re-opens POST /auth/become-coach. Hard-gated off by default; canonical promotion is OWNER-only POST /admin/users/:id/promote.',
  },
  {
    name: 'GDPR_SCRUB_DRY_RUN',
    tier: 'optional',
    reason: 'Feature flag — when "true", the GDPR scrub worker only reports candidate rows and does not write deleted_at or PII zero-outs. Default is real scrub.',
  },
  {
    name: 'GDPR_SCRUB_BATCH_LIMIT',
    tier: 'optional',
    reason: 'Per-run cap on candidates the GDPR scrub worker will process. Defaults to 100; clamped to [1, 1000].',
  },
];

export interface EnvValidationResult {
  missingHard: string[];
  missingProd: string[];
  missingFeature: string[];
  missingOptional: string[];
  validationWarnings: string[];
  // Names of hard/prod-tier vars whose value looks like an unfilled placeholder
  // (e.g. literal `<value>`, `XXXXXXXX`, `changeme`). Treated as missing —
  // a placeholder in prod is worse than absence because boot would otherwise
  // appear to succeed.
  placeholderHard: string[];
  placeholderProd: string[];
  isProd: boolean;
}

export function isProdLike(nodeEnv: string | undefined): boolean {
  const v = (nodeEnv || '').toLowerCase();
  return v === 'production' || v === 'staging';
}

// Detects values that look like unfilled placeholders the operator forgot to
// replace. Compared against trimmed values; never prints the value itself.
//
// Examples that match: "<supabase-service-role-key>", "sk_test_XXXXXXXX",
// "REPLACE_ME", "changeme", "TODO", "placeholder", "your-key-here".
//
// We intentionally keep this list narrow — false positives here brick a deploy.
// Genuine secret values (random base64, JWT-shaped strings, sk_live_..., etc.)
// must never match.
export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // Wrapped in angle-brackets, e.g. "<value>", "<staging-db-url>".
  if (/^<[^>\s]+>$/.test(v)) return true;
  // Bare sentinels.
  const sentinels = new Set([
    'changeme',
    'change_me',
    'change-me',
    'placeholder',
    'replace_me',
    'replace-me',
    'replaceme',
    'todo',
    'tbd',
    'fixme',
    'your-key-here',
    'your_key_here',
    'yourkeyhere',
  ]);
  if (sentinels.has(v.toLowerCase())) return true;
  // Long runs of capital X are how the secrets-printer template marks unfilled
  // values (e.g. "sk_test_XXXXXXXXXXXXXXXX"). 8+ in a row is well past the
  // false-positive threshold for real keys.
  if (/X{8,}/.test(v)) return true;
  return false;
}

export function evaluateEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const isProd = isProdLike(env.NODE_ENV);
  const missingHard: string[] = [];
  const missingProd: string[] = [];
  const missingFeature: string[] = [];
  const missingOptional: string[] = [];
  const placeholderHard: string[] = [];
  const placeholderProd: string[] = [];
  const validationWarnings: string[] = [];

  for (const rule of ENV_RULES) {
    const value = env[rule.name];
    const isSet = typeof value === 'string' && value.trim().length > 0;

    if (!isSet) {
      if (rule.tier === 'hard') missingHard.push(rule.name);
      else if (rule.tier === 'prod') missingProd.push(rule.name);
      else if (rule.tier === 'feature') missingFeature.push(rule.name);
      else missingOptional.push(rule.name);
      continue;
    }

    // Treat obvious placeholders as missing for hard/prod-tier vars. Optional
    // vars are left alone — a placeholder there is a no-op.
    if ((rule.tier === 'hard' || rule.tier === 'prod') && looksLikePlaceholder(value!)) {
      if (rule.tier === 'hard') placeholderHard.push(rule.name);
      else placeholderProd.push(rule.name);
      continue;
    }

    if (rule.validate) {
      const err = rule.validate(value!);
      if (err) validationWarnings.push(`${rule.name}: ${err}`);
    }
  }

  return {
    missingHard,
    missingProd,
    missingFeature,
    missingOptional,
    placeholderHard,
    placeholderProd,
    validationWarnings,
    isProd,
  };
}

export interface AssertOptions {
  // When true, missing prod-tier vars throw instead of warning. Defaults to
  // true when NODE_ENV is production/staging.
  enforceProd?: boolean;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export function assertEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: AssertOptions = {},
): EnvValidationResult {
  const result = evaluateEnv(env);
  const logger = opts.logger ?? new Logger('EnvValidation');
  const enforceProd = opts.enforceProd ?? result.isProd;

  if (result.missingHard.length) {
    const msg = `Missing required env vars: ${result.missingHard.join(', ')}`;
    logger.error(msg);
    throw new Error(msg);
  }

  // Placeholder values for hard-tier vars are always fatal — these were never
  // intended to ship. Variable *names* are logged; values are not.
  if (result.placeholderHard.length) {
    const msg = `Required env vars contain placeholder values (replace with real values): ${result.placeholderHard.join(', ')}`;
    logger.error(msg);
    throw new Error(msg);
  }

  if (result.missingProd.length) {
    if (enforceProd) {
      const msg = `Missing production-required env vars (NODE_ENV=${env.NODE_ENV}): ${result.missingProd.join(', ')}`;
      logger.error(msg);
      throw new Error(msg);
    } else {
      logger.warn(
        `Production-tier env vars missing (ok in dev, required for staging/prod): ${result.missingProd.join(', ')}`,
      );
    }
  }

  if (result.placeholderProd.length) {
    if (enforceProd) {
      const msg = `Production-tier env vars contain placeholder values (NODE_ENV=${env.NODE_ENV}): ${result.placeholderProd.join(', ')}`;
      logger.error(msg);
      throw new Error(msg);
    } else {
      logger.warn(
        `Production-tier env vars contain placeholder values (ok in dev, required for staging/prod): ${result.placeholderProd.join(', ')}`,
      );
    }
  }

  // Feature-tier vars never block boot. Warn loudly under prod-like
  // NODE_ENV so operators see what's degraded; stay quiet in dev.
  if (result.missingFeature.length && enforceProd) {
    logger.warn(
      `Feature-tier env vars missing — related features are disabled or return 4xx at call time (NODE_ENV=${env.NODE_ENV}): ${result.missingFeature.join(', ')}`,
    );
  }

  if (result.missingOptional.length) {
    logger.warn(
      `Optional env vars missing (related features will be disabled or return errors at call time): ${result.missingOptional.join(', ')}`,
    );
  }

  for (const warning of result.validationWarnings) {
    logger.warn(`Env validation warning: ${warning}`);
  }

  if (result.isProd) {
    const satisfied =
      ENV_RULES.length -
      result.missingHard.length -
      result.missingProd.length -
      result.missingFeature.length -
      result.missingOptional.length -
      result.placeholderHard.length -
      result.placeholderProd.length;
    logger.log(
      `Env validation passed for NODE_ENV=${env.NODE_ENV}. ` +
        `${satisfied} of ${ENV_RULES.length} rules satisfied.`,
    );
  }

  return result;
}
