# Endpoints

Concrete reference for the marketplace surface. Every entry quotes the real
controller, route, guards, and response shape from source. All paths are mounted
under the global `/api` prefix and are written here without it, matching the
`@Controller(...)` decorators.

Status legend: **Merged** routes are on `main` today. The apply funnel (TM-5) is
**merge-ready** (PR #435) and not yet on `main`; it is documented as it is
intended to ship and marked at every mention.

## Public browse + detail (TM-3)

[`public-listing.controller.ts`](../../src/talent-marketplace/public-listing.controller.ts)
— `@Controller('talent-marketplace/public/listings')`, `@Public()`,
`@Throttle({ default: { ttl: 60000, limit: 60 } })` (60 req/min/IP).

### `GET /talent-marketplace/public/listings`

Keyset-paginated browse of published listings. Query params come from
`BrowseListingsQueryDto`
([`public-listing.dto.ts`](../../src/talent-marketplace/public-listing.dto.ts)):

| Param | Rule |
|-------|------|
| `limit` | integer 1–50, default 20 |
| `cursor` | opaque `next_cursor` echoed back, max 512 chars |
| `specialty` | free-text equality, max 120 chars |
| `location` | free-text equality, max 160 chars |
| `modality` | free-text equality, max 80 chars |
| `compensation_type` | narrowed to `commission`/`rev_share`/`flat`/`hybrid`; unknown values ignored |

Response (`BrowseListingsResponse`):

```json
{
  "items": [ /* PublicListingCardDto[] */ ],
  "next_cursor": "eyJ...="
}
```

`next_cursor` is `null` on the last page. Each item is a `PublicListingCardDto` —
an explicit allow-list (`id`, `title`, `specialty`, `location`, `modality`,
`compensation_summary`, `published_at`, `cta_listing_id`). The raw entity is
never spread, so `hirer_id` and other internal fields cannot leak (see
[pii-and-rls.md](./pii-and-rls.md)).

### `GET /talent-marketplace/public/listings/:id`

SEO detail for a single published listing. `id` is validated with
`ParseUUIDPipe({ version: '4' })`. Returns the `PublicListingDetailDto` plus a
schema.org `JobPosting` object for the web SEO page:

```json
{
  "listing": { /* PublicListingDetailDto */ },
  "json_ld": { "@context": "https://schema.org", "@type": "JobPosting", ... }
}
```

The JSON-LD is built by
[`buildJobPostingJsonLd`](../../src/talent-marketplace/job-posting-jsonld.ts), a
pure function over the public detail DTO — PII-free by construction. A draft,
closed, or non-existent id is a **404** (`code: job_listing_not_found`), never a
401/403, so an anonymous caller cannot distinguish an unpublished listing from a
missing one.

## Hirer listing CRUD (TM-2)

[`job-listing.controller.ts`](../../src/talent-marketplace/job-listing.controller.ts)
— `@Controller('talent-marketplace/listings')`, `@Roles('coach', 'owner')`,
`@UseGuards(JwtAuthGuard, HirerVerifiedGuard)`. `JwtAuthGuard` attaches
`req.user`; `HirerVerifiedGuard` restricts to verified hirers (owner always;
coach must hold an active subscription and not be an archived sub-coach).

| Method + route | Status | Action |
|----------------|--------|--------|
| `POST /talent-marketplace/listings` | 201 | Create a listing (`CreateJobListingDto`) |
| `PATCH /talent-marketplace/listings/:id` | 200 | Edit a listing the caller owns |
| `POST /talent-marketplace/listings/:id/publish` | 200 | Publish (idempotent if already published) |
| `POST /talent-marketplace/listings/:id/close` | 200 | Close (idempotent if already closed) |

`JobListingService`
([`job-listing.service.ts`](../../src/talent-marketplace/job-listing.service.ts))
enforces the rules:

- Every mutation runs `requireOwnedListing` — unknown id → 404
  (`{ kind: 'job_listing_not_found' }`); another hirer's id → 403
  (`{ kind: 'job_listing_not_owned' }`).
- A `closed` listing cannot be edited or re-published
  (`{ kind: 'job_listing_closed' }`).
- `compensation_terms` is validated per `compensation_type`:
  `commission { rate_pct }`, `rev_share { rate_pct, cap_usd? }`,
  `flat { amount_usd, period }`, `hybrid { base_usd, rate_pct }`. A bad shape →
  400 (`{ kind: 'invalid_compensation_terms' }`).

These handlers throw the legacy `{ kind }` body, which the `HttpExceptionFilter`
**drops** before the wire (only `code` survives). See
[error-contract.md](./error-contract.md#the-kind-gap-tm-2).

## Apply funnel (TM-5 — merge-ready, awaiting operator PII sign-off)

The anonymous apply funnel is **not on `main`**. It ships with PR #435 and, per
ADR-0002 decision 8, requires operator sign-off before merge because it is a
PII/auth-surface PR. Documented here as it is intended to ship:

- An anonymous applicant submits an application against a published listing in a
  few taps.
- A successful apply mints a lightweight pre-coach account and an applicant
  profile.
- The flow is made double-tap-safe by the TM-4 idempotency ledger
  (`MarketplaceIdempotencyService`) and is fronted by the TM-6 anti-bot gate
  (below). Stripe Connect onboarding is reused via the TM-10 adapter, not
  rebuilt.

Concrete routes, DTOs, and response shapes will be added to this section when
PR #435 merges. Until then, nothing here should be treated as a stable contract.

## Anti-bot gate (TM-6)

[`anti-bot/anti-bot.guard.ts`](../../src/talent-marketplace/anti-bot/anti-bot.guard.ts)
— merged. `AntiBotGuard` is the gate layer for the apply / account-create
surface. It is a **no-op on any route that does not carry the `@AntiBotGate(...)`
metadata**, so landing it ahead of TM-5 changes no live behaviour.

When a surface is declared, the guard normalizes the request into a PII-light
`AntiBotSignal` (IP via the Fly trusted-proxy chain, user agent, an identity hint,
an optional device fingerprint), asks the pluggable provider, and maps the
verdict to HTTP with a uniform body so a prober cannot tell which heuristic fired:

| Verdict | HTTP | Notes |
|---------|------|-------|
| `allow` | pass through | — |
| `challenge` | 428 Precondition Required | sets `Retry-After` |
| `deny` (identity) | 403 Forbidden | `duplicate_device` / `duplicate_identity` |
| `deny` (rate) | 429 Too Many Requests | sets `Retry-After` |

The provider is pluggable; the shipped implementation is in-house
(`in-house-anti-bot.provider.ts`).

## Connect webhook (TM-14)

[`talent-connect-webhook.controller.ts`](../../src/talent-marketplace/talent-connect-webhook.controller.ts)
— `@Controller('v1/webhooks/talent-marketplace')`, merged.

### `POST /v1/webhooks/talent-marketplace/connect`

`@Public() @HttpCode(200)`. Receives Stripe Connect `account.updated` events.

1. Resolves the configured webhook secrets; an empty set → 400.
2. Requires the Express `rawBody` (enabled in `main.ts`); absence → 400.
3. Verifies the Stripe signature against the secrets
   (`verifyStripeSignature`); a signature failure → 400.
4. Parses and shape-checks the event (`id`, `type`, `data` required) → 400 on
   malformed input.
5. Delegates to `TalentConnectWebhookService.handleAccountUpdated`
   ([`talent-connect-webhook.service.ts`](../../src/talent-marketplace/talent-connect-webhook.service.ts)).

The service dedups by `stripe_event_id` (the `MarketplaceConnectEvent` primary
key; a P2002 unique violation means already-processed), derives onboarding
completion via `TalentConnectAdapter.deriveOnboarded` (`charges_enabled &&
payouts_enabled`), and returns:

```json
{ "received": true, "processed": true, "onboarding_completed": true }
```

with `alreadyProcessed` / `reason` fields on the dedup and no-op paths.

## Connect adapter reuse (TM-10)

[`connect-adapter.service.ts`](../../src/talent-marketplace/connect-adapter.service.ts)
— merged. `TalentConnectAdapter` is a thin, append-only adapter over the existing
`CoachConnectService` (the `/coach/connect/*` surface). Per ADR-0002 decision 3,
Connect onboarding has one surface; the marketplace reuses it rather than
rebuilding. The adapter exposes `createOnboardingLink` and `getStatus` behind a
10-second `AbortController` timeout, maps provider failures to stable codes
(`PAYMENTS_PROVIDER_TIMEOUT`, `PAYMENTS_PROVIDER_ERROR`,
`CONNECT_ONBOARDING_UNAVAILABLE`, `CONNECT_ONBOARDING_NOT_CONFIGURED`), and
redacts secrets (`sk_`, `Bearer`, email) from logs. It is not itself an HTTP
route — it is the seam the webhook and the merge-ready apply funnel call.
