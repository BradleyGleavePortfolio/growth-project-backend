# Architecture

This document describes how a marketplace request flows through the system, the
RLS posture that backs every query, the canonical error envelope, the
idempotency ledger, and the keyset cursor signing model. Everything here
reflects what is on `main` today. Where a slice is merge-ready but not yet
merged (TM-5), it is marked inline.

All routes are mounted under the global `/api` prefix. Paths below are written
without it, matching the `@Controller(...)` decorators in source.

## Module wiring

The marketplace is a single NestJS module,
[`talent-marketplace.module.ts`](../../src/talent-marketplace/talent-marketplace.module.ts).
As shipped on `main` it registers:

- **Controllers** — `JobListingController` (hirer write surface),
  `PublicListingController` (public read), `TalentConnectWebhookController`
  (Stripe Connect webhook).
- **Providers** — `JobListingService`, `PublicListingService`, `PrismaService`,
  `JwtAuthGuard`, `JwksVerifierService`, `HirerVerifiedGuard`,
  `TalentConnectWebhookService`.
- **Imports** — `TalentConnectAdapterModule` (the TM-10 reuse adapter).
- **Exports** — `JobListingService`.

The TM-5 apply funnel (`ApplyController`/`ApplyService`, anti-bot gate) is **not**
wired into the module on `main`. It lands with PR #435.

## Request flow

### Hirer write (TM-2)

```
client → JwtAuthGuard → HirerVerifiedGuard → JobListingController → JobListingService → Prisma (RLS)
```

1. `JwtAuthGuard` verifies the bearer token and attaches `req.user`.
2. `HirerVerifiedGuard`
   ([`hirer-verified.guard.ts`](../../src/talent-marketplace/hirer-verified.guard.ts))
   decides who counts as a verified hirer: an `owner` is always verified; a
   `coach` must not be an archived sub-coach (`TeamSubCoachAssignment` with
   `archived_at: null`) and must hold an `active`/`trialing`/`grandfathered`
   `CoachSubscription`. A failure throws `ForbiddenException({ kind:
   'hirer_not_verified' })`.
3. `JobListingService`
   ([`job-listing.service.ts`](../../src/talent-marketplace/job-listing.service.ts))
   enforces the lifecycle rules and scopes every mutation to the caller's own
   listings via `requireOwnedListing`.
4. Prisma writes execute under RLS (TM-1), which scopes rows to
   `app.current_user_id()`.

### Public read (TM-3)

```
client (anon) → @Public() PublicListingController → PublicListingService → Prisma (status='published')
```

1. `PublicListingController`
   ([`public-listing.controller.ts`](../../src/talent-marketplace/public-listing.controller.ts))
   is `@Public()` (no auth) and rate-limited with
   `@Throttle({ default: { ttl: 60000, limit: 60 } })`.
2. `PublicListingService`
   ([`public-listing.service.ts`](../../src/talent-marketplace/public-listing.service.ts))
   applies an explicit `status: 'published'` filter as defence-in-depth over the
   TM-1 RLS public-read policy, and maps every row through an allow-list DTO so
   no PII can escape (see [pii-and-rls.md](./pii-and-rls.md)).

### Connect webhook (TM-14)

```
Stripe → @Public() TalentConnectWebhookController → verifyStripeSignature → TalentConnectWebhookService
```

The webhook is `@Public()` but gated by Stripe signature verification before any
parsing. See [endpoints.md](./endpoints.md#connect-webhook-tm-14).

## RLS posture

Row-Level Security is the spine (TM-1). Every marketplace table carries policies
keyed on `app.current_user_id()` and `app.is_owner()`, with a `service_role`
bypass for trusted server paths. Anonymous callers see zero rows by default; the
only public-read path is `JobListing` rows where `status = 'published'`. The
application layer re-applies that published filter explicitly so a missing or
mis-scoped RLS policy can never widen visibility. Full detail lives in
[pii-and-rls.md](./pii-and-rls.md).

## Error envelope

Errors are normalized by the global
[`HttpExceptionFilter`](../../src/filters/http-exception.filter.ts). It reads
`message`, `error`, and an optional machine-readable `code` off the exception
body and emits:

```json
{
  "statusCode": 404,
  "code": "job_listing_not_found",
  "message": "Job listing not found",
  "error": "Not Found",
  "timestamp": "2026-06-18T00:00:00.000Z",
  "path": "/api/talent-marketplace/public/listings/...",
  "request_id": "..."
}
```

`code` is additive — it appears only when a handler sets it. The filter does
**not** read a `kind` field; any `kind` on an exception body is silently dropped
from the wire. TM-3 (and the merge-ready TM-5) set `code`; TM-2 and
`HirerVerifiedGuard` still throw the legacy `{ kind }` shape, so `kind` never
reaches the client. The full contract and the gap it implies are documented in
[error-contract.md](./error-contract.md).

## Idempotency ledger (TM-4)

`MarketplaceIdempotencyService`
([`marketplace-idempotency.service.ts`](../../src/talent-marketplace/marketplace-idempotency.service.ts))
is a per-route claim/replay ledger:

- `claimOrReplay` returns a discriminated union — `claimed` (first caller wins a
  claim with a `claim_nonce` fence), `replay` (a completed result is returned
  verbatim), or `in_flight` (a live claim is still held).
- `markCompleted` records the terminal result against the claim.
- `releaseClaim` frees a claim on failure so a retry can re-acquire it.
- A stale-claim TTL sweep (`MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS`, default
  `600000` ms) reclaims claims abandoned by a crashed request.

The ledger is the substrate the merge-ready TM-5 apply funnel uses to make a
double-tapped apply safe. It is on `main` today even though its first consumer
ships with PR #435.

## Cursor signing model (TM-3)

Public browse paginates with an opaque, HMAC-signed keyset cursor
([`public-listing.cursor.ts`](../../src/talent-marketplace/public-listing.cursor.ts)).

- **Keyset, not offset.** The cursor encodes the `(created_at, id)` tuple of the
  last row on a page, backing the `@@index([status, created_at, id])`. The sort
  is `(created_at DESC, id DESC)`. `created_at` is the key (not `published_at`)
  because it is `NOT NULL` and indexed, giving a total, stable order; keying on
  the nullable `published_at` would make the boundary ambiguous.
- **Over-fetch.** The query takes `limit + 1` rows to learn whether a further
  page exists; `next_cursor` is `null` on the last page.
- **Signed.** The payload `<iso8601>|<id>` is HMAC-SHA256 signed with
  `PUBLIC_LISTING_CURSOR_SECRET`, truncated to 16 base64url chars (96 bits), and
  the whole blob is base64url-encoded. Verification is constant-time
  (`timingSafeEqual`).
- **Non-fatal misconfiguration.** The cursor is a pagination hint, not an authz
  token: a forged tuple can only reposition the window over the same
  `status='published'` set, never widen it. So an unset secret in production is a
  one-time boot **warning** (`cursorSecretBootWarning`), not a throw, and a
  malformed or forged cursor degrades to page 1 rather than erroring.
