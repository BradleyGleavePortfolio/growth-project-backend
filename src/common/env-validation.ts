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

// Audit A276-F3-P2-1 — single source of truth for the CHECKOUT_RECOVERY_SECRET
// minimum length. Referenced from BOTH the boot validator (prodHardenedFeatureVars)
// AND the runtime consumers (CheckoutCookieService, CheckoutRecoveryService) so
// a future change in one place cannot drift out of step with the others.
//
// Why 43, not 32: CHECKOUT_RECOVERY_SECRET is used as the HMAC key for HS256
// JWTs that travel in user-facing magic-link URLs (15-min recovery token) and
// in 7-day guest_session cookies. RFC 7518 §3.2 (JSON Web Algorithms) requires
// the HMAC key for HS256 to be at least as long as the hash output, i.e. 256
// bits = 32 random bytes. Encoded base64url without padding that is 43 chars
// (ceil(32 * 4 / 3) = 43). A 32-CHARACTER floor passes a 32-byte ASCII string
// like 'aaa…aaa' which carries far less than 256 bits of entropy; a 43-char
// base64url encoding of 32 CSPRNG bytes carries the full 256 bits. This is
// the Stripe/Auth0-grade floor for HS256.
//
// Operators should generate the value with: `openssl rand -base64 32 | tr -d '=\n'`
export const MIN_CHECKOUT_RECOVERY_SECRET_LENGTH = 43;

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
  // S-ENVTRUTH — the real code default: what the code does when the var is
  // unset (a literal, a named constant, or the fail-closed behaviour). Purely
  // descriptive; never read at runtime. Required on every rule added by the
  // env-truth inventory so operators can tell "deliberately unset" from
  // "forgotten".
  default?: string;
  // S-ENVTRUTH — launch classification (descriptive only; never read at
  // runtime and never changes boot behaviour):
  //   'required'             must hold a real value before launch
  //   'switch'               a launch switch whose default must stay as shipped
  //   'optional-integration' an integration that is NOT a launch dependency;
  //                          its flags must be explicitly false or unset
  launch?: 'required' | 'switch' | 'optional-integration';
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
    name: 'STRIPE_PUBLISHABLE_KEY',
    tier: 'feature',
    reason:
      'R43 storefront — publishable key embedded in the guest-checkout payment response so the browser Stripe.js SDK can confirm the PaymentIntent. REQUIRED in staging/production (enforced via prodHardenedFeatureVars): the storefront service throws ServiceUnavailable on every public package request when missing, silently 503-ing the storefront on day one. MUST begin with "pk_test_" or "pk_live_"; secret keys (sk_*) are rejected at boot to catch copy-paste swaps.',
    validate: (v) => {
      const trimmed = v.trim();
      if (trimmed.length === 0) return 'STRIPE_PUBLISHABLE_KEY must not be empty.';
      if (!/^pk_(test|live)_/.test(trimmed)) {
        return 'STRIPE_PUBLISHABLE_KEY must start with "pk_test_" or "pk_live_". Secret keys (sk_*) are not accepted.';
      }
      return null;
    },
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    tier: 'feature',
    reason:
      'HMAC signing secret for /v1/webhooks/stripe. Without it the webhook controller rejects every request with 400 — no boot dependency. Set this *before* pointing Stripe at the webhook URL. Audit #5 P2-2 — validator catches the most common operator typo: a value that does not start with the canonical Stripe "whsec_" prefix. Length is not enforced here so dev/test fixtures using short stub values still pass; the webhook controller will reject any malformed signature at request time.',
    validate: (v) => {
      const trimmed = v.trim();
      if (trimmed.length === 0) return null;
      if (!trimmed.startsWith('whsec_')) {
        return 'STRIPE_WEBHOOK_SECRET must start with "whsec_" (Stripe webhook-secret format).';
      }
      return null;
    },
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
    launch: 'required',
    default: 'unset → falls back to GOOGLE_CLIENT_ID; with neither set every Google ID token is rejected',
    reason:
      'Comma-separated allow-list of Google OAuth client IDs accepted as audiences by the local Google ID-token verifier. Supersedes GOOGLE_CLIENT_ID when both are set; use this when the platform issues separate iOS / Android / Web client IDs. Required for launch (operator 2026-10-01): Google sign-in audience for the Supabase Google provider web client. Stored as a GitHub Actions secret and pushed to Fly by .github/workflows/fly-env-sync.yml (staged, applied at the next deploy).',
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
    name: 'WEARABLE_PROCESSED_EVENT_RETENTION_DAYS',
    tier: 'optional',
    reason: 'Retention window (in days) for the WearableProcessedEvent webhook-idempotency ledger. The daily prune deletes rows whose processed_at is older than this many days. Defaults to 30 (>2x the longest provider redelivery window of ≥14d). 0 prunes everything older than now; a missing, blank, non-numeric, or negative value falls back to 30.',
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
    name: 'AUTH_OAUTH_COACH_SIGNUP_PER_HOUR',
    tier: 'optional',
    default: '5 per IP per hour (unset, unparseable or < 1 fall back; clamped to 500)',
    reason: 'Clinic C13 — per-IP ceiling on brand-new COACH accounts created through /auth/google and /auth/apple per hour (login success never resets it). Client creates are not counted (clinic QR intake). Default 5, clamped to [1, 500].',
  },
  {
    name: 'SIGNUP_ROLE_CHOICE_ENABLED',
    tier: 'optional',
    default: "on (unset = on; only 'false', '0' or 'off' turn it off)",
    reason: "Clinic C13 kill switch — signup-time client/coach role choice. Default ON (unset = on). Set 'false' to make every signup a client: intended_role is still accepted (no 400 for any app build) but ignored, and /auth/signup-policy reports role_choice=false so mobile hides the picker.",
  },
  {
    name: 'AUTH_SIGNUP_WITH_CODE_PER_HOUR',
    tier: 'optional',
    reason: 'Clinic C03 — per-IP POST /auth/signup-with-code attempts per hour when the body carries a well-formed invite code (QR intake bursts behind one NAT). Codeless signups keep the 5/hour auth-signup baseline. Defaults to 100 (a 40+ patient clinic event on one Wi-Fi IP inside an hour, with retries); clamped to [5, 500].',
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
    tier: 'feature',
    reason:
      'R43 — stable per-deploy salt fed into sha256(lower(email) || salt) for GuestCheckoutPiiScrubService. REQUIRED in staging/production: prodHardenedFeatureVars refuses to boot without it (see below) because a missing salt would fall back to the dev constant baked into the repo, producing reversible hashes against any known email list and defeating the GDPR retention scrub. Dev/test use a deterministic build-time constant. Rotate only when the historical hashes need to be invalidated.',
  },
  {
    name: 'CHECKOUT_RECOVERY_SECRET',
    tier: 'feature',
    reason:
      'r48 / audit A276-P1-1 + A276-F3-P2-1 — HS256 key shared by CheckoutRecoveryService (signs the 15-minute magic-link JWT used to resume an abandoned checkout) AND CheckoutCookieService (signs the 7-day guest_session cookie). MUST be ≥43 chars of high-entropy data (RFC 7518 §3.2 requires HS256 keys to carry ≥256 bits of entropy; 32 random bytes encoded base64url without padding = 43 chars). REQUIRED in production: prodHardenedFeatureVars (see assertEnv) refuses to boot when missing or shorter than MIN_CHECKOUT_RECOVERY_SECRET_LENGTH chars under NODE_ENV=production. The recovery service throws 400 at request time when missing (loud failure), but the cookie service silently no-ops (failure #36), so a missing secret would deploy with the 7-day guest session cookie disabled and nobody would notice. The `validate` callback below surfaces the same floor as a warning in dev/staging so contributors see the issue before pushing. Dev/test can leave it unset; both services skip / 400 with a clear message. Generate with: `openssl rand -base64 32 | tr -d "=\n"`.',
    validate: (v) => {
      const trimmed = v.trim();
      if (trimmed.length < MIN_CHECKOUT_RECOVERY_SECRET_LENGTH) {
        return `CHECKOUT_RECOVERY_SECRET must be at least ${MIN_CHECKOUT_RECOVERY_SECRET_LENGTH} characters long (got ${trimmed.length}) — see RFC 7518 §3.2.`;
      }
      return null;
    },
  },
  {
    name: 'RESEND_FROM_EMAIL',
    tier: 'feature',
    reason:
      'R43 — From-address Resend uses for the guest-checkout welcome email (e.g. "Growth Project <welcome@trygrowthproject.com>"). Falls back to a brand-aligned default in dev/test; production must set explicitly (enforced in prodHardenedFeatureVars) so welcome mail is sent from a verified domain. Audit #5 P2-3 — customer-facing copy uses the brand name "Growth Project", never the internal abbreviation "TGP". Never hard-code the address — Resend rejects sends from unverified domains and dropping welcome mail silently in production is a launch-blocker.',
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
    default: 'unset → provider skipped; falls back to ExerciseDB',
    reason:
      'YMove exercise video API key (prefix: ym_). When set, the YMove provider returns HLS video URLs (via Bunny CDN) for up to 698 exercises. When unset, YMove is skipped and the system falls back to MuscleWiki then ExerciseDB GIF. NOTE: YMove v2 returns pre-signed URLs that expire after 48 hours — they are cached with a 3-hour Redis TTL, not persisted to the database. Not used in v1 / alternative provider ExerciseDB (EXERCISEDB_API_KEY) is live.',
  },
  {
    name: 'MUSCLEWIKI_API_KEY',
    tier: 'optional',
    default: 'unset → provider skipped; falls back to ExerciseDB',
    reason:
      'MuscleWiki exercise video API key (RapidAPI key). When set, the MuscleWiki provider returns stable MP4 video URLs for 1,800+ exercises. When unset, the system falls back to ExerciseDB GIF. MuscleWiki URLs are stable CDN paths cached for 24 hours and safe to persist in ExerciseCatalogItem.video_url. Not used in v1 / alternative provider ExerciseDB (EXERCISEDB_API_KEY) is live.',
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

  // ============================================================
  // R43 — Coach Brief (daily AI dispatch)
  // ============================================================
  {
    name: 'COACH_BRIEF_ENABLED',
    tier: 'feature',
    reason:
      'R43 — global server-side kill switch for the entire Coach Brief surface. When set to "off", every /coach/brief/* route returns 404 NOT_FOUND and the scheduler is a no-op. Any other value (or absent) leaves the feature on. Default is on. Validator only accepts "on" or "off" so a typo like "false" cannot silently leave the feature live.',
    validate: (v) => {
      const trimmed = v.trim().toLowerCase();
      if (trimmed !== 'on' && trimmed !== 'off') {
        return 'COACH_BRIEF_ENABLED must be exactly "on" or "off" (case-insensitive). To leave the feature on, omit the variable.';
      }
      return null;
    },
  },
  {
    name: 'COACH_BRIEF_NOTIFICATIONS_ENABLED',
    tier: 'feature',
    reason:
      'R43 — set to "off" to globally disable the daily Coach Brief push dispatch. When absent or any value other than "off", the scheduler runs every minute and fires per-coach pushes when each coach\'s notification_time matches their local timezone. Brief generation itself is unaffected; only the cron-driven push is gated. Note: COACH_BRIEF_ENABLED=off takes precedence and disables BOTH generation and push.',
  },
  {
    name: 'COACH_BRIEF_CRON',
    tier: 'optional',
    reason:
      'R43 — override for the @Cron schedule on CoachBriefScheduler.dispatchDailyBriefs. Defaults to "* * * * *" (every UTC minute) so per-coach notification times have ~1 minute resolution. Set this only for staging/test environments where you want a deterministic firing window.',
  },
  {
    name: 'COACH_BRIEF_RETENTION_DAYS',
    tier: 'feature',
    reason:
      'Days of CoachBrief history retained before TTL prune. GDPR Art.17 hygiene — embedded client_name in brief_context JSON ages out within this window. Defaults to 7 when absent or unparseable. (BL-GDPR-BRIEF-2)',
  },

  // ============================================================
  // S-ENVTRUTH inventory (2026-10-01). Every env name read anywhere in
  // runtime src/ is registered here so the boot summary, the H4 board, the
  // operator keys list and the in-machine env-truth classifier
  // (.github/workflows/fly-env-truth.yml) can see it. `default` records the
  // REAL code default (what the code does when the var is unset); nothing in
  // this block adds a validator or changes runtime behaviour. Enforced by
  // test/prod-readiness/env-registration.spec.ts: a new src/ env read that is
  // not registered fails CI.
  // ============================================================
  // --- AUTH / ADMIN ---
  {
    name: 'ADMIN_SERVICE_TOKEN',
    tier: 'feature',
    default:
      'unset → ServiceTokenGuard throws 401 "Service token not configured" on every service-token route',
    reason:
      'Bearer token the finance/admin console presents to service-token-guarded admin routes (src/auth/service-token.guard.ts). Unset disables those routes (fail closed).',
  },
  {
    name: 'BOOTSTRAP_SECRET',
    tier: 'optional',
    default: 'unset → POST bootstrap-first-owner returns 403 "Bootstrap endpoint is not enabled"',
    reason:
      'One-time secret for promoting the first owner account (auth.service.ts bootstrapFirstOwner). Unset after use; absence is the safe steady state.',
  },
  {
    name: 'APPLE_NONCE_REQUIRED',
    tier: 'optional',
    default: 'unset → nonce check skipped (only the literal "true" enforces it)',
    reason:
      'Sign in with Apple: require the hashed nonce claim on the identity token when exactly "true".',
  },
  {
    name: 'SUPABASE_ANON_KEY',
    tier: 'feature',
    default:
      "unset → '' passed to the Supabase auth client (signup / sign-in / password flows fail at request time)",
    reason:
      'Supabase anon (public) key used by AuthService for user-scoped Supabase auth calls. Not a boot dependency, but every password/OTP auth flow fails without it.',
  },
  {
    name: 'SUPABASE_REDIRECT_URL',
    tier: 'optional',
    default: "'tgp://verified'",
    reason:
      'emailRedirectTo for Supabase signup confirmation links (auth.service.ts). The code default is the app deep link.',
  },
  {
    name: 'JWT_SECRET',
    tier: 'optional',
    default: 'unset → last-resort fallback only',
    reason:
      'Read only as the third fallback signing key for contract PDF URLs (CONTRACT_PDF_URL_SECRET → DATA_EXPORT_DOWNLOAD_SECRET → JWT_SECRET) in src/contracts/signed-pdf-store.service.ts. Contracts are not used in v1. Supabase JWTs are verified via JWKS, not this value.',
  },
  // --- AI ---
  {
    name: 'AI_GATEWAY_ENABLED',
    tier: 'optional',
    default: 'unset → off (envFlag: only true/1/yes/on enable)',
    reason:
      'Master switch for the AI gateway (src/ai/gateway/ai-gateway.config.ts). Off means every capability resolves to the stub provider.',
  },
  {
    name: 'AI_GATEWAY_PROVIDER',
    tier: 'optional',
    default: "'stub'",
    reason:
      'AI gateway provider: perplexity / openai / anthropic; anything else normalises to stub. Anthropic is the live provider in v1.',
  },
  {
    name: 'AI_GATEWAY_CAPABILITIES',
    tier: 'optional',
    default: "unset → no capability allowed ('*' allows all)",
    reason: 'Comma-separated capability allow-list for the AI gateway.',
  },
  {
    name: 'AI_GATEWAY_REQUIRE_APPROVAL',
    tier: 'optional',
    default:
      'unset → DEFAULT_APPROVAL_REQUIRED (draft.coach_message, draft.meal_plan_change, draft.client_facing_claim, …)',
    reason:
      'Comma-separated capabilities that need human approval. Default-on safety: unset keeps the canonical consequential capabilities gated.',
  },
  {
    name: 'OPENAI_API_KEY',
    tier: 'optional',
    default: 'unset → openai provider reports no key',
    reason:
      'Not used in v1 / alternative provider Anthropic (ANTHROPIC_API_KEY) is live. Only consulted when AI_GATEWAY_PROVIDER=openai.',
  },
  {
    name: 'COACH_AI_BUDGET_ROLLOVER_CRON',
    tier: 'optional',
    default: "'5 * * * *' (COACH_AI_BUDGET_ROLLOVER_CRON_DEFAULT)",
    reason: 'Cron for the coach AI budget rollover scheduler.',
  },
  {
    name: 'COACH_AI_BUDGET_ROLLOVER_ENABLED',
    tier: 'optional',
    default: '\'true\' (only "false" disables)',
    reason: 'Kill switch for the coach AI budget rollover cron.',
  },
  {
    name: 'COACH_AI_DORMANCY_UNREAD_THRESHOLD',
    tier: 'optional',
    default: '3 (COACH_AI_DORMANCY_UNREAD_THRESHOLD_DEFAULT; values < 1 fall back)',
    reason: 'Unread-draft count after which the dormancy guard pauses coach AI drafting.',
  },
  {
    name: 'COACH_AI_MAX_ACTUAL_CENTS',
    tier: 'feature',
    default:
      '4000 (COACH_AI_MAX_ACTUAL_CENTS_DEFAULT) — production boot requires it set (prodHardenedFeatureVars)',
    reason:
      'Per-request ceiling on actual AI provider spend in cents. Enforced present at production boot by prodHardenedFeatureVars in this file; registered here so the inventory sees it.',
  },
  {
    name: 'COACH_AI_VALUE_MULTIPLIER',
    tier: 'feature',
    default:
      '3.125 (COACH_AI_VALUE_MULTIPLIER_DEFAULT) — production boot requires it set (prodHardenedFeatureVars)',
    reason:
      'Credit value multiplier for coach AI packs. Enforced present at production boot by prodHardenedFeatureVars in this file.',
  },
  {
    name: 'COACH_AI_PACK_SUCCESS_URL',
    tier: 'optional',
    default: "STRIPE_CHECKOUT_SUCCESS_URL, else 'https://app.trygrowthproject.com/billing/success'",
    reason: 'Stripe Checkout success URL for coach AI credit packs.',
  },
  {
    name: 'COACH_AI_PACK_CANCEL_URL',
    tier: 'optional',
    default: "STRIPE_CHECKOUT_CANCEL_URL, else 'https://app.trygrowthproject.com/billing/cancel'",
    reason: 'Stripe Checkout cancel URL for coach AI credit packs.',
  },
  {
    name: 'COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN',
    tier: 'optional',
    default: '5 (clamped 1..120)',
    reason: 'Throttle: coach AI credit-pack checkout requests per minute.',
  },
  // --- URLS / IDENTIFIERS ---
  {
    name: 'APP_URL',
    tier: 'optional',
    default: "'https://app.thegrowthproject.app'",
    reason: 'Base URL for links in digests, nudges and the Google OAuth return redirect.',
  },
  {
    name: 'CONSOLE_URL',
    tier: 'optional',
    default: "'https://console.thegrowthproject.app'",
    reason: 'Coach console base URL used in coach digest emails.',
  },
  {
    name: 'PUBLIC_APP_BASE_URL',
    tier: 'optional',
    default: "PUBLIC_INVITE_BASE_URL without '/join', else 'https://app.trygrowthproject.com'",
    reason: 'Base URL for landing-page links.',
  },
  {
    name: 'BILLING_PORTAL_URL',
    tier: 'optional',
    default: "'https://thegrowthproject.app/billing'",
    reason: 'Billing portal link in dunning emails.',
  },
  {
    name: 'IOS_BUNDLE_ID',
    tier: 'optional',
    default: "'com.growthproject.app'",
    reason: 'iOS bundle id served in apple-app-site-association.',
  },
  {
    name: 'ANDROID_PACKAGE_NAME',
    tier: 'optional',
    default: "'com.growthproject.app'",
    reason: 'Android package name served in assetlinks.json.',
  },
  {
    name: 'ANDROID_CERT_SHA256_FINGERPRINTS',
    tier: 'optional',
    default:
      'unset → stub assetlinks.json in dev; production refuses (prodHardenedFeatureVars, either this or ANDROID_SHA256_FINGERPRINT)',
    reason:
      'Android App Links signing-cert SHA-256 fingerprints (comma-separated). Alias of ANDROID_SHA256_FINGERPRINT (feature tier, registered above); production boot requires one of the two (prodHardenedFeatureVars). Read by well-known.controller.ts.',
  },
  {
    name: 'LANDING_CNAME_TARGET',
    tier: 'optional',
    default: "'cname.trygrowthproject.com'",
    reason: 'CNAME target coaches point custom landing domains at.',
  },
  {
    name: 'LANDING_VIEW_HASH_SECRET',
    tier: 'feature',
    default:
      'unset → production refuses to hash visitors (throws); production boot requires it (prodHardenedFeatureVars)',
    reason: 'HMAC secret for landing-page visitor hashes.',
  },
  {
    name: 'COMMUNITY_EVENT_LINK_HOSTS',
    tier: 'optional',
    default: "'' → built-in allow-list only (zoom.us, zoom.com, …)",
    reason: 'Extra comma-separated host suffixes allowed for community event links.',
  },
  // --- EMAIL ---
  {
    name: 'EMAIL_TRANSPORT',
    tier: 'feature',
    default: "'log' (emails are logged, not sent)",
    reason:
      "Email transport: 'resend' (live) or 'log'. Must be 'resend' in production for any email to send.",
  },
  {
    name: 'EMAIL_FROM_ADDRESS',
    tier: 'feature',
    default: "'noreply@thegrowthproject.app'",
    reason:
      'From-address for transactional and digest email. Must be a Resend-verified domain when EMAIL_TRANSPORT=resend (EmailService throws otherwise).',
  },
  {
    name: 'SENDGRID_API_KEY',
    tier: 'optional',
    default: 'unset → digest send skipped with a warn',
    reason: 'Not used in v1 / alternative provider Resend (RESEND_API_KEY) is live.',
  },
  {
    name: 'POSTMARK_SERVER_TOKEN',
    tier: 'optional',
    default: 'unset → digest send skipped with a warn',
    reason: 'Not used in v1 / alternative provider Resend (RESEND_API_KEY) is live.',
  },
  {
    name: 'EMAIL_DIGEST_CLIENT_ENABLED',
    tier: 'optional',
    default: 'on (only "off" disables)',
    reason: 'Kill switch for the client daily digest email.',
  },
  {
    name: 'EMAIL_DIGEST_COACH_ENABLED',
    tier: 'optional',
    default: 'on (only "off" disables)',
    reason: 'Kill switch for the coach daily digest email.',
  },
  // --- CRONS / SCHEDULERS ---
  {
    name: 'CLIENT_DAILY_CRON',
    tier: 'optional',
    default: "'0 7 * * *'",
    reason: 'Cron for the client daily digest.',
  },
  {
    name: 'COACH_DAILY_CRON',
    tier: 'optional',
    default: "'0 6 * * *'",
    reason: 'Cron for the coach daily digest.',
  },
  {
    name: 'WEEKLY_DIGEST_CRON',
    tier: 'optional',
    default: "'0 8 * * 0'",
    reason: 'Cron for the weekly digest.',
  },
  {
    name: 'NUDGE_DETECTION_CRON',
    tier: 'optional',
    default: "'*/15 * * * *'",
    reason: 'Cron for nudge detection.',
  },
  {
    name: 'NUDGE_ENABLED',
    tier: 'optional',
    default: 'on (only "off" disables)',
    reason: 'Kill switch for nudge detection.',
  },
  {
    name: 'BOOKING_REMINDER_1H_CRON',
    tier: 'optional',
    default: "'*/5 * * * *'",
    reason: 'Cron for 1-hour booking reminders.',
  },
  {
    name: 'BOOKING_REMINDER_24H_CRON',
    tier: 'optional',
    default: "'*/15 * * * *'",
    reason: 'Cron for 24-hour booking reminders.',
  },
  {
    name: 'BOOKING_REMINDERS_ENABLED',
    tier: 'optional',
    launch: 'switch',
    default: '\'on\' (only "off" disables)',
    reason:
      'Launch switch (operator 2026-10-01): kill switch for the booking reminder crons. Ships on; only "off" disables. Must stay on (unset or "on") for launch.',
  },
  {
    name: 'DELETION_FINALIZE_CRON',
    tier: 'optional',
    default: "'0 3 * * *'",
    reason: 'Cron for finalising account deletions after the grace period.',
  },
  {
    name: 'LEADERBOARD_ENABLED',
    tier: 'optional',
    default: '\'on\' (only "off" disables)',
    reason: 'Kill switch for leaderboard recompute and reads.',
  },
  {
    name: 'LEADERBOARD_RECOMPUTE_CRON',
    tier: 'optional',
    default: "'0 6 * * *' (LEADERBOARD_RECOMPUTE_CRON_DEFAULT)",
    reason: 'Cron for leaderboard recompute.',
  },
  {
    name: 'BLOODWORK_STALE_DISABLED',
    tier: 'optional',
    default: 'unset → scheduler runs (only "true" disables)',
    reason: 'Kill switch for the bloodwork staleness scheduler.',
  },
  {
    name: 'BLOODWORK_STALE_AFTER_DAYS',
    tier: 'optional',
    default: '365 (DEFAULT_STALE_AFTER_DAYS)',
    reason: 'Days after which a bloodwork panel is marked stale.',
  },
  {
    name: 'CHECKOUT_RECEIPT_DISABLED',
    tier: 'optional',
    default: 'unset → scheduler runs (only "true" disables)',
    reason: 'Kill switch for the checkout receipt scheduler.',
  },
  {
    name: 'LEGACY_PDF_RECEIPT_ENABLED',
    tier: 'optional',
    default: 'unset → legacy PDF receipts off (only "true" enables)',
    reason: 'Legacy PDF receipt generation.',
  },
  {
    name: 'CHECKOUT_RECONCILE_DISABLED',
    tier: 'optional',
    default: 'unset → reconcile runs (only "true" disables)',
    reason: 'Kill switch for the lost-webhook checkout reconcile job.',
  },
  {
    name: 'CRM_LEAD_SYNC_DISABLED',
    tier: 'optional',
    default: 'unset → sync runs (only "true" disables)',
    reason: 'Kill switch for the CRM lead sync processor.',
  },
  {
    name: 'DRIP_DISPATCHER_ENABLED',
    tier: 'optional',
    default: 'unset → dispatcher runs (only "false" disables)',
    reason: 'Kill switch for the package drip dispatcher cron.',
  },
  {
    name: 'AUDIT_LOGGING_ENABLED',
    tier: 'optional',
    default: "'on'",
    reason: 'Audit log writes (audit.service.ts); "off" disables.',
  },
  // --- TTLS / LIMITS ---
  {
    name: 'DATA_EXPORT_EXPIRY_DAYS',
    tier: 'optional',
    default: '7',
    reason: 'Days a "download my data" export stays downloadable.',
  },
  {
    name: 'DATA_EXPORT_RATE_LIMIT_HRS',
    tier: 'optional',
    default: '24',
    reason: 'Minimum hours between data export requests per user.',
  },
  {
    name: 'DATA_EXPORT_FS_DIR',
    tier: 'optional',
    default: "'/tmp/exports'",
    reason: 'Local directory export files are written to (ephemeral, per machine).',
  },
  {
    name: 'DATA_EXPORT_TOKEN_SECRET',
    tier: 'feature',
    default:
      "'change-me-in-production-min32chars!' in dev; production throws unless a real 32+ char secret is set",
    reason: 'HMAC secret for data-export download tokens (data-export.service.ts).',
  },
  {
    name: 'DATA_EXPORT_DOWNLOAD_SECRET',
    tier: 'optional',
    default: 'unset → next fallback (JWT_SECRET)',
    reason:
      'Second fallback signing key for contract PDF URLs (signed-pdf-store.service.ts). Contracts are not used in v1; the data-export flow itself signs with DATA_EXPORT_TOKEN_SECRET.',
  },
  {
    name: 'DATA_EXPORT_BUCKET',
    tier: 'optional',
    default: 'unset → contract PDFs stay on local disk',
    reason:
      'Read only as the CONTRACT_PDF_BUCKET fallback. Contracts are not used in v1 and the data-export cloud storage path is not built, so setting it changes nothing for "download my data".',
  },
  {
    name: 'DELETION_GRACE_DAYS',
    tier: 'optional',
    default: '14 (non-positive / unparseable fall back)',
    reason: 'Days between an account deletion request and finalisation.',
  },
  {
    name: 'DELETION_TOKEN_TTL_HOURS',
    tier: 'optional',
    default: '24 (non-positive / unparseable fall back)',
    reason: 'Lifetime of an account-deletion confirmation token.',
  },
  {
    name: 'RECEIPT_FS_DIR',
    tier: 'optional',
    default: "'/tmp/checkout-receipts'",
    reason: 'Local directory for checkout receipt files.',
  },
  {
    name: 'DUNNING_CADENCE_DAYS',
    tier: 'optional',
    default: 'DEFAULT_DUNNING_CADENCE (dunning.service.ts); malformed lists fall back',
    reason: 'Comma-separated dunning step offsets in days.',
  },
  // The four dunning tunables below are read through numEnv(env, 'NAME', d) on
  // a ProcessEnv alias (dunning.service.ts resolveDunningConfig); the scanner
  // only saw them once alias-keyed helper reads were followed (B-624-2).
  {
    name: 'DUNNING_GRACE_DAYS',
    tier: 'optional',
    default: '7 (non-positive / unparseable fall back)',
    reason: 'Dunning grace period in days (resolveDunningConfig graceDays).',
  },
  {
    name: 'DUNNING_MAX_FAILURES',
    tier: 'optional',
    default: '4 (non-positive / unparseable fall back)',
    reason: 'Dunning failed-payment ceiling (resolveDunningConfig maxFailures).',
  },
  {
    name: 'DUNNING_MAX_SEND_RETRIES',
    tier: 'optional',
    default: '3 (non-positive / unparseable fall back)',
    reason: 'Email-send retries per dunning attempt before it is marked failed_permanent.',
  },
  {
    name: 'DUNNING_RETRY_BACKOFF_MS',
    tier: 'optional',
    default: '3600000 = 1 h (non-positive / unparseable fall back)',
    reason: 'Base of the dunning email-send retry backoff (base * 4^n), in milliseconds.',
  },
  {
    name: 'FEATURE_AI_CONSENT_LEDGER_ENABLED',
    tier: 'optional',
    default: "off (on only when exactly 'true', case-insensitive)",
    reason:
      "AI processing consent ledger master switch (src/ai-consent, #622). While off every /me/ai-consent route returns 503 AI_CONSENT_UNAVAILABLE and hasClientAiConsent() is false for everyone. prod-switches.yml: feature, prod_default OFF.",
  },
  {
    name: 'MEDIA_SIGNED_URL_TTL_SEC',
    tier: 'optional',
    default: '900 (clamped 60..86400)',
    reason: 'Signed URL lifetime for classroom media.',
  },
  {
    name: 'VOICE_SIGNED_URL_TTL_SEC',
    tier: 'optional',
    default: '600 (VOICE_UPLOAD_TTL_SEC, clamped 60..86400)',
    reason: 'Signed upload URL lifetime for community voice notes.',
  },
  {
    name: 'VOICE_NOTE_MAX_BYTES',
    tier: 'optional',
    default: '25000000 (MAX_VOICE_BYTES)',
    reason: 'Maximum community voice note size in bytes.',
  },
  {
    name: 'VOICE_NOTE_MAX_DURATION_MS',
    tier: 'optional',
    default: '300000 (MAX_VOICE_DURATION_MS)',
    reason: 'Maximum community voice note duration in milliseconds.',
  },
  {
    name: 'COMMUNITY_SEARCH_PAGE_SIZE',
    tier: 'optional',
    default: '20 (SEARCH_PAGE_SIZE_DEFAULT, max 50)',
    reason: 'Community search page size.',
  },
  {
    name: 'COMMUNITY_ACK_SLA_SOFT_MS',
    tier: 'optional',
    default: '86400000 (24h, DEFAULT_SLA_SOFT_MS)',
    reason: 'Soft SLA for community post acknowledgements.',
  },
  {
    name: 'COMMUNITY_ACK_SLA_HARD_MS',
    tier: 'optional',
    default: '172800000 (48h, DEFAULT_SLA_HARD_MS)',
    reason: 'Hard SLA for community post acknowledgements.',
  },
  {
    name: 'MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS',
    tier: 'optional',
    default: '600000 (CLAIM_TTL_FALLBACK_MS)',
    reason: 'Talent marketplace idempotency claim lifetime.',
  },
  {
    name: 'PAIR_CODE_TTL_SECONDS',
    tier: 'optional',
    default: '120 (clamped 30..300)',
    reason: 'Browser-extension pairing code lifetime.',
  },
  {
    name: 'PAIR_REDEEM_PER_MIN',
    tier: 'optional',
    default: '10 (clamped 1..120)',
    reason: 'Pairing-code redeem attempts per minute per IP.',
  },
  {
    name: 'SCOUT_RUN_DEADLINE_MS',
    tier: 'optional',
    default: '300000 (SCOUT_RUN_DEADLINE_MS_DEFAULT)',
    reason: 'Deadline for one Scout import run.',
  },
  {
    name: 'STRIPE_API_TIMEOUT_MS',
    tier: 'optional',
    default: '10000 (values < 1000 fall back)',
    reason: 'Stripe API request timeout.',
  },
  {
    name: 'CHECKOUT_MINT_PER_HOUR',
    tier: 'optional',
    default: '20 (clamped 1..500)',
    reason: 'Throttle: checkout session mints per hour.',
  },
  {
    name: 'STOREFRONT_JOIN_IP_PER_MIN',
    tier: 'optional',
    default: '120 (clamped 1..5000)',
    reason: 'Throttle: storefront join requests per minute per IP.',
  },
  {
    name: 'COMMUNITY_MESSAGES_PER_MIN',
    tier: 'optional',
    default: '30 (clamped 1..1000)',
    reason: 'Throttle: community messages per minute.',
  },
  {
    name: 'COMMUNITY_MSG_EDIT_PER_MIN',
    tier: 'optional',
    default: '10 (clamped 1..1000)',
    reason: 'Throttle: community message edits per minute.',
  },
  {
    name: 'COMMUNITY_POSTS_PER_MIN',
    tier: 'optional',
    default: '5 (clamped 1..1000)',
    reason: 'Throttle: community posts per minute.',
  },
  {
    name: 'COMMUNITY_COMMENTS_PER_MIN',
    tier: 'optional',
    default: '30 (clamped 1..1000)',
    reason: 'Throttle: community comments per minute.',
  },
  {
    name: 'COMMUNITY_DM_PER_MIN',
    tier: 'optional',
    default: '30 (clamped 1..1000)',
    reason: 'Throttle: community DMs per minute.',
  },
  {
    name: 'COMMUNITY_REACTIONS_PER_MIN',
    tier: 'optional',
    default: '60 (clamped 1..1000)',
    reason: 'Throttle: community reactions per minute.',
  },
  {
    name: 'COMMUNITY_REPORTS_PER_5MIN',
    tier: 'optional',
    default: '10 (clamped 1..1000)',
    reason: 'Throttle: community reports per 5 minutes.',
  },
  {
    name: 'COMMUNITY_EVENTS_PER_MIN',
    tier: 'optional',
    default: '20 (clamped 1..1000)',
    reason: 'Throttle: community event creates per minute.',
  },
  {
    name: 'COMMUNITY_EVENT_RSVP_PER_MIN',
    tier: 'optional',
    default: '30 (clamped 1..1000)',
    reason: 'Throttle: community event RSVPs per minute.',
  },
  {
    name: 'COMMUNITY_READS_PER_MIN',
    tier: 'optional',
    default: '60 (clamped 1..1000)',
    reason: 'Throttle: community reads per minute.',
  },
  {
    name: 'TM_ANTIBOT_IP_LIMIT',
    tier: 'optional',
    default: '8 (clamped 1..1000)',
    reason: 'Talent marketplace anti-bot per-IP ceiling.',
  },
  {
    name: 'TM_ANTIBOT_IP_WINDOW_SEC',
    tier: 'optional',
    default: '600 (clamped 30..86400)',
    reason: 'Talent marketplace anti-bot window.',
  },
  {
    name: 'TM_ANTIBOT_IDENTITY_LIMIT',
    tier: 'optional',
    default: '4 (clamped 1..1000)',
    reason: 'Talent marketplace anti-bot per-identity ceiling.',
  },
  {
    name: 'TM_ANTIBOT_DEVICE_FANOUT',
    tier: 'optional',
    default: '3 (clamped 1..1000)',
    reason: 'Talent marketplace anti-bot device fan-out.',
  },
  {
    name: 'TM_ANTIBOT_IDENTITY_IP_FANOUT',
    tier: 'optional',
    default: '5 (clamped 1..1000)',
    reason: 'Talent marketplace anti-bot identity IP fan-out.',
  },
  {
    name: 'TM_ANTIBOT_SIGNAL_TTL_DAYS',
    tier: 'optional',
    default: '30 (clamped 1..365)',
    reason: 'Talent marketplace anti-bot signal retention.',
  },
  // --- SECRETS / CRYPTO ---
  {
    name: 'KMS_MASTER_KEY',
    tier: 'feature',
    default:
      'unset → PLAINTEXT marker in dev; production refuses to persist (and production boot requires it via prodHardenedFeatureVars)',
    reason: '32 raw bytes, base64, for KmsService envelope encryption.',
  },
  {
    name: 'KMS_KEY_ALIAS',
    tier: 'optional',
    default: "'local:v1'",
    reason: 'Key alias recorded alongside KMS ciphertexts.',
  },
  {
    name: 'KMS_KEY_VERSION',
    tier: 'optional',
    default: "'1'",
    reason: 'Key version recorded alongside KMS ciphertexts.',
  },
  {
    name: 'METRICS_AUTH_TOKEN',
    tier: 'feature',
    default: 'unset → /metrics returns 503 in staging/production (open in dev)',
    reason:
      'Bearer token for the Prometheus /metrics endpoint (metrics-auth.guard.ts). Safe by default (fail closed).',
  },
  {
    name: 'MWB_AUTOSAVE_LOCK_TOKEN_SECRET',
    tier: 'optional',
    default: 'none — throws when FEATURE_MWB_AUTOSAVE_UNDO=true and unset',
    reason:
      'HMAC secret for workout-builder autosave lock tokens. Only read when FEATURE_MWB_AUTOSAVE_UNDO is on (default off).',
  },
  {
    name: 'PUBLIC_LISTING_CURSOR_SECRET',
    tier: 'optional',
    default: "'tm3-public-cursor-dev' (warns in production)",
    reason: 'HMAC secret for talent marketplace public listing cursors.',
  },
  {
    name: 'SCHEDULING_WEBHOOK_SECRET',
    tier: 'optional',
    default: 'unset → stub webhook accepts without a secret check (no-op handler)',
    reason:
      'Shared secret for the scheduling webhook stub (scheduling-webhook.controller.ts). The handler performs no state mutation.',
  },
  // --- OBSERVABILITY / RUNTIME ---
  {
    name: 'NODE_ENV',
    tier: 'optional',
    default: 'unset → treated as development',
    reason: 'Runtime environment. Set by the Dockerfile / Fly to production.',
  },
  {
    name: 'PORT',
    tier: 'optional',
    default: "'3000'",
    reason: 'HTTP listen port.',
  },
  {
    name: 'GIT_SHA',
    tier: 'optional',
    default: 'unset → RELEASE_VERSION',
    reason: 'Build commit SHA (image build arg) used for the Sentry release id.',
  },
  {
    name: 'RELEASE_VERSION',
    tier: 'optional',
    default: 'unset → no sha in Sentry release',
    reason: 'Release version (image build arg) used for the Sentry release id.',
  },
  {
    name: 'SENTRY_RELEASE',
    tier: 'optional',
    default: "unset → '<service>@<sha>-<env>'",
    reason: 'Explicit Sentry release override.',
  },
  {
    name: 'LAST_SECURITY_DEPLOY_AT',
    tier: 'optional',
    default: "'2026-04-25T20:00:00Z' (LAST_SECURITY_FLOOR)",
    reason: 'ISO date shown as the last security update on the Trust screen.',
  },
  {
    name: 'ENABLE_API_DOCS',
    tier: 'optional',
    default: 'unset → docs on outside production, off in production (only "true" opts in)',
    reason: 'Exposes the OpenAPI docs when exactly "true".',
  },
  {
    name: 'POSTHOG_HOST',
    tier: 'optional',
    default: "'https://us.i.posthog.com'",
    reason: 'PostHog ingestion host.',
  },
  {
    name: 'FLY_APP_NAME',
    tier: 'optional',
    default: 'unset → SOC2 snapshot omits app/releases',
    reason: 'Fly app name (set by Fly at runtime) for the SOC2 evidence snapshot.',
  },
  {
    name: 'FLY_PRIMARY_REGION',
    tier: 'optional',
    default: 'unset → PRIMARY_REGION',
    reason: 'Fly primary region (set by Fly at runtime) for the SOC2 evidence snapshot.',
  },
  {
    name: 'PRIMARY_REGION',
    tier: 'optional',
    default: 'unset → null',
    reason: 'Fallback primary region for the SOC2 evidence snapshot.',
  },
  {
    name: 'FLY_API_TOKEN',
    tier: 'optional',
    default: 'unset → SOC2 snapshot has no deploy history',
    reason: 'Fly API token for reading release history in the SOC2 evidence snapshot.',
  },
  // --- STRIPE ---
  {
    name: 'STRIPE_CONNECT_REFRESH_URL',
    tier: 'feature',
    default: 'unset → POST /v1/connect/accounts/onboarding-link returns 503',
    reason: 'Stripe Connect onboarding refresh URL.',
  },
  {
    name: 'STRIPE_CONNECT_RETURN_URL',
    tier: 'feature',
    default: 'unset → POST /v1/connect/accounts/onboarding-link returns 503',
    reason: 'Stripe Connect onboarding return URL.',
  },
  {
    name: 'STRIPE_PRICE_GROWTH',
    tier: 'optional',
    default: 'unset → tier resolver has no growth price',
    reason: 'Stripe price id for the Growth team tier.',
  },
  {
    name: 'STRIPE_PRICE_PRO',
    tier: 'optional',
    default: 'unset → tier resolver has no pro price',
    reason: 'Stripe price id for the Pro team tier.',
  },
  {
    name: 'STRIPE_PRICE_ENTERPRISE',
    tier: 'optional',
    default: 'unset → tier resolver has no enterprise price',
    reason: 'Stripe price id for the Enterprise team tier.',
  },
  {
    name: 'STRIPE_PRICE_STAFF_SEAT',
    tier: 'optional',
    default: 'unset → staff seat line item skipped with a warn',
    reason: 'Stripe price id for Pro staff seats.',
  },
  // --- VIDEO / STORAGE ---
  {
    name: 'MUX_TOKEN_ID',
    tier: 'feature',
    default: '\'\' → uploads return "Set MUX_TOKEN_ID and MUX_TOKEN_SECRET"',
    reason: 'Mux API token id for coach video uploads.',
  },
  {
    name: 'MUX_TOKEN_SECRET',
    tier: 'feature',
    default: '\'\' → uploads return "Set MUX_TOKEN_ID and MUX_TOKEN_SECRET"',
    reason: 'Mux API token secret for coach video uploads.',
  },
  {
    name: 'MUX_WEBHOOK_SECRET',
    tier: 'feature',
    default: 'unset → Mux webhooks cannot be verified',
    reason: 'Mux webhook signing secret.',
  },
  {
    name: 'MUX_SIGNING_KEY_ID',
    tier: 'optional',
    default: 'unset → signed playback unavailable',
    reason: 'Mux signed-playback key id.',
  },
  {
    name: 'MUX_SIGNING_KEY_PRIVATE',
    tier: 'optional',
    default: 'unset → signed playback unavailable',
    reason: 'Mux signed-playback private key (PEM or base64 PEM).',
  },
  {
    name: 'SUPABASE_MEDIA_BUCKET',
    tier: 'optional',
    default: "'coach-media'",
    reason: 'Supabase storage bucket for coach media.',
  },
  // --- SCHEDULING / CALENDAR (calendar sync off for launch) ---
  {
    name: 'GOOGLE_OAUTH_CLIENT_ID',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → Google Calendar connect returns "not configured"',
    reason:
      'Google Calendar OAuth client id (scheduling). Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_OAUTH_CLIENT_SECRET',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → Google Calendar connect returns "not configured"',
    reason:
      'Google Calendar OAuth client secret. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_OAUTH_REDIRECT_URI',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → Google Calendar connect returns "not configured"',
    reason:
      'Google Calendar OAuth redirect URI (https://backend-spring-lake-3890.fly.dev/api/scheduling/auth/google/callback). Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_OAUTH_SCOPES',
    tier: 'optional',
    launch: 'optional-integration',
    default: "'https://www.googleapis.com/auth/calendar.events'",
    reason:
      'Comma-separated Google Calendar OAuth scopes. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'FEATURE_GOOGLE_CALENDAR_SYNC',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → off (only "true" enables)',
    reason:
      'Google Calendar sync flag; webhook and OAuth routes 404/refuse while off. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_CALENDAR_ENABLED',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → stub adapter (only "true" enables)',
    reason:
      'Google Calendar scheduling provider. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → watch channels off',
    reason:
      'Google Calendar push watch channels. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → watch channels misconfigured if enabled',
    reason:
      'Public base URL Google pushes calendar notifications to. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_CALENDAR_WEBHOOK_TOKEN',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → calendar webhook rejects every push',
    reason:
      'Channel token checked on Google Calendar webhook pushes. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'GOOGLE_MEET_ENABLED',
    tier: 'optional',
    launch: 'optional-integration',
    default: 'unset → stub adapter (only "true" enables)',
    reason:
      'Google Meet scheduling provider. Optional integration, not a launch dependency (owner 2026-10-01): TGP native scheduling is the product. Leave unset or explicitly false; existing shared-placeholder Fly values are cleanup candidates, not values to fill.',
  },
  {
    name: 'ZOOM_ENABLED',
    tier: 'optional',
    default: 'unset → stub adapter (only "true" enables)',
    reason: 'Not used in v1 / Zoom scheduling provider is not part of the launch.',
  },
  // --- CONTRACTS (not used in v1) ---
  {
    name: 'CONTRACT_PDF_BUCKET',
    tier: 'optional',
    default: 'unset → DATA_EXPORT_BUCKET, else local disk',
    reason:
      'Not used in v1 / contracts (Dropbox Sign) are not part of the launch. Bucket for signed contract PDFs.',
  },
  {
    name: 'CONTRACT_PDF_URL_SECRET',
    tier: 'optional',
    default:
      'unset → DATA_EXPORT_DOWNLOAD_SECRET → JWT_SECRET; all unset throws when minting a PDF URL',
    reason:
      'Not used in v1 / contracts are not part of the launch. HMAC key for signed contract PDF URLs.',
  },
  {
    name: 'HELLOSIGN_API_KEY',
    tier: 'optional',
    default: 'unset → HelloSign provider unavailable',
    reason: 'Not used in v1 / HelloSign (Dropbox Sign) contracts are not part of the launch.',
  },
  {
    name: 'HELLOSIGN_CLIENT_ID',
    tier: 'optional',
    default: 'unset → embedded signing unavailable',
    reason: 'Not used in v1 / HelloSign (Dropbox Sign) contracts are not part of the launch.',
  },
  {
    name: 'HELLOSIGN_TEST_MODE',
    tier: 'optional',
    default: 'unset → test mode off (only "true" enables)',
    reason: 'Not used in v1 / HelloSign (Dropbox Sign) contracts are not part of the launch.',
  },
  {
    name: 'FEATURE_CONTRACTS_ENABLED',
    tier: 'optional',
    default: 'unset → on in development/test, off otherwise',
    reason: 'Not used in v1 / contracts module flag.',
  },
  {
    name: 'FEATURE_CONTRACTS_DOCUSIGN_PROVIDER',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Not used in v1 / DocuSign contracts provider flag.',
  },
  {
    name: 'FEATURE_CONTRACTS_NATIVE_CANVAS',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Not used in v1 / native signature canvas flag.',
  },
  // --- FEATURE FLAGS ---
  {
    name: 'FEATURE_BANK_PAYOUTS_V2',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Bank payouts v2 flag.',
  },
  {
    name: 'FEATURE_STRIPE_TREASURY_PAYOUTS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Stripe Treasury payouts flag.',
  },
  {
    name: 'FEATURE_DUNNING_V2',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Dunning v2 flag.',
  },
  {
    name: 'FEATURE_COMMUNITY_SCHEMA',
    tier: 'optional',
    default: 'unset → on (only "false" disables)',
    reason: 'Community schema presence flag; downstream community mounts back off when "false".',
  },
  {
    name: 'FEATURE_COMMUNITY_API',
    tier: 'optional',
    default: 'unset → off (only "true"; FEATURE_COMMUNITY_API_ALLOWLIST can open it per user)',
    reason: 'Community API master flag. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_API_ALLOWLIST',
    tier: 'optional',
    default: "'' → no allow-listed users",
    reason:
      'Comma-separated user ids that see the community API while FEATURE_COMMUNITY_API is off.',
  },
  {
    name: 'FEATURE_COMMUNITY_MESSAGES',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community message writes. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_POSTS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community post writes. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_DM',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community DMs. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_PUSH',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community push notifications. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_REALTIME',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community realtime. Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_TELEMETRY',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community telemetry (no user text). Set at the Wave-1 launch deploy.',
  },
  {
    name: 'FEATURE_COMMUNITY_PLAN_TAGS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community plan-context tags.',
  },
  {
    name: 'FEATURE_COMMUNITY_ACKS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community acknowledgements.',
  },
  {
    name: 'FEATURE_COMMUNITY_AI_TRIAGE',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community AI triage.',
  },
  {
    name: 'FEATURE_COMMUNITY_CHALLENGES',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community challenges.',
  },
  {
    name: 'FEATURE_COMMUNITY_CLASSROOM_POSTS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community classroom posts.',
  },
  {
    name: 'FEATURE_COMMUNITY_EVENTS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community events.',
  },
  {
    name: 'FEATURE_COMMUNITY_SEARCH',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community search.',
  },
  {
    name: 'FEATURE_COMMUNITY_VOICE_NOTES',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community voice notes.',
  },
  {
    name: 'FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Require an entitlement for community voice notes.',
  },
  {
    name: 'FEATURE_COMMUNITY_WEARABLE_PROMPTS',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Community wearable prompts.',
  },
  {
    name: 'FEATURE_MWB_AI_LIVE_CREATE',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Workout builder AI live-create capabilities.',
  },
  {
    name: 'FEATURE_MWB_AUTOSAVE_UNDO',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Workout builder autosave + undo (needs MWB_AUTOSAVE_LOCK_TOKEN_SECRET when on).',
  },
  {
    name: 'FEATURE_MWB_TEMPLATES',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Workout builder templates.',
  },
  {
    name: 'FEATURE_NAMED_REGIMES',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Named regimes.',
  },
  {
    name: 'FEATURE_ROMAN_CHAT_ENABLED',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Live Roman chat. Off in v1.0 (owner decision D1: scripted Roman only).',
  },
  {
    name: 'FEATURE_ROMAN_COACH_REVIEWED_AT',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Roman coach-reviewed timestamp surface.',
  },
  {
    name: 'FEATURE_ROMAN_COPY_V2',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Roman voice copy v2.',
  },
  {
    name: 'FEATURE_ROMAN_FIRST_PAYMENT',
    tier: 'optional',
    default: 'unset → off (only "true")',
    reason: 'Roman first-payment moment on checkout webhook.',
  },
  {
    name: 'FEATURE_ROMAN_THREE_ARC_COUNTS',
    tier: 'optional',
    default: 'unset → off (only explicit true)',
    reason: 'Coach home three-arc counts.',
  },
  {
    name: 'FEATURE_SCOUT_INGEST',
    tier: 'optional',
    default: 'unset → /api/scout routes 404 (only "true")',
    reason: 'Scout ingest routes (feature-flag-not-found middleware).',
  },
  {
    name: 'FEATURE_SCOUT_RECONSTRUCT',
    tier: 'optional',
    default: 'unset → /api/scout/reconstruct 404 (only "true")',
    reason: 'Scout reconstruct route.',
  },
  {
    name: 'FEATURE_SCOUT_PILOT_COACH_IDS',
    tier: 'optional',
    default: 'unset → no pilot coaches',
    reason: 'Comma-separated pilot coach ids allowed through Scout gates.',
  },
  {
    name: 'FEATURE_EXTENSION_PAIRING',
    tier: 'optional',
    default: 'unset → /api/extension/pair 404 (only "true")',
    reason: 'Browser-extension pairing routes.',
  },
  {
    name: 'FEATURE_WEARABLES_INGEST_POST',
    tier: 'optional',
    default: 'unset → POST wearable samples returns disabled (only "true")',
    reason: 'Wearable samples ingest endpoint. Set at the launch deploy.',
  },
  // --- CLOUD WEARABLES (not used in v1: Apple Health / Health Connect are live and need no server key) ---
  {
    name: 'FEATURE_WEARABLES_CLOUD_CONNECTORS',
    tier: 'optional',
    default: 'unset → off; OAuth start and the eight webhooks return 503',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Master flag for cloud wearable connectors.',
  },
  {
    name: 'WEARABLES_OAUTH_REDIRECT_BASE_URL',
    tier: 'optional',
    default: 'unset → cloud wearable connect throws "not configured"',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Base URL for cloud wearable OAuth redirects.',
  },
  {
    name: 'FITBIT_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Fitbit cloud connector OAuth client id.',
  },
  {
    name: 'FITBIT_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Fitbit cloud connector OAuth client secret.',
  },
  {
    name: 'FITBIT_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Fitbit cloud connector OAuth redirect URI.',
  },
  {
    name: 'FITBIT_VERIFICATION_CODE',
    tier: 'optional',
    default: 'unset → subscriber verification rejected',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Fitbit cloud connector webhook subscriber verification code.',
  },
  {
    name: 'GARMIN_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Garmin cloud connector OAuth client id.',
  },
  {
    name: 'GARMIN_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Garmin cloud connector OAuth client secret.',
  },
  {
    name: 'GARMIN_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Garmin cloud connector OAuth redirect URI.',
  },
  {
    name: 'GARMIN_PUSH_TOKEN',
    tier: 'optional',
    default: "'' → every push treated as untrusted (fail closed)",
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Garmin cloud connector push verification token.',
  },
  {
    name: 'GARMIN_WEBHOOK_SALT',
    tier: 'optional',
    default: 'unset → falls back to the provider push token / webhook secret / client secret',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Garmin cloud connector salt for hashing provider user ids in webhook logs.',
  },
  {
    name: 'OURA_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Oura cloud connector OAuth client id.',
  },
  {
    name: 'OURA_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Oura cloud connector OAuth client secret.',
  },
  {
    name: 'OURA_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Oura cloud connector OAuth redirect URI.',
  },
  {
    name: 'OURA_VERIFICATION_TOKEN',
    tier: 'optional',
    default: 'unset → webhook verification challenge rejected',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Oura cloud connector webhook verification token.',
  },
  {
    name: 'POLAR_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Polar cloud connector OAuth client id.',
  },
  {
    name: 'POLAR_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Polar cloud connector OAuth client secret.',
  },
  {
    name: 'POLAR_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Polar cloud connector OAuth redirect URI.',
  },
  {
    name: 'POLAR_WEBHOOK_SECRET',
    tier: 'optional',
    default: 'unset → webhook verification fails closed (Wahoo/WHOOP fall back to CLIENT_SECRET)',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Polar cloud connector webhook signing secret.',
  },
  {
    name: 'STRAVA_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector OAuth client id.',
  },
  {
    name: 'STRAVA_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector OAuth client secret.',
  },
  {
    name: 'STRAVA_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector OAuth redirect URI.',
  },
  {
    name: 'STRAVA_WEBHOOK_ALLOWED_IPS',
    tier: 'optional',
    default: 'unset → no IP allow-list check',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector comma-separated webhook source IP allow-list.',
  },
  {
    name: 'STRAVA_WEBHOOK_SUBSCRIPTION_ID',
    tier: 'optional',
    default: 'unset → webhook events rejected ("subscription id unset")',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector push subscription id.',
  },
  {
    name: 'STRAVA_WEBHOOK_VERIFY_TOKEN',
    tier: 'optional',
    default: 'unset → subscription validation rejected',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Strava cloud connector subscription verify token.',
  },
  {
    name: 'WAHOO_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Wahoo cloud connector OAuth client id.',
  },
  {
    name: 'WAHOO_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Wahoo cloud connector OAuth client secret.',
  },
  {
    name: 'WAHOO_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Wahoo cloud connector OAuth redirect URI.',
  },
  {
    name: 'WAHOO_WEBHOOK_SECRET',
    tier: 'optional',
    default: 'unset → webhook verification fails closed (Wahoo/WHOOP fall back to CLIENT_SECRET)',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Wahoo cloud connector webhook signing secret.',
  },
  {
    name: 'WAHOO_WEBHOOK_TOKEN',
    tier: 'optional',
    default: 'unset → webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Wahoo cloud connector webhook token.',
  },
  {
    name: 'WHOOP_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. WHOOP cloud connector OAuth client id.',
  },
  {
    name: 'WHOOP_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. WHOOP cloud connector OAuth client secret.',
  },
  {
    name: 'WHOOP_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. WHOOP cloud connector OAuth redirect URI.',
  },
  {
    name: 'WHOOP_WEBHOOK_SALT',
    tier: 'optional',
    default: 'unset → falls back to the provider push token / webhook secret / client secret',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. WHOOP cloud connector salt for hashing provider user ids in webhook logs.',
  },
  {
    name: 'WHOOP_WEBHOOK_SECRET',
    tier: 'optional',
    default: 'unset → webhook verification fails closed (Wahoo/WHOOP fall back to CLIENT_SECRET)',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. WHOOP cloud connector webhook signing secret.',
  },
  {
    name: 'WITHINGS_CLIENT_ID',
    tier: 'optional',
    default: 'unset → requireEnv throws "required env var … is not set" on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Withings cloud connector OAuth client id.',
  },
  {
    name: 'WITHINGS_CLIENT_SECRET',
    tier: 'optional',
    default: 'unset → token exchange throws; webhook verification fails closed',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Withings cloud connector OAuth client secret.',
  },
  {
    name: 'WITHINGS_REDIRECT_URI',
    tier: 'optional',
    default: 'unset → requireEnv throws on OAuth start',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Withings cloud connector OAuth redirect URI.',
  },
  {
    name: 'WITHINGS_VERIFICATION_TOKEN',
    tier: 'optional',
    default: 'unset → webhook verification challenge rejected',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Withings cloud connector webhook verification token.',
  },
  {
    name: 'WITHINGS_WEBHOOK_SECRET',
    tier: 'optional',
    default: 'unset → webhook verification fails closed (Wahoo/WHOOP fall back to CLIENT_SECRET)',
    reason:
      'Not used in v1 / alternative provider Apple Health + Health Connect (on-device) is live. Withings cloud connector webhook signing secret.',
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
    // Each entry asserts the var is present in prod. An optional `minLength`
    // also asserts the trimmed value is at least N chars long — use this for
    // secrets where a too-short value would degrade silently at runtime (the
    // service no-ops or falls back to a dev default) rather than fail loudly.
    // Entries without `minLength` keep the original presence-only semantics.
    const prodHardenedFeatureVars: Array<{
      name: string;
      reason: string;
      minLength?: number;
    }> = [
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
      {
        name: 'STRIPE_PUBLISHABLE_KEY',
        reason:
          'Audit #5 P0-2 — StorefrontService.getPublicPackageByToken returns 503 SERVICE_UNAVAILABLE on every public package request when STRIPE_PUBLISHABLE_KEY is unset. A clean prod deploy without it passes boot then silently 503s the entire storefront. Must be the publishable counterpart (pk_test_*/pk_live_*) of STRIPE_SECRET_KEY.',
      },
      {
        name: 'KMS_MASTER_KEY',
        reason:
          'Audit #6 P0-4 — KmsService.encrypt() falls back to a PLAINTEXT: marker prefix when KMS_MASTER_KEY is unset, persisting CRM api_token / api_key / webhook secret values in cleartext. Production must NEVER persist plaintext credentials. Must be 32 raw bytes, base64-encoded.',
      },
      {
        name: 'LANDING_VIEW_HASH_SECRET',
        reason:
          'Audit #6 P1-2 — LandingPagesPublicService.dailySalt() falls back to the hard-coded "landing-views-daily-salt" constant when unset, making the per-visitor hash predictable and trivially re-identifiable. Production must set an unpredictable secret.',
      },
      {
        name: 'CHECKOUT_RECOVERY_SECRET',
        minLength: MIN_CHECKOUT_RECOVERY_SECRET_LENGTH,
        reason:
          'r48 / audit A276-P1-1 + A276-F3-P2-1 — signs the 15-minute checkout recovery JWT AND the 7-day guest session cookie. MUST be ≥43 chars (RFC 7518 §3.2: HS256 keys carry ≥256 bits of entropy = 32 random bytes = 43 base64url chars); boot refuses to start prod when missing or too short because the cookie path silently no-ops on weak/missing secret (failure #36).',
      },
      // Stream 1 — Coach AI Credits. Production refuses to boot without
      // these because a missing value would silently fall back to the
      // dev defaults (4000 / 3.125) which we never want to ship under a
      // typo or env-var rename in fly.toml.
      {
        name: 'COACH_AI_MAX_ACTUAL_CENTS',
        reason:
          'Stream 1 — hard ceiling on Anthropic spend per coach per period in cents. A missing value falls back to the locked 4000 ($40) default, which is correct but only by accident. We refuse to boot prod without an explicit value so a future change is visible in the deploy diff. Refs: STREAM_1_AI_CREDITS_SPEC.md §0.',
      },
      {
        name: 'COACH_AI_VALUE_MULTIPLIER',
        reason:
          'Stream 1 — value multiplier (displayed = actual * multiplier). Locked at 3.125 per operator override 2026-05-28. Missing falls back to the dev constant; production requires an explicit value so an env-var typo doesn\'t silently revert to a stale number. Refs: STREAM_1_AI_CREDITS_SPEC.md §0.',
      },
    ];
    // Audit A276-F3-P3-4 — distinguish "missing" (var unset / blank) from
    // "too short" (var IS set but fails the minLength entropy floor). An
    // on-call operator who greps `process.env` for the var name should
    // not see "is missing" when the var is in fact present in the env
    // file. Two segments → two clearer 3am-pager messages.
    const missing: Array<{ name: string; reason: string }> = [];
    const tooShort: Array<{
      name: string;
      reason: string;
      minLength: number;
      actualLength: number;
    }> = [];
    for (const v of prodHardenedFeatureVars) {
      // ANDROID_CERT_SHA256_FINGERPRINTS accepts a comma/whitespace
      // separated list; ANDROID_SHA256_FINGERPRINT is an accepted
      // single-value alias. Either env var being set counts.
      if (v.name === 'ANDROID_CERT_SHA256_FINGERPRINTS') {
        const a = env.ANDROID_CERT_SHA256_FINGERPRINTS;
        const b = env.ANDROID_SHA256_FINGERPRINT;
        const ok =
          (typeof a === 'string' && a.trim().length > 0) ||
          (typeof b === 'string' && b.trim().length > 0);
        if (!ok) missing.push({ name: v.name, reason: v.reason });
        continue;
      }
      const raw = env[v.name];
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        missing.push({ name: v.name, reason: v.reason });
        continue;
      }
      // Audit A276-P1-1 / A276-F3-P2-1 — entries may opt into a
      // minimum-length gate so a too-short secret (which would silently
      // no-op at runtime in at least one consumer) is rejected at boot.
      // Presence-only entries (no minLength) keep their original
      // behaviour: any non-empty trimmed value passes here.
      if (
        typeof v.minLength === 'number' &&
        raw.trim().length < v.minLength
      ) {
        tooShort.push({
          name: v.name,
          reason: v.reason,
          minLength: v.minLength,
          actualLength: raw.trim().length,
        });
      }
    }
    // Audit #5 P1-7 — aggregate every prod-side blocker discovered so far
    // (prod-hardened missing + missingProd + placeholderProd +
    // validationErrorsProd) into a SINGLE thrown error rather than throwing
    // on the first one and forcing the operator into a deploy-fix-deploy
    // cycle. The hard-tier missing/placeholder checks above already ran
    // and exited before we reached this block, so we know the operator
    // has at least cleared those.
    //
    // Each contributing class still has its own stable code surfaced via
    // the EnvValidationError.variables[] / message so observability can
    // distinguish them; the combined error uses ENV_PROD_BLOCKERS.
    //
    // The aggregation respects enforceProd: when an operator/test
    // explicitly opts into enforceProd=false (e.g. a soak test with
    // deliberately broken secrets) we DO NOT throw on the prod-tier
    // missing / placeholder / validator failures here — they fall
    // through to the warn-only branches below. The prod-hardened
    // "missing" class still throws regardless because those vars cover
    // routing/CORS defaults that would silently misroute traffic.
    const prodBlockerSegments: string[] = [];
    const prodBlockerVars: string[] = [];
    if (missing.length) {
      // NOTE: "URL config" wording is retained for back-compat with existing
      // test patterns and dashboard alerts; P3-3 (rewording) is tracked
      // separately. The new too-short segment below uses clearer wording.
      prodBlockerSegments.push(
        `Production-required URL config is missing: ` +
          missing.map((v) => `${v.name} (${v.reason})`).join('; '),
      );
      prodBlockerVars.push(...missing.map((v) => v.name));
    }
    if (tooShort.length) {
      prodBlockerSegments.push(
        `Production-required env config is set but too short: ` +
          tooShort
            .map(
              (v) =>
                `${v.name} is ${v.actualLength} chars (need ≥${v.minLength}) — ${v.reason}`,
            )
            .join('; '),
      );
      prodBlockerVars.push(...tooShort.map((v) => v.name));
    }
    if (enforceProd && result.missingProd.length) {
      prodBlockerSegments.push(
        `Missing production-required env vars (NODE_ENV=${env.NODE_ENV}): ${result.missingProd.join(', ')}`,
      );
      prodBlockerVars.push(...result.missingProd);
    }
    if (enforceProd && result.placeholderProd.length) {
      prodBlockerSegments.push(
        `Production-tier env vars contain placeholder values (NODE_ENV=${env.NODE_ENV}): ${result.placeholderProd.join(', ')}`,
      );
      prodBlockerVars.push(...result.placeholderProd);
    }
    if (enforceProd && result.validationErrorsProd.length) {
      prodBlockerSegments.push(
        `Production-tier env vars failed validation (NODE_ENV=${env.NODE_ENV}): ${result.validationErrorsProd.join('; ')}`,
      );
    }
    if (prodBlockerSegments.length > 0) {
      // Preserve the single-cause error code (and message-prefix the
      // existing test patterns match against) when there is exactly one
      // class of blocker — old assertions like `.toThrow(/Production-required URL config is missing/)`
      // keep passing. The combined-throw is only used when multiple
      // classes of blocker would otherwise force a redeploy cycle.
      if (prodBlockerSegments.length === 1) {
        const seg = prodBlockerSegments[0];
        logger.error(seg);
        // Map the segment back to its original code for back-compat.
        const code: 'ENV_PROD_HARDENED_MISSING' | 'ENV_PROD_HARDENED_TOO_SHORT' | 'ENV_MISSING_PROD' | 'ENV_PLACEHOLDER_PROD' | 'ENV_VALIDATION_PROD' =
          missing.length ? 'ENV_PROD_HARDENED_MISSING'
          : tooShort.length ? 'ENV_PROD_HARDENED_TOO_SHORT'
          : result.missingProd.length ? 'ENV_MISSING_PROD'
          : result.placeholderProd.length ? 'ENV_PLACEHOLDER_PROD'
          : 'ENV_VALIDATION_PROD';
        throw new EnvValidationError(seg, {
          code,
          variables: prodBlockerVars,
        });
      }
      // Multiple classes — combine into one report so the operator fixes
      // them all in a single redeploy. The code switches to ENV_PROD_BLOCKERS
      // so observability dashboards can branch.
      const combined =
        `Production env validation found multiple blockers (NODE_ENV=${env.NODE_ENV}) — fix all before redeploy:\n  • ` +
        prodBlockerSegments.join('\n  • ');
      logger.error(combined);
      throw new EnvValidationError(combined, {
        code: 'ENV_PROD_BLOCKERS',
        variables: prodBlockerVars,
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
      // Already handled by the aggregated block above. This branch only
      // fires when enforceProd is explicitly true while NODE_ENV is not
      // production (an edge case used by some test paths).
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
