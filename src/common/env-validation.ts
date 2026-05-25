import { Logger } from '@nestjs/common';
import { EnvValidationError } from './errors/env-validation.error';

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
    reason:
      'Supabase pgbouncer pooler URL (port 6543, ?pgbouncer=true). Used by the runtime app for all query traffic. Required at boot.',
  },
  {
    name: 'DIRECT_URL',
    tier: 'hard',
    reason:
      'Supabase direct connection URL (port 5432, no pgbouncer). Used only by `prisma migrate deploy` in the Fly release_command. Migrations require a real Postgres session, not a pooled one. Required for deploys to run migrations.',
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
      'Base URL used in /api/invite-codes responses and invite landing pages. Falls back to https://app.trygrowthproject.com/join when unset. MUST be set explicitly in staging/production — assertEnv() refuses to boot prod without it (see prodHardenedFeatureVars in this file).',
    validate: (v) => {
      const trimmed = v.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        return 'PUBLIC_INVITE_BASE_URL must be an absolute http(s) URL.';
      }
      // Reject the legacy placeholder hostname — it shipped as the
      // pre-launch default and any prod deploy still pointing at it is
      // a misconfiguration that would silently break invite links.
      if (/\bapp\.tgp\.com\b/i.test(trimmed)) {
        return 'PUBLIC_INVITE_BASE_URL=app.tgp.com is the legacy placeholder; set to https://app.trygrowthproject.com/join for production.';
      }
      return null;
    },
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
      'Google Play Store URL surfaced on the public invite landing page. Falls back to a com.growthproject.app placeholder when unset; set once the Play Store listing exists.',
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
    name: 'STRIPE_WEBHOOK_SECRET_NEXT',
    tier: 'optional',
    reason:
      'Incoming Stripe webhook signing secret during a zero-downtime rotation. When set alongside STRIPE_WEBHOOK_SECRET, a webhook request is accepted if it verifies under EITHER secret. Leave unset in steady state. See docs/stripe-setup.md §6 for the rotation runbook.',
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
  {
    name: 'APPLE_AUDIENCES',
    tier: 'feature',
    reason:
      'Comma-separated allow-list of Apple audiences (iOS bundle ids and/or Apple Services IDs) accepted by POST /auth/apple. Without it, the endpoint returns 503 and /auth/signup-policy omits "apple" from providers. Set to your iOS bundle id (e.g. com.thegrowthproject.app) before enabling Sign in with Apple in Supabase.',
  },
  {
    name: 'GOOGLE_CLIENT_ID',
    tier: 'feature',
    reason:
      'Google OAuth client ID accepted as audience by the local Google ID-token verifier (POST /auth/recent-auth-token, provider=google). Without it (and without GOOGLE_CLIENT_IDS) the recent-auth Google branch rejects every token and /auth/signup-policy omits "google" from providers. Set to your *.apps.googleusercontent.com client id. Use GOOGLE_CLIENT_IDS instead for multi-client support.',
    validate: (v) => {
      if (v.trim().length === 0) {
        return 'GOOGLE_CLIENT_ID must be a non-empty string when set.';
      }
      return null;
    },
  },
  {
    name: 'GOOGLE_CLIENT_IDS',
    tier: 'feature',
    reason:
      'Comma-separated allow-list of Google OAuth client IDs accepted as audiences by the local Google ID-token verifier. Supersedes GOOGLE_CLIENT_ID when both are set; use this when the platform issues separate iOS / Android / Web client IDs.',
    validate: (v) => {
      const entries = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (entries.length === 0) {
        return 'GOOGLE_CLIENT_IDS must contain at least one non-empty client ID when set.';
      }
      return null;
    },
  },
  {
    // REDIS_URL is production-required: a single-machine in-memory throttler
    // cannot defend a multi-machine Fly deploy and credential-stuffing
    // attacks routinely fan out across machines. The boot-time check below
    // refuses to start when NODE_ENV=production has no REDIS_URL. Dev/test
    // continue to fall back to the in-memory tracker so contributors don't
    // need a local Redis. See README's "Placeholders / TODO env vars".
    name: 'REDIS_URL',
    tier: 'feature',
    reason:
      'Redis connection string used by ThrottlerModule for shared rate-limit state across Fly machines. Production refuses to boot without it (see ThrottlerModule.buildThrottlerOptions). Dev/test fall back to in-memory tracking. Set to redis(s)://host:port[/db].',
    validate: (v) => {
      if (!/^rediss?:\/\//i.test(v.trim())) {
        return 'REDIS_URL must be an absolute redis:// or rediss:// URL.';
      }
      return null;
    },
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
    name: 'ANTHROPIC_API_KEY',
    tier: 'feature',
    reason:
      'Required for Coach AI v1 (Claude Sonnet adapter behind /coach/ai/*). Set in Fly secrets. Without it, /coach/ai/* returns 503 ai_disabled and ai.service falls back to its deterministic responder.',
  },
  {
    name: 'CRON_COACH_AI_INSIGHT',
    tier: 'optional',
    reason:
      'Feature flag — set to "on" to enable the weekly Coach AI insight digest cron. Default off so the cron is dormant in every environment until explicitly enabled.',
  },
  {
    // Promoted to hard-required as part of the food logger Trainerize-grade floor:
    // food search silently returning [] for the USDA branch is undetectable in
    // production (operators see no error), so the boot must fail loudly instead.
    // Free key at https://api.data.gov/signup (takes ~1 minute).
    name: 'USDA_API_KEY',
    tier: 'hard',
    reason:
      'USDA FoodData Central API key (free at https://api.data.gov/signup). Food search depends on it; required at boot so a missing key crashes the process instead of silently returning [].',
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
    name: 'STRIPE_CHECKOUT_SUCCESS_URL',
    tier: 'feature',
    reason:
      'Stripe Checkout success_url. Used by CheckoutService when the client did not specify one inline. Falls back to growthproject://checkout/success?session_id={CHECKOUT_SESSION_ID} (mobile deep link) when unset; production MUST set this explicitly so the universal-link redirect is correct — assertEnv refuses to boot prod with this missing.',
    validate: (v) => {
      const trimmed = v.trim();
      // Allow custom-scheme (mobile) or http(s) URLs; reject anything else.
      if (!/^([a-z][a-z0-9+.-]*:\/\/)/i.test(trimmed)) {
        return 'STRIPE_CHECKOUT_SUCCESS_URL must be an absolute URL (http(s)://... or a mobile scheme like growthproject://...).';
      }
      return null;
    },
  },
  {
    name: 'STRIPE_CHECKOUT_CANCEL_URL',
    tier: 'feature',
    reason:
      'Stripe Checkout cancel_url. Used by CheckoutService when the client did not specify one inline. Falls back to growthproject://checkout/cancel when unset; production MUST set this explicitly — assertEnv refuses to boot prod with this missing.',
    validate: (v) => {
      const trimmed = v.trim();
      if (!/^([a-z][a-z0-9+.-]*:\/\/)/i.test(trimmed)) {
        return 'STRIPE_CHECKOUT_CANCEL_URL must be an absolute URL (http(s)://... or a mobile scheme like growthproject://...).';
      }
      return null;
    },
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
    name: 'FINANCE_SERVICE_TOKEN_NEXT',
    tier: 'optional',
    reason:
      'Incoming federation bearer token during a zero-downtime rotation. When set alongside FINANCE_SERVICE_TOKEN, an inbound request to /admin/federation/ptm-signal is accepted if the bearer matches EITHER. Leave unset in steady state. See .env.example for the rotation playbook (mirrors STRIPE_WEBHOOK_SECRET_NEXT).',
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
  {
    name: 'PTM_SCORING_ENABLED',
    tier: 'optional',
    reason: 'Feature flag — when "false", the nightly PTM recompute cron and the admin teaching endpoints are disabled. Defaults to true (engine runs). Use to quickly disable the scoring engine if a heuristic regression is shipped.',
  },
  {
    name: 'PTM_SCORING_CRON',
    tier: 'optional',
    reason: 'Override for the nightly PTM recompute cron expression. Defaults to "0 4 * * *" (04:00 UTC, 1h after the GDPR scrub at 03:00 UTC). Must be a valid 5-field cron expression.',
  },
  {
    name: 'PTM_RECOMPUTE_BATCH_LIMIT',
    tier: 'optional',
    reason: 'Per-run cap on the number of clients the PTM nightly cron recomputes. Defaults to 5000; clamped to [1, 50000]. Larger rosters are processed across multiple nights with a stable cursor.',
  },
  {
    name: 'PTM_WEIGHTED_ACTIVATION_OUTCOMES',
    tier: 'optional',
    reason: 'Override the minimum number of labelled ClientOutcome rows before the weighted v2 engine activates. Defaults to 20. Below this threshold every recompute uses heuristic_v1.',
  },
  {
    name: 'PTM_RISK_BOARD_PAGE_SIZE',
    tier: 'optional',
    reason: 'Default page size for GET /admin/ptm/risk-board. Defaults to 50; clamped to [1, 100] regardless of caller-supplied limit.',
  },
  {
    name: 'DIAGNOSTIC_AI_ENABLED',
    tier: 'optional',
    reason: 'Set to "false" to skip Perplexity calls for /diagnostic/submit and store a placeholder roadmap. Defaults to true. Useful for CI / preview deploys without a Perplexity key.',
  },
  {
    name: 'DIAGNOSTIC_RATE_LIMIT_PER_HOUR',
    tier: 'optional',
    reason: 'Per-IP hourly cap on POST /diagnostic/submit (named throttler `diagnostic-submit`). Defaults to 5; clamped to [1, 1000].',
  },
  {
    name: 'COACH_EFFECTIVENESS_ENABLED',
    tier: 'optional',
    reason: 'Feature flag — when "false", the nightly Coach Effectiveness recompute cron is disabled. Defaults to true. Use to quickly disable scoring if an algorithm regression ships.',
  },
  {
    name: 'COACH_EFFECTIVENESS_CRON',
    tier: 'optional',
    reason: 'Override for the nightly Coach Effectiveness recompute cron expression. Defaults to "0 5 * * *" (05:00 UTC, one hour after the PTM recompute at 04:00 UTC).',
  },
  {
    name: 'COACH_ALERT_RED_TRANSITION_ENABLED',
    tier: 'optional',
    reason: 'Feature flag — when "false", the PTM-recompute hook does NOT create CoachAlert rows on green/amber → red transitions. Defaults to true. Use to silence the alert channel without disabling the underlying recompute.',
  },
  {
    name: 'COACH_ALERT_BATCH_LIMIT',
    tier: 'optional',
    reason: 'Per-request cap on the number of CoachAlert rows the OWNER aggregator and coach inbox endpoints return. Defaults to 50; clamped to [1, 200].',
  },
  {
    name: 'BUILD_WEEK_ENABLED',
    tier: 'optional',
    reason: 'Feature flag — when "false", the Build Week controllers refuse new writes and the admin funnel reports zeroed counts. Defaults to true (module is live). Use to quickly disable the surface if a copy regression or seed bug ships.',
  },
  {
    name: 'BUILD_WEEK_AUTO_START_ON_SIGNUP',
    tier: 'optional',
    reason: 'Feature flag — when "true", new client signups auto-enroll in Build Week. Defaults to false. Wiring is a follow-on PR; this PR only exposes the flag so deployment configs can be staged ahead of the implementation.',
  },
  // Phase 6C — Async Voice Notes
  {
    name: 'VOICE_NOTE_MAX_DURATION_SEC',
    tier: 'optional',
    reason: 'Phase 6C — server-enforced max duration for voice attachments on coach <-> client messages. Defaults to 300; clamped to [10, 600]. Validated at signed-upload issuance AND at message-send time.',
  },
  {
    name: 'VOICE_NOTE_MAX_SIZE_MB',
    tier: 'optional',
    reason: 'Phase 6C — server-enforced max file size in megabytes for voice attachments. Defaults to 5; clamped to [1, 25].',
  },
  {
    name: 'SUPABASE_VOICE_BUCKET',
    tier: 'optional',
    reason: 'Phase 6C — Supabase Storage bucket name for voice note objects. Defaults to "voice-notes". Bucket must exist in the Supabase project; signed-upload flow returns 501 VOICE_STORAGE_UNAVAILABLE if the bucket is unreachable or the JS SDK is too old to expose createSignedUploadUrl().',
  },
  // Phase 10 — Recent-auth (re-auth for sensitive actions)
  {
    name: 'RECENT_AUTH_SECRET',
    tier: 'prod',
    reason:
      'Phase 10 — HMAC signing secret for short-lived re-auth tokens (X-Recent-Auth-Token). Required for account deletion and other sensitive actions. Must be at least 32 characters of high-entropy data; shorter values are rejected at boot.',
    validate: (v) => {
      if (v.trim().length < 32) {
        return 'RECENT_AUTH_SECRET must be at least 32 characters long.';
      }
      return null;
    },
  },
  {
    name: 'RECENT_AUTH_TTL_MS',
    tier: 'prod',
    reason:
      'Phase 10 — validity window for re-auth tokens, in milliseconds. Must be a finite integer in [60000, 3600000] (1 min to 1 hour). Defaults to 300000 (5 min) when unset. Values outside this range fail the guard closed.',
    validate: (v) => {
      const trimmed = v.trim();
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return 'RECENT_AUTH_TTL_MS must be a finite integer.';
      }
      if (n < 60_000 || n > 3_600_000) {
        return 'RECENT_AUTH_TTL_MS must be in the range [60000, 3600000] (1 min to 1 hour).';
      }
      return null;
    },
  },
  // Phase 6D — Coach Onboarding Wizard
  {
    name: 'COACH_ONBOARDING_AUTO_START',
    tier: 'optional',
    reason: 'Phase 6D — when "true" (default), AdminService.promoteUser auto-starts the 6-step onboarding wizard for newly-promoted coaches. Set to "false" to suppress (e.g. during bulk back-fills). Wizard-creation failures never block promotion.',
  },

  // ============================================================
  // Phase 10 — Observability
  // ============================================================
  {
    name: 'LOG_LEVEL',
    tier: 'optional',
    reason: 'Phase 10 — minimum log severity to emit. One of error, warn, log, debug, verbose. Defaults to "log". Lower levels add volume; "warn" is a good production minimum once the system is stable.',
  },
  {
    name: 'LOG_FORMAT',
    tier: 'optional',
    reason: 'Phase 10 — "json" (default) for machine-readable structured logs (Fly, Better Stack, Datadog). "pretty" for human-friendly dev console output. JSON mode is always used in production.',
  },
  {
    name: 'METRICS_ENABLED',
    tier: 'optional',
    reason: 'Phase 10 — "on" (default) enables the Prometheus /metrics endpoint and in-process counter tracking. "off" disables both. Set to "off" if you have no Prometheus scraper configured and want to avoid the minor per-request overhead.',
  },
  {
    name: 'SENTRY_TRACES_SAMPLE_RATE',
    tier: 'optional',
    reason: 'Phase 10 — fraction of transactions sampled for Sentry Performance (0.0–1.0). Defaults to 0.1 (10%). Errors are always captured at 1.0 regardless of this value. Increase to 1.0 once traffic baselines are established.',
    validate: (v) => {
      const n = parseFloat(v.trim());
      if (isNaN(n) || n < 0 || n > 1) {
        return 'SENTRY_TRACES_SAMPLE_RATE must be a number between 0.0 and 1.0.';
      }
      return null;
    },
  },
  {
    name: 'PROFILE_ENABLED',
    tier: 'optional',
    reason: 'Phase 10 — "on" activates GET /debug/profile (30-second V8 CPU profile). Requires OWNER role. Defaults to "off". Leave off in production unless actively profiling — the endpoint blocks a Node.js event-loop thread for 30 seconds.',
  },

  // Phase 10 — Rate limiting
  {
    name: 'RATELIMIT_ENABLED',
    tier: 'optional',
    reason: 'Phase 10 — master kill switch for all rate limiting. Set to "off" only for load-test runs against staging. Any value other than "off" leaves throttling enabled. Default: on.',
  },
  {
    name: 'RATELIMIT_AUTHED_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — global default: max requests per minute per user-id (authenticated). Applies to every route with no explicit @Throttle decorator. Defaults to 300; clamped to [1, 10000].',
  },
  {
    name: 'RATELIMIT_ANON_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — global default: max requests per minute per IP (unauthenticated). Applies to every route with no explicit @Throttle decorator. Defaults to 100; clamped to [1, 10000].',
  },
  {
    name: 'AUTH_LOGIN_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — per-IP login attempts per minute (POST /auth/login, /auth/apple, /auth/google). Defaults to 5; clamped to [1, 1000]. A successful login resets this counter.',
  },
  {
    name: 'AUTH_LOGIN_PER_HOUR',
    tier: 'optional',
    reason: 'Phase 10 — per-IP login attempts per hour across all login endpoints. Sustained-attack brake. Defaults to 30; clamped to [1, 5000].',
  },
  {
    name: 'AUTH_PWD_RESET_PER_HOUR',
    tier: 'optional',
    reason: 'Phase 10 — per-IP password-reset email requests per hour (POST /auth/forgot-password). Defaults to 3; clamped to [1, 1000].',
  },
  {
    name: 'COACH_MESSAGES_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — per-user coach message sends per minute (POST /coach/clients/:id/messages). Defaults to 30; clamped to [1, 1000].',
  },
  {
    name: 'NOTIF_PREFS_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — per-user notification preference writes per minute (PUT /notifications/preferences). Defaults to 30; clamped to [1, 1000].',
  },
  {
    name: 'BLOODWORK_WRITE_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — per-user bloodwork POST writes per minute (POST /bloodwork/*). Defaults to 30; clamped to [1, 1000]. Applied when the bloodwork module ships.',
  },
  {
    name: 'COACH_CMD_CENTER_PER_MIN',
    tier: 'optional',
    reason: 'Phase 10 — per-user coach command-center GET reads per minute (GET /coach/command-center/*). Defaults to 60; clamped to [1, 1000]. Applied when the command-center module ships.',
  },

  // ============================================================
  // R43 — TGP Storefront Phase 1 (guest checkout + share links)
  // ============================================================
  {
    name: 'STOREFRONT_BASE_URL',
    tier: 'feature',
    reason:
      'R43 — base URL of the Next.js storefront (e.g. https://joingrowthproject.com). Used to build share_url responses for POST /v1/coach/packages/:id/share-link and the success/cancel redirects on guest checkout. Defaults to https://joingrowthproject.com in dev only; production must set explicitly (enforced in prodHardenedFeatureVars below).',
    validate: (v) => {
      const parsed = parseStorefrontBaseUrl(v);
      if (!parsed.ok) return parsed.message;
      return null;
    },
  },
  {
    name: 'APPLE_TEAM_ID',
    tier: 'feature',
    reason:
      'R43 / Universal Links — Apple Developer Team ID (10-char alphanumeric). When set, /.well-known/apple-app-site-association serves a valid AASA mapping /join/* + /invite/* to the iOS app; when unset, the route returns a syntactically-valid stub and Universal Links do not activate (warning logged).',
  },
  {
    name: 'ANDROID_SHA256_FINGERPRINT',
    tier: 'feature',
    reason:
      'R43 / Android App Links — SHA-256 of the Android signing certificate (AA:BB:CC:... colon-separated uppercase hex). Alias for ANDROID_CERT_SHA256_FINGERPRINTS used by the storefront deploy. Either env var (or both) feeds /.well-known/assetlinks.json; when neither is set, App Links do not activate (warning logged).',
  },
  {
    name: 'RESEND_API_KEY',
    tier: 'feature',
    reason:
      'R43 — Resend API key used to dispatch the guest-checkout welcome email. When unset, the guest checkout flow still completes (account + entitlement created) but the welcome email is skipped and logged. Set this before launch.',
  },
  {
    name: 'GUEST_CHECKOUT_PII_SALT',
    tier: 'optional',
    reason:
      'R43 — stable per-deploy salt fed into sha256(lower(email) || salt) for GuestCheckoutPiiScrubService. The scrub job hashes guest_email when data_retention_at has elapsed. Falls back to a build-time constant in dev/test so contributor scrub runs are deterministic; staging/production should set this to a high-entropy value rotated only when the historical hashes need to be invalidated.',
  },
  {
    name: 'RESEND_FROM_EMAIL',
    tier: 'feature',
    reason:
      'R43 — From-address Resend uses for the guest-checkout welcome email (e.g. "TGP <welcome@trygrowthproject.com>"). Falls back to a brand-aligned default in dev/test; production must set explicitly (enforced in prodHardenedFeatureVars) so welcome mail is sent from a verified domain. Never hard-code the address — Resend rejects sends from unverified domains and dropping welcome mail silently in production is a launch-blocker.',
    validate: (v) => {
      if (v.trim().length === 0) return 'RESEND_FROM_EMAIL must not be empty.';
      // Accept either a bare address or RFC 5322 "Display <addr>" — both
      // are valid Resend `from` inputs. We just require an @ in the
      // angle-bracket portion when one is present, or in the bare value.
      const angle = v.match(/<([^>]+)>/);
      const addr = (angle ? angle[1] : v).trim();
      if (!addr.includes('@')) {
        return 'RESEND_FROM_EMAIL must contain a valid email address.';
      }
      return null;
    },
  },

  // ============================================================
  // Exercise Video Providers
  // ============================================================
  {
    name: 'YMOVE_API_KEY',
    tier: 'optional',
    reason:
      'YMove exercise video API key (prefix: ym_). When set, the YMove provider returns HLS video URLs (via Bunny CDN) for up to 698 exercises. When unset, YMove is skipped and the system falls back to MuscleWiki then ExerciseDB GIF. NOTE: YMove v2 returns pre-signed URLs that expire after 48 hours — they are cached with a 3-hour Redis TTL, not persisted to the database.',
  },
  {
    name: 'MUSCLEWIKI_API_KEY',
    tier: 'optional',
    reason:
      'MuscleWiki exercise video API key (RapidAPI key). When set, the MuscleWiki provider returns stable MP4 video URLs for 1,800+ exercises. When unset, the system falls back to ExerciseDB GIF. MuscleWiki URLs are stable CDN paths cached for 24 hours and safe to persist in ExerciseCatalogItem.video_url.',
  },
  {
    name: 'EXERCISEDB_API_KEY',
    tier: 'feature',
    reason:
      'Phase 11 — RapidAPI key for the ExerciseDB catalog used by the workout builder. When unset, ExerciseLibraryService falls back to the bundled seed catalog (~50 exercises) so dev/preview environments stay functional; upstream-only routes (proxy/details endpoints) return 503 EXERCISEDB_NOT_CONFIGURED at request time rather than crashing on boot. Set this before public launch so coaches see the full catalog.',
  },
  {
    name: 'EXERCISEDB_API_HOST',
    tier: 'optional',
    reason:
      'Phase 11 — override for the RapidAPI host the exercise library calls. Defaults to "exercisedb.p.rapidapi.com". Only set this for staging/test environments pointing at a mocked host.',
  },
];

