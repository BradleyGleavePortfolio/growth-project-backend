# Talent Marketplace

The Talent Marketplace is a two-sided, public job board for coaches. Verified
hirers (gym owners and paying coaches) post job listings; anyone can browse the
published listings without an account; a job-hunter applies in a few taps, which
mints a lightweight pre-coach account and an applicant profile. Stripe Connect
onboarding is reused from the existing coach surface rather than rebuilt.

This directory is the canonical reference for the marketplace as it ships
**today** on `main`. Where a slice is implemented but not yet merged, it is
called out explicitly — nothing here is aspirational unless labelled so.

The design rationale and the eight operator-locked decisions live in
[ADR-0002](../architecture/adr-0002-talent-marketplace-rebuild.md). The full
sequenced build chain (`plans/TM_REBUILD_CHAIN_V2.md`) lives in the private
`tgp-agent-context` repo.

## Who it is for

- **Hirers** — verified coaches and gym owners who post and manage listings
  (`HirerVerifiedGuard` decides who counts as verified; see
  [endpoints](./endpoints.md#hirer-listing-crud-tm-2)).
- **Job-hunters** — anyone browsing published listings anonymously, and
  applicants who apply and get a pre-coach account.
- **The platform** — Stripe Connect onboarding state is kept in sync via an
  event-driven webhook so payout readiness is known without polling.

## Shipping status (lane board)

The marketplace is built as a sequence of small lanes (TM-N). Status reflects
what is merged to `main` at the base of this document.

| Lane | Scope | Status |
|------|-------|--------|
| TM-1 | RLS spine for marketplace tables (write-scope, published public-read) | Merged |
| TM-2 | Verified-hirer JobListing CRUD + publish/close | Merged |
| TM-3 | Public, unauthenticated browse + SEO detail (JSON-LD) | Merged (PR #434) |
| TM-4 | Per-mutation idempotency ledger (`MarketplaceIdempotencyService`) | Merged |
| TM-6 | In-house anti-bot gate for the public apply surface | Merged |
| TM-10 | Connect reuse adapter (`TalentConnectAdapter`) | Merged |
| TM-14 | Event-driven Connect `account.updated` webhook | Merged |
| TM-5 | Apply funnel + pre-coach account + applicant profile | **Merge-ready (PR #435), awaiting operator PII sign-off** |

TM-5 is dual-CLEAN and merge-ready; per ADR-0002 decision 8 it requires operator
sign-off before merge because it is a PII/auth-surface PR. It is documented here
as the architecture intends it to ship, with its pending state marked at every
mention.

## What is in main today

- **Hirer write surface** — create, edit, publish, and close listings, gated to
  verified hirers (`JobListingController`, `JobListingService`,
  `HirerVerifiedGuard`).
- **Public read surface** — keyset-paginated browse and a SEO detail endpoint
  that also returns a schema.org `JobPosting` object
  (`PublicListingController`, `PublicListingService`, `job-posting-jsonld.ts`).
- **Idempotency ledger** — a per-route claim/replay ledger with a stale-claim
  TTL sweep (`MarketplaceIdempotencyService`).
- **Connect reuse** — a thin, append-only adapter over the existing
  `/coach/connect/*` surface (`TalentConnectAdapter`) plus the TM-14
  `account.updated` webhook that derives onboarding completion from the event
  payload.

All of the above is wired in
[`src/talent-marketplace/talent-marketplace.module.ts`](../../src/talent-marketplace/talent-marketplace.module.ts).

## Documents

- [architecture.md](./architecture.md) — request flow, RLS posture, the error
  envelope, the idempotency ledger, and the cursor signing model.
- [endpoints.md](./endpoints.md) — concrete endpoint reference for the shipped
  surface (and the merge-ready apply funnel).
- [error-contract.md](./error-contract.md) — the `{ error, message, code }`
  envelope, its filter, and the code discriminators in use.
- [pii-and-rls.md](./pii-and-rls.md) — PII-omission posture and RLS write-scope.
- [roadmap.md](./roadmap.md) — what is queued after TM-5.

## Conventions

All marketplace routes are mounted under the global `/api` prefix (see the
top-level [README](../../README.md#route-contracts)). Paths in this directory are
written without the `/api` prefix for brevity, matching the `@Controller(...)`
decorators in source.
