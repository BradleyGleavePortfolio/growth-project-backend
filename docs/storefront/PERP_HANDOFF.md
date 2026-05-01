# Wave 9 — Storefront block builder + funnel analytics — session log

> **Date:** 2026-05-01
> **Status:** docs only, draft, NOT MERGED
> **Branch:** `docs/wave-9-storefront-builder`
> **Author:** autonomous spec agent (Opus 4.7)

## What this wave ships

Six dense spec files under `docs/storefront/` totalling ~5,381 lines. Closes the "no-code storefront / page builder" parity gap with Whop AI.

| File | Lines | Purpose |
|---|---:|---|
| `README.md` | 186 | Purpose, non-goals, OWNER decisions, file map |
| `block-editor-spec.md` | 1,667 | Block tree data model, validation, undo/redo, autosave, collab lock, accessibility, mobile breakpoints, state machine, failure modes |
| `block-types-catalog.md` | 1,190 | Canonical block types (Hero, Pricing, Testimonial, FAQ, Embed, CTA, About, Programs-Grid, Reviews, Schedule, Custom-via-app), TS + JSON Schema, image policy, embed allowlist |
| `publishing-and-versioning.md` | 779 | Draft → preview → publish lifecycle, version snapshots, rollback (last 30), SEO SSR via ISR, sitemap/robots/OG/Twitter |
| `funnel-analytics.md` | 963 | Event taxonomy, block-level CTR, conversion attribution (cross-link Wave 7 buyer funnel), per-block funnel chart contract, perf budgets, sampling |
| `integration-with-apps.md` | 596 | How Wave 6 manifests declare custom blocks, iframe sandbox, postMessage protocol, permission scopes, failure modes |

## OWNER decisions surfaced (5)

| # | Decision | Recommendation |
|---|---|---|
| 1 | Custom-HTML escape policy | NO arbitrary HTML in v1; allowlist embeds only |
| 2 | A/B test scope v1 | Page-level only; block-level deferred to v2 |
| 3 | SEO render strategy | ISR (incremental static regen) |
| 4 | Image CDN | Cloudflare Images |
| 5 | Version retention | 30 versions per page |

All recommendations carry rationale; OWNER may flip any with a follow-up before GA.

## Dependencies

- **Depends on:** Wave 6 (custom blocks via app manifest), Wave 7 (buyer funnel attribution).
- **Depends on existing platform primitives:** Wave 2 sub-coach hierarchy (block-level permissions), Wave 1 admin console (operator preview surface).
- **Foundation for:** none in scope — Wave 9 is the consumer-facing tip of the funnel.

## Hard rules satisfied

- Docs only — `prisma/schema.prisma` untouched. All schema deltas in fenced ```prisma blocks.
- No emojis, no TODO/FIXME/Coming Soon.
- Decimal(14,2) on all money references; currency on row.
- PII never to PostHog — only opaque ids and counts in analytics emission.
- GDPR cascade specified on all personal-data tables (visitor session, attribution event).
- AI default `sonar-pro`; spend caps surfaced.
- Performance budgets at 100/1k/10k coach scale.
- Audit-log entries specified per mutation route.

## Failure modes coverage

- `block-editor-spec.md`: 7 failure modes (autosave conflict, schema migration mid-edit, browser crash, concurrent edit, oversize image, broken link, undo/redo desync).
- `block-types-catalog.md`: per-block validation rules; embed-provider failure handling.
- `publishing-and-versioning.md`: 6 failure modes (publish race, ISR cache poisoning, sitemap stale, OG image missing, version-storage exhausted, rollback to incompatible schema version).
- `funnel-analytics.md`: 5 failure modes (event drop, sampling skew, attribution race with Wave 7, double-fire, GDPR-purged session in retro report).
- `integration-with-apps.md`: 5 failure modes (block load timeout, oversized payload, untrusted origin, version mismatch, sandbox break).

## Cross-repo deps

- `growth-project-mobile`: storefront page render in mobile webview; same SSR endpoints.
- `tgp-finance-app`: pricing-block reads from finance pricing model (Wave 5).
- Wave 6 `docs/apps/manifest-spec.md`: custom-block declaration format.

## Senior-engineer onboarding checklist

- [ ] Read `docs/storefront/README.md`, then `block-editor-spec.md`, `block-types-catalog.md`.
- [ ] Read Wave 6 `docs/apps/manifest-spec.md` for the custom-block declaration.
- [ ] Read Wave 7 `docs/discovery/buyer-funnel-and-attribution.md` for the attribution model the storefront feeds into.
- [ ] Review existing TGP `audit-and-gdpr.md` and PostHog event-emission policy.
- [ ] Confirm Cloudflare Images account binding with infra (assuming OWNER accepts the CDN recommendation).

## Open clarifications (none blocking)

All OWNER decisions are recommendations. Implementation can proceed on the recommendations on file.

## What is NOT in this wave

- Block-level A/B testing — deferred to v2.
- Arbitrary custom HTML/CSS/JS — explicitly excluded; embeds use a provider allowlist.
- Visual diff between page versions — version metadata only; visual diff deferred.
- Coach-to-coach storefront templates marketplace — separate flow, deferred.

## Status

Draft, do not merge.
