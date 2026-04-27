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
//   * `hard`    — required everywhere, including dev. Boot crashes if missing.
//   * `prod`    — required in `staging` and `production` (NODE_ENV). In dev
//                 the var is treated as optional and the absence is logged
//                 as info-level, not warn-level.
//   * `optional`— always optional; absence is logged at warn-level only when
//                 a related feature would otherwise silently degrade
//                 (Sentry, PostHog).

export type EnvTier = 'hard' | 'prod' | 'optional';

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

  // --- Prod-required: optional in dev, required in staging/production ---
  {
    name: 'PUBLIC_INVITE_BASE_URL',
    tier: 'prod',
    reason: 'Base URL used in /api/invite-codes responses and invite landing pages.',
  },
  {
    name: 'PUBLIC_WEB_SIGNUP_URL',
    tier: 'prod',
    reason: 'Web signup target the invite landing page links to when the user has no app installed.',
  },
  {
    name: 'APP_STORE_URL',
    tier: 'prod',
    reason: 'iOS App Store URL surfaced on the public invite landing page.',
  },
  {
    name: 'PLAY_STORE_URL',
    tier: 'prod',
    reason: 'Google Play Store URL surfaced on the public invite landing page.',
  },
  {
    name: 'CORS_ORIGINS',
    tier: 'prod',
    reason:
      'Comma-separated allow-list of browser origins. Empty = deny all browsers (mobile-only). Set to the coach console origin in prod.',
    validate: (v) => {
      if (v.trim() === '*') {
        return 'CORS_ORIGINS=* is not allowed in production — set explicit origins.';
      }
      return null;
    },
  },
  {
    name: 'STRIPE_SECRET_KEY',
    tier: 'prod',
    reason: 'Stripe API key used by BillingService for portal/subscription calls.',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    tier: 'prod',
    reason: 'HMAC signing secret for /v1/webhooks/stripe. Without it every webhook is rejected.',
  },
  {
    name: 'STRIPE_PRICE_ID_FITNESS',
    tier: 'prod',
    reason: 'Stripe price id for the flat coach SaaS plan.',
  },
  {
    name: 'SENTRY_DSN',
    tier: 'prod',
    reason: 'Sentry DSN for server-side error reporting. Without it, prod errors are invisible.',
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
];

export interface EnvValidationResult {
  missingHard: string[];
  missingProd: string[];
  missingOptional: string[];
  validationWarnings: string[];
  isProd: boolean;
}

export function isProdLike(nodeEnv: string | undefined): boolean {
  const v = (nodeEnv || '').toLowerCase();
  return v === 'production' || v === 'staging';
}

export function evaluateEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const isProd = isProdLike(env.NODE_ENV);
  const missingHard: string[] = [];
  const missingProd: string[] = [];
  const missingOptional: string[] = [];
  const validationWarnings: string[] = [];

  for (const rule of ENV_RULES) {
    const value = env[rule.name];
    const isSet = typeof value === 'string' && value.trim().length > 0;

    if (!isSet) {
      if (rule.tier === 'hard') missingHard.push(rule.name);
      else if (rule.tier === 'prod') missingProd.push(rule.name);
      else missingOptional.push(rule.name);
      continue;
    }

    if (rule.validate) {
      const err = rule.validate(value!);
      if (err) validationWarnings.push(`${rule.name}: ${err}`);
    }
  }

  return { missingHard, missingProd, missingOptional, validationWarnings, isProd };
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

  if (result.missingOptional.length) {
    logger.warn(
      `Optional env vars missing (related features will be disabled or return errors at call time): ${result.missingOptional.join(', ')}`,
    );
  }

  for (const warning of result.validationWarnings) {
    logger.warn(`Env validation warning: ${warning}`);
  }

  if (result.isProd) {
    logger.log(
      `Env validation passed for NODE_ENV=${env.NODE_ENV}. ` +
        `${ENV_RULES.length - result.missingHard.length - result.missingProd.length - result.missingOptional.length} of ${ENV_RULES.length} rules satisfied.`,
    );
  }

  return result;
}
