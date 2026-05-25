# SPEC — TGP Storefront Phase 1 (R43)

Status: Implemented. Last updated 2026-05-25 (Fix Round 3 of PR #267).
Owner: Backend platform.

This spec is the contract that the PR #267 implementation, the audit
documents under `/home/user/workspace/agent-context/`, and the test
suites are checked against. If you change a behaviour in code, change
this document in the same PR.

## 1. Goals

Phase 1 of the TGP Storefront lets a coach share a single short URL that
opens a branded checkout page on `joingrowthproject.com`. A new client
can pay with card, receive an account-activation email, and arrive in
the mobile app with their package already entitled — without ever
seeing an "external" provider or being asked to set a password before
they pay.

Phase 2 (NOT in scope): subscription packages, per-currency floors,
multiple-package bundling, applepay/googlepay surfaces, Stripe Tax for
non-US states, refund self-service.

## 2. Endpoint contracts

### POST /api/v1/coach/packages/:id/share-link
Auth: `JwtAuthGuard + RolesGuard + CoachGuard`, `@Roles('coach')`.
Body: empty.
200 response:
```json
{
  "share_token": "<21-char nanoid-alphabet token>",
  "share_url": "https://joingrowthproject.com/join/<token>",
  "share_link_enabled": true,
  "share_link_generated_at": "2026-05-25T07:00:00.000Z"
}
```
Errors:
- 401 — not authenticated.
- 403 — authenticated user is not a coach.
- 404 `PACKAGE_NOT_FOUND` — `:id` is missing, archived, or owned by
  another coach. Tenant-scoped read inside the service (P2-2) means
  the response is identical for missing vs. cross-tenant rows.
- 503 `SHARE_LINK_UNAVAILABLE` — five consecutive token collisions on
  the unique index. The caller may retry.

Idempotency: the route is naturally idempotent. The first call mints
a token via `updateMany WHERE share_token IS NULL`; every subsequent
call returns the same token. The R39 header ledger is not required;
the controller carries a `// IDEMPOTENCY: R39 exception approved`
note.

### GET /api/v1/packages/public/join/:token
Auth: `@Public()`. Throttled 60 req / min / IP.
`:token` is validated by `ShareTokenPipe` against
`^[A-Za-z0-9_-]{21}$` BEFORE Prisma is touched (P1-3, P2-1). Tokens
that don't match are 404 with the same body shape as a missing token.

200 response: the storefront SSR payload (`PublicPackageData`) —
package metadata, coach display fields, billing cycle label, and the
PLATFORM (not connected-account) publishable key.

Errors:
- 404 `TOKEN_NOT_FOUND` — malformed token, missing/archived/inactive
  package, or `share_link_enabled = false`. Single 404 surface so the
  storefront cannot be probed for valid-but-paused tokens.
- 404 `PACKAGE_UNAVAILABLE` — the coach's connected account is not
  ready (see §4). Generic message; the failing axis is logged
  server-side only.
- 503 `STRIPE_UNAVAILABLE` — `STRIPE_PUBLISHABLE_KEY` unset.

### POST /api/v1/packages/public/join/:token/checkout
Auth: `@Public()`. Throttled 20 req / min / IP.
`:token` validated the same way as the GET above.
Body (`GuestCheckoutDto`):
```json
{
  "guest_email": "jane@example.com",
  "guest_name": "Jane Smith",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000"
}
```
200 response:
```json
{
  "client_secret": "pi_..._secret_...",
  "payment_intent_id": "pi_...",
  "guest_checkout_id": "<GuestCheckout.id>"
}
```
Errors:
- 404 — token / package / connected-account gate fails (same surface
  as GET).
- 422 `RECURRING_NOT_SUPPORTED` — `billing_type === 'recurring'`
  (canonical schema value, P1-5). Display labels in the `interval`
  column are NOT load-bearing.
- 422 `CURRENCY_NOT_SUPPORTED` — `pkg.currency != 'usd'` (P2-6).
  Phase 1 is USD-only; per-currency floors are Phase 2.
- 503 `STRIPE_UNAVAILABLE` — Stripe rejected the PaymentIntent
  request or the idempotency-key race left a stale `pending_<key>`
  sentinel.

Idempotency: client-supplied `idempotency_key` (UUID v4). The fast
path reads any existing `GuestCheckout` with that key and replays the
live Stripe client secret. A second call with the same key that lands
mid-creation hits the @unique constraint, catches P2002, and falls
into the replay path. Server-side `Idempotency-Key` on the outgoing
Stripe call uses `guest-checkout-pi-<idempotency_key>` so Stripe also
collapses retries.

## 3. GuestCheckout state machine (P1-6, P1-7)

```
              POST /checkout              webhook:succeeded
   (empty) ─────────────────▶  pending  ──────────────────▶  paid
                                  │                            │
                  webhook:failed  │                            │ convert OK
                                  ▼                            ▼
                               failed                       converted
                                                                ▲
                  convert failure (Supabase/DB)                 │ reconcile retry
                              │                                 │
                              ▼                                 │
                  conversion_failed_retryable  ───────────────────
                              │
              ≥ 5 retries     │
                              ▼
                  conversion_failed_terminal
```

States:
- `pending` — sentinel row exists; Stripe PaymentIntent created.
  Webhook handlers refuse to fulfil rows past `expires_at` (24 h
  after create).
- `paid` — webhook flipped the row from `pending`; inline conversion
  is about to run. If the handler crashes before conversion finishes,
  the reconciliation worker scans `paid` rows with `created_user_id =
  NULL` past a 2 min grace window and re-enters convert (P1-7).
- `converted` — User + ClientPurchase exist; welcome mail sent. The
  retention-scrub worker leaves converted rows alone because the
  User record owns the identity data.
- `failed` — pre-payment failure path (Stripe rejected the PI). NOT
  reachable from `paid`.
- `conversion_failed_retryable` — Supabase or DB transaction failed
  after Stripe took the money. `retry_count`, `last_error`, and
  `last_retry_at` track attempts. The cron-driven
  `GuestCheckoutReconciliationService` re-enters convert with a 60 s
  per-row backoff.
- `conversion_failed_terminal` — `retry_count >= 5`. Operator
  dashboard pages on-call via the structured log line.

`StripeProcessedEvent` carries `processed_at` (immediate) AND
`handler_completed_at` (set only after the handler returned without
throwing). Reconciliation uses the latter to detect "Stripe
acknowledged, fulfillment never finished" cases that Stripe replays
would otherwise short-circuit.

## 4. Connected-account readiness gate (P1-8)

Public package GET and checkout POST share one predicate
(`isConnectAccountReadyForCheckout`). All four conditions must hold:
1. `charges_enabled === true`
2. `payouts_enabled === true`
3. `details_submitted === true`
4. `disabled_reason === null` (or unset)

Failure is a generic 404 `PACKAGE_UNAVAILABLE` to the public; the
exact failing axis is logged server-side only — no enumeration leak.
The "verified" badge in the GET payload mirrors the gate so it can't
lie about a coach who passed.

## 5. Stripe destination charges (P1-10)

Every PaymentIntent created for a marketplace flow (guest checkout
AND the in-app Payment Sheet) sets both:
- `transfer_data[destination] = connectAccount.stripe_account_id`
- `on_behalf_of = connectAccount.stripe_account_id`

`on_behalf_of` makes the connected coach the merchant of record for
risk treatment and statement-descriptor purposes — matching Stripe's
documented destination-charge marketplace pattern. The Phase 7 +
Phase 1 storefront flows both go through the same
`StripeConnectApiService.createPaymentIntent` so the contract is
enforced once.

Stripe metadata carries only non-PII correlation identifiers (P2-4):
`guest_checkout_idempotency_key`, `package_id`, `guest_checkout_id`.
`guest_email` and `guest_name` are explicitly NOT sent — server-side
joins via `guest_checkout_id` cover the analytics use case.

## 6. Platform fee (P2-5)

`platform_fee_cents = min(amount_cents, max(floor(amount * 0.02), 50))`

- Floor: 50¢ (Stripe's minimum application fee).
- Ceiling: `amount_cents` so a sub-floor charge (e.g. 40¢) never
  carries a fee bigger than the charge.
- Currency is USD-only (P2-6); per-currency floors are Phase 2.

## 7. Supabase auth flow (P1-9)

New buyers:
1. `auth.admin.createUser({ email, email_confirm: false })` — NO
   password, NO auto-confirm.
2. `auth.admin.generateLink({ type: 'invite', email })` — returns a
   one-time activation URL.
3. Resend welcome mail with the invite URL. NEVER a password.

Existing buyers (e.g. previous TGP customer paying for a new
package):
1. `listUsers` lookup finds the existing user.
2. Welcome mail renders the "sign in with your usual credentials"
   branch — no invite link, no password.

The previous flow generated a 24-char temp password, set
`email_confirm: true`, and emailed the password. That turned mailbox
access into account access — explicitly rejected by P1-9.

From-address: `RESEND_FROM_EMAIL`, production-required. Dev/test
fallback is `TGP Fitness <welcome@trygrowthproject.com>`.

## 8. Share-token format (P1-3, P2-1)

- 21 characters from the nanoid alphabet `[A-Za-z0-9_-]`.
- ≈126 bits of entropy.
- Generated via `crypto.randomBytes` with masking.
- Regex `^[A-Za-z0-9_-]{21}$` enforced at the controller (pipe) AND
  the service (defence-in-depth). Malformed tokens never reach
  Prisma.
- The legacy-token migration
  (`20260803000000_share_token_21char_invalidate_legacy`) clears
  `share_token` and sets `share_link_enabled = false` for any row
  whose token does not match the regex. Coaches re-mint on the next
  POST.

## 9. PII retention (P2-3)

`GuestCheckout` rows carry `data_retention_at = created_at + 13
months`. The cron `GuestCheckoutPiiScrubService` runs daily at 03:17
UTC and walks rows past their retention deadline with
`scrubbed_at IS NULL AND created_user_id IS NULL`:
- `guest_email := 'sha256:' + sha256(lower(email) || salt)`.
- `guest_name := 'REDACTED'`.
- `scrubbed_at := now()`.

Salt comes from `GUEST_CHECKOUT_PII_SALT` (optional; dev fallback is
a build-time constant). Converted rows have a `User` record that
owns the same identity data with its own retention rules, so the
scrub job intentionally skips them.

## 10. AASA / assetlinks (P1-11)

In production / staging, `APPLE_TEAM_ID` and
`ANDROID_CERT_SHA256_FINGERPRINTS` (or its
`ANDROID_SHA256_FINGERPRINT` alias) are required at boot —
`assertEnv()` throws `EnvValidationError` on missing values. The
controller itself throws 500 if it somehow runs without them under
prod, rather than serving an empty stub that teaches iOS/Android
that no association exists.

In dev/test, the controller logs a warning and serves a stub so
contributors can run `npm run start:dev` without Apple/Android
credentials.

## 11. Production-required env vars

Enforced by `prodHardenedFeatureVars` in `src/common/env-validation.ts`:
- `PUBLIC_INVITE_BASE_URL`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`
- `ANTHROPIC_API_KEY`
- `STOREFRONT_BASE_URL`
- `RESEND_FROM_EMAIL`
- `APPLE_TEAM_ID`
- `ANDROID_CERT_SHA256_FINGERPRINTS` (or `ANDROID_SHA256_FINGERPRINT`)

All raw `throw new Error(...)` is banned. Bootstrap-path failures
throw `BootstrapValidationError` (CORS wildcard, malformed
`STOREFRONT_BASE_URL`); env-validation failures throw
`EnvValidationError`; guest-conversion failures throw
`GuestConversionError` subclasses (`SupabaseTimeoutError`,
`SupabaseExistingUserNotFoundError`, `SupabaseCreateUserError`).

## 12. Migrations

In numeric order:
- `20260801000000_r43_storefront_phase1` — initial CoachPackage
  columns + GuestCheckout table + RLS deny-all + status CHECK.
- `20260803000000_share_token_21char_invalidate_legacy` — data-only
  clear of pre-21-char tokens.
- `20260804000000_guest_checkout_retryable_conversion` — retry
  bookkeeping columns + expanded CHECK constraint +
  `StripeProcessedEvent.handler_completed_at`.
- `20260805000000_guest_checkout_pii_retention` —
  `data_retention_at` + `scrubbed_at` + composite index + backfill.

Every migration carries an inline `-- ROLLBACK:` comment block
(P3-2).
