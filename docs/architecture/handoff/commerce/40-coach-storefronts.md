# Handoff brief: #40 Coach Storefronts

**Spec:** [`docs/specs/commerce/coach-storefronts.md`](../../../specs/commerce/coach-storefronts.md).

## WHY

A coach today drives prospects to a Linktree → Kajabi → Calendly chain. Each transition leaks brand, attribution, and trust. A TGP-owned storefront at `tgp.app/c/<slug>` (and L3 custom domains) gives the coach **one** branded URL that hosts offers, application form, content samples, social proof, and checkout — all rendered by **this** backend, with revenue attributable from day 1.

Storefront is also the **first surface** a prospect sees searching the coach's name. It has to load fast (SSR), look like the coach, and have working CTAs.

## WHEN

- Spec accepted.
- [`payments-checkout.md`](../../../specs/commerce/payments-checkout.md) S1 live (so checkout buttons go somewhere).
- PR #121 spec #27 (public-coach-profile) reconciled — the slug allocator is owned by #27; this spec consumes.
- §20 OQs closed (slug rename policy, custom-domain ownership).

## WHERE

- New module `src/storefronts/`. Sibling to `src/public-pages/`. Subdirs `coach-side/`, `public-side/`, `media/`.
- New tables: `Storefront`, `StorefrontSection`, `StorefrontMedia`, `StorefrontDomain`, `StorefrontVisit`.
- New routes: `/api/v1/coach/storefront/*`, `/api/v1/storefront/:slug/*`, `/api/v1/owner/storefronts/*`.
- Public SSR HTML at `/c/:slug`.
- **Does not touch** `new-website`.

## WHO

- Sign-off: founder, backend lead, PR #121 #27 spec author (slug authority).
- Pager: backend lead. Escalation to founder for any takedown decision.

## WHAT

**Net-new:** storefront row + sections + media + custom domain + visit-attribution.

**Reuses:** `coach_slug` from PR #121 #27. Avatar from PR #123 #32. Content boards from PR #123 #33.

**Non-goals (S1):** no theme designer, no A/B testing, no drag-and-drop. One fixed-but-tasteful template (`BASIC_V1`).

## HOW

S0 spec → S1 (CRUD + one template, flag off) → S2 (custom domains, OG-tag, abuse rate-limits) → S3 GA. Smallest first PR: `Storefront` + `StorefrontSection` + four endpoints + `BASIC_V1` template, ≤500 LOC.

## Risk + dependency highlights

- Slug collision with #27 — single allocator owned by #27.
- Custom-domain DNS misconfiguration — TXT validation + retry.
- SSR cost / bot scraping — aggressive cache, 60/min/IP rate limit.
- Moderation latency — report-button + 2-OWNER takedown ack.

## Operator handoff

`STOREFRONTS_ENABLED`, `STOREFRONTS_CUSTOM_DOMAINS_ENABLED` flags. Per-storefront `status='paused' | 'taken_down'`. Runbook `docs/storefronts/operator-runbook.md`. SSR p95 + cache-hit-rate + moderation-queue dashboards.
