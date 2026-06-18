# Roadmap

What is queued after the surface on `main` today. This page is intentionally
conservative: it names only work that is grounded in the ADR, the lane board, or
hooks already present in the code. Nothing here is a shipped contract — anything
not yet merged is marked.

The canonical, sequenced build chain (`plans/TM_REBUILD_CHAIN_V2.md`) lives in
the private `tgp-agent-context` repo and is the source of truth for ordering and
scope. This page summarizes; it does not replace it.

## Next: TM-5 apply funnel (merge-ready)

TM-5 (PR #435) is dual-CLEAN and **merge-ready, awaiting operator PII sign-off**.
Per [ADR-0002](../architecture/adr-0002-talent-marketplace-rebuild.md) decision
8, PII/RLS/auth-surface PRs require operator sign-off before merge. It adds the
anonymous apply flow: a few-tap application that mints a lightweight pre-coach
account and an applicant profile, made double-tap-safe by the TM-4 idempotency
ledger and fronted by the TM-6 anti-bot gate. It writes into the TM-1 RLS schema
already on `main` (see [pii-and-rls.md](./pii-and-rls.md)); it relaxes no policy.

When it merges, [endpoints.md](./endpoints.md#apply-funnel-tm-5--merge-ready-awaiting-operator-pii-sign-off)
gains its concrete routes and DTOs.

## Operator-gated lanes still ahead

ADR-0002 decision 8 names the PII/RLS/auth-surface lanes that each require
operator sign-off before merge: **TM-1** and **TM-5** (covered above and on/near
`main`), plus **TM-8**, **TM-12**, and **TM-13** still ahead. The RLS spine
already provisions the tables these lanes consume — the `CoachOffer` policies
note TM-12 as the service layer that will enforce head-coach-only offer
creation. Exact scope and order for TM-8/12/13 are defined in the private build
chain, not here.

## Web SEO surface (TM-W2)

The TM-3 detail endpoint already emits a schema.org `JobPosting` object
([`job-posting-jsonld.ts`](../../src/talent-marketplace/job-posting-jsonld.ts))
specifically for a web SEO page rendered as
`<script type="application/ld+json">`. That web surface (referred to as TM-W2 in
the code comments) is a separate frontend deliverable; the backend contract it
consumes is shipped.

## How to read this page

- Lanes marked **merged** in the [README lane board](./README.md#shipping-status-lane-board)
  are on `main` and documented as shipped throughout this directory.
- TM-5 is the only lane documented as merge-ready; it is marked at every mention.
- Everything else above is forward-looking and deliberately light on specifics —
  consult `plans/TM_REBUILD_CHAIN_V2.md` (private `tgp-agent-context`) for the
  authoritative sequence before treating any of it as committed scope.