export interface EnvValidationResult {
  missingHard: string[];
  missingProd: string[];
  missingFeature: string[];
  missingOptional: string[];
  validationWarnings: string[];
  // Validator-rule failures for prod-tier vars. Under prod-like NODE_ENV these
  // are fatal (assertEnv throws), so a misconfigured RECENT_AUTH_SECRET or
  // RECENT_AUTH_TTL_MS in staging/production fails boot instead of degrading
  // at request time. In dev they are still logged as warnings via
  // validationWarnings so the operator sees the issue.
  validationErrorsProd: string[];
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

// Centralised parser for STOREFRONT_BASE_URL. Single source of truth shared
// by env-validation (boot-time warn/throw), src/main.ts (CORS auto-include),
// share-link service (share_url construction), and storefront service
// (success/cancel redirects). Returns the canonical form (no trailing
// slash) and the bare origin string browsers send in the `Origin` header.
//
// Requires an absolute http(s) URL with a non-empty host. Anything else is
// rejected with a structured message — callers decide whether to throw or
// warn based on NODE_ENV.
export type StorefrontBaseUrlParse =
  | { ok: true; canonical: string; origin: string }
  | { ok: false; message: string };

export function parseStorefrontBaseUrl(raw: string | undefined): StorefrontBaseUrlParse {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'STOREFRONT_BASE_URL must not be empty.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: 'STOREFRONT_BASE_URL must be an absolute http(s) URL.',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      message: 'STOREFRONT_BASE_URL must use the http or https protocol.',
    };
  }
  if (!parsed.host) {
    return { ok: false, message: 'STOREFRONT_BASE_URL must include a host.' };
  }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
  const origin = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, canonical, origin };
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
  const validationErrorsProd: string[] = [];

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
      if (err) {
        validationWarnings.push(`${rule.name}: ${err}`);
        // Audit #2 P2-B: prod-tier validator failures must be fatal under
        // prod-like NODE_ENV. RECENT_AUTH_SECRET / RECENT_AUTH_TTL_MS being
        // invalid in staging or production used to only log a warning and
        // then accept requests with a misconfigured auth system; now boot
        // fails when this happens.
        if (rule.tier === 'hard' || rule.tier === 'prod') {
          validationErrorsProd.push(`${rule.name}: ${err}`);
        }
      }
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
    validationErrorsProd,
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
    throw new EnvValidationError(msg, {
      code: 'ENV_MISSING_HARD',
      variables: result.missingHard,
    });
  }

  // REDIS_URL is feature-tier (dev/test fall back to in-memory) but is
  // production-required: a multi-machine Fly deploy with per-process
  // counters cannot defend against credential stuffing. Enforce here at
  // boot rather than waiting for the throttler factory so the error
  // message is unambiguous and exits before any other module wiring runs.
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') {
    const redisUrl = env.REDIS_URL;
    if (!redisUrl || redisUrl.trim().length === 0) {
      const msg =
        'REDIS_URL is required in production. Set REDIS_URL=redis(s)://host:port[/db] before deploy. ' +
        'See README.md "Placeholders / TODO env vars" section.';
      logger.error(msg);
      throw new EnvValidationError(msg, {
        code: 'ENV_REDIS_URL_REQUIRED',
        variables: ['REDIS_URL'],
      });
    }

    // Production-only hardening for feature-tier URL config: the
    // defaults baked into the code (legacy app.tgp.com hostname, mobile
    // deep-link cancel URL) are correct for dev/preview but unsafe in
    // production — they would route real coaches/clients away from the
    // public app domain. Refuse to boot prod without explicit values.
    //
    // Keep this list narrow: only vars whose defaults would silently
    // misroute production traffic belong here. Anything that returns a
    // 4xx at request time (Stripe API key) is fine to stay feature-tier
    // without this extra gate.
    const prodHardenedFeatureVars: Array<{ name: string; reason: string }> = [
      {
        name: 'PUBLIC_INVITE_BASE_URL',
        reason:
          'invite links would point at the legacy app.tgp.com placeholder hostname',
      },
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        reason:
          'without it every inbound Stripe webhook returns 400 silently — Stripe stops retrying and billing events are lost',
      },
      {
        name: 'STRIPE_CHECKOUT_SUCCESS_URL',
        reason:
          'Stripe Checkout success redirect would only resolve via the mobile deep-link scheme, breaking web checkouts',
      },
      {
        name: 'STRIPE_CHECKOUT_CANCEL_URL',
        reason:
          'Stripe Checkout cancel redirect would only resolve via the mobile deep-link scheme, breaking web checkouts',
      },
      {
        name: 'ANTHROPIC_API_KEY',
        reason: 'Primary AI provider; app boots without it but all client AI guide responses fall back to deterministic local content indistinguishable from real AI.',
      },
      {
        name: 'STOREFRONT_BASE_URL',
        reason:
          'R43 storefront — without it the share-link service falls back to the dev-only canonical origin and the storefront origin is missing from CORS, breaking the public package endpoint from any browser.',
      },
      {
        name: 'RESEND_FROM_EMAIL',
        reason:
          'R43 storefront — Resend rejects sends from unverified domains. Without an explicit from-address tied to a verified domain, welcome mail drops silently and guests never receive credentials/invite links.',
      },
      {
        name: 'APPLE_TEAM_ID',
        reason:
          'R43 / Universal Links — without APPLE_TEAM_ID the .well-known/apple-app-site-association document is structurally empty, so iOS refuses to associate /join/* and /invite/* links with the installed app. Production must NEVER serve a stub AASA.',
      },
      {
        name: 'ANDROID_CERT_SHA256_FINGERPRINTS',
        reason:
          'R43 / Android App Links — without an Android signing-cert SHA256 fingerprint, the .well-known/assetlinks.json document is empty and Android refuses to associate /join/* and /invite/* links with the installed app. Production must NEVER serve a stub assetlinks.json. ANDROID_SHA256_FINGERPRINT is accepted as an alias.',
      },
      {
        name: 'GUEST_CHECKOUT_PII_SALT',
        reason:
          'Audit #4 P2-2 — GuestCheckoutPiiScrubService refuses to run on prod without an explicit salt. A missing salt would fall back to the dev constant baked into the repo, producing reversible hashes against any known email list and defeating the GDPR retention scrub.',
      },
    ];
    const missing = prodHardenedFeatureVars.filter(
      (v) => {
        // ANDROID_CERT_SHA256_FINGERPRINTS accepts a comma/whitespace
        // separated list; ANDROID_SHA256_FINGERPRINT is an accepted
        // single-value alias. Either env var being set counts.
        if (v.name === 'ANDROID_CERT_SHA256_FINGERPRINTS') {
          const a = env.ANDROID_CERT_SHA256_FINGERPRINTS;
          const b = env.ANDROID_SHA256_FINGERPRINT;
          const ok =
            (typeof a === 'string' && a.trim().length > 0) ||
            (typeof b === 'string' && b.trim().length > 0);
          return !ok;
        }
        return (
          typeof env[v.name] !== 'string' ||
          env[v.name]!.trim().length === 0
        );
      },
    );
    if (missing.length) {
      const msg =
        `Production-required URL config is missing: ` +
        missing.map((v) => `${v.name} (${v.reason})`).join('; ');
      logger.error(msg);
      throw new EnvValidationError(msg, {
        code: 'ENV_PROD_HARDENED_MISSING',
        variables: missing.map((v) => v.name),
      });
    }
  }

  // Placeholder values for hard-tier vars are always fatal — these were never
  // intended to ship. Variable *names* are logged; values are not.
  if (result.placeholderHard.length) {
    const msg = `Required env vars contain placeholder values (replace with real values): ${result.placeholderHard.join(', ')}`;
    logger.error(msg);
    throw new EnvValidationError(msg, {
      code: 'ENV_PLACEHOLDER_HARD',
      variables: result.placeholderHard,
    });
  }

  if (result.missingProd.length) {
    if (enforceProd) {
      const msg = `Missing production-required env vars (NODE_ENV=${env.NODE_ENV}): ${result.missingProd.join(', ')}`;
      logger.error(msg);
      throw new EnvValidationError(msg, {
        code: 'ENV_MISSING_PROD',
        variables: result.missingProd,
      });
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
      throw new EnvValidationError(msg, {
        code: 'ENV_PLACEHOLDER_PROD',
        variables: result.placeholderProd,
      });
    } else {
      logger.warn(
        `Production-tier env vars contain placeholder values (ok in dev, required for staging/prod): ${result.placeholderProd.join(', ')}`,
      );
    }
  }

  // Audit #2 P2-B: validator failures on hard/prod-tier vars are fatal under
  // prod-like NODE_ENV. Catches the case where RECENT_AUTH_SECRET is set but
  // too short, or RECENT_AUTH_TTL_MS is set but out of range — boot used to
  // continue and only fail at the first request that hit the recent-auth
  // endpoint. Now we fail loudly at startup. In dev these are still surfaced
  // via the validationWarnings logger.warn below.
  if (result.validationErrorsProd.length && enforceProd) {
    const msg = `Production-tier env vars failed validation (NODE_ENV=${env.NODE_ENV}): ${result.validationErrorsProd.join('; ')}`;
    logger.error(msg);
    throw new EnvValidationError(msg, {
      code: 'ENV_VALIDATION_ERROR_PROD',
      variables: result.validationErrorsProd.map((s) => s.split(':')[0]),
    });
  }

  // Feature-tier vars never block boot. Warn loudly under prod-like
  // NODE_ENV so operators see what's degraded; stay quiet in dev.
  if (result.missingFeature.length && enforceProd) {
    logger.warn(
      `Feature-tier env vars missing — related features are disabled or return 4xx at call time (NODE_ENV=${env.NODE_ENV}): ${result.missingFeature.join(', ')}`,
    );
  }

  // Audit #4 P1: surface a distinct, named warning when BOTH Google client-id
  // env vars are absent in prod-like envs. The recent-auth flow's Google
  // branch verifies tokens against these audiences; without either, every
  // Google re-auth attempt is rejected with a generic 401, which can be
  // misread as a mobile bug. Boot is NOT blocked — Google is an optional
  // provider — but the warning gives operators a single, searchable line
  // tying the symptom to the missing config. Apple has equivalent behaviour
  // via APPLE_AUDIENCES (returns 503 from /auth/apple).
  if (enforceProd) {
    const googleIdSet =
      typeof env.GOOGLE_CLIENT_ID === 'string' && env.GOOGLE_CLIENT_ID.trim().length > 0;
    const googleIdsSet =
      typeof env.GOOGLE_CLIENT_IDS === 'string' && env.GOOGLE_CLIENT_IDS.trim().length > 0;
    if (!googleIdSet && !googleIdsSet) {
      logger.warn(
        `Google recent-auth disabled — neither GOOGLE_CLIENT_ID nor GOOGLE_CLIENT_IDS is set. /auth/signup-policy will omit "google" from providers and Google OAuth users cannot complete sensitive actions (e.g. account deletion). Set at least one to enable. (NODE_ENV=${env.NODE_ENV})`,
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
