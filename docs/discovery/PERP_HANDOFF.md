# PERP_HANDOFF — Wave 7 Discovery Marketplace

Session log for the wave-7 discovery spec authoring session.

## Branch

`docs/wave-7-discovery-marketplace` off `main`.

## Files authored

| File                                            | Purpose                                                  |
| ----------------------------------------------- | -------------------------------------------------------- |
| README.md                                       | purpose, non-goals, OWNER decisions, file map, deps      |
| public-directory-spec.md                        | card schema, filter taxonomy, URL structure, SSR         |
| recommendation-engine.md                        | cold-start + warm ranking, vector match, A/B framework   |
| featured-placements-and-monetization.md         | tiers, anti-spam, Stripe billing, refund                 |
| buyer-funnel-and-attribution.md                 | event ledger, attribution, dashboards                    |
| trust-and-safety.md                             | achievements, testimonials, photos, banned claims        |
| api-and-mobile.md                               | REST surface, rate limits, cache, mobile parity          |
| PERP_HANDOFF.md                                 | this file                                                |

## OWNER decisions surfaced

1. **Embedding model**: hybrid (OpenAI + local bge). Recommended.
2. **Attribution window**: 30-day last-touch v1; multi-touch v2 toggle. Recommended.
3. **Featured-slot pricing**: flat tier with cap (Bronze/Silver/Gold). Recommended.
4. **Refund-rate auto-suspend**: 8% trailing 90 days. Recommended.
5. **Transformation-photo retention**: GDPR-aligned 30-day post-revocation hard delete. Recommended.
6. **Crawler indexing default**: opt-out indexing (default indexable; coach can `noindex`). Recommended.
7. **Geo-radius unit**: locale-default with override. Recommended.
8. **Sub-coach surfacing**: bundled under parent (default), independent if capability granted. Recommended.

## Dependencies

- Wave 2 (`docs/coach-hierarchy/`): `Coach`, `SubCoach`, capability matrix.
- Wave 6 (`docs/apps/`): `App` entity for app cards.
- Wave 8 (`docs/affiliate-and-rewards/`): trust-signal sources (completion ledger).
- Wave 3 admin data-feed: capability hash cache keys reused.
- Wave 5 finance: Stripe Connect for featured-slot billing (platform fee path).

## Non-goals to reiterate

- No fake reviews, no fake testimonials, no fabricated transformation photos.
- No exact-revenue claims by coaches.
- No medical claims.
- No public streak counters that shame loss.
- No paid review boosts; ranking signals not for sale.

## Cross-repo deps

- `growth-project-mobile` consumes the same REST API.
- `tgp-finance-app` consumes featured-slot + checkout/refund event streams.

## Day-1 implementation order (cross-file consolidated)

1. `CoachListing` Prisma model + state machine + slug rules (`public-directory-spec.md`).
2. Filter taxonomy constants + canonicalisation + cursor (`public-directory-spec.md`).
3. Public read endpoints (`api-and-mobile.md`).
4. Event ingestion endpoint + ledger (`buyer-funnel-and-attribution.md`).
5. Cookie consent + analytics gate (`buyer-funnel-and-attribution.md`).
6. Cold-start ranking + first-pass MV (`recommendation-engine.md`).
7. SSR for `/discover/coaches` (`public-directory-spec.md`).
8. Verified-achievement system (`trust-and-safety.md`).
9. Banned-claim regex + LLM tiebreaker (`trust-and-safety.md`).
10. Featured-slot tier + Stripe billing (`featured-placements-and-monetization.md`).
11. Coach console funnel dashboard (`buyer-funnel-and-attribution.md`).
12. Vector embedding + warm ranking (`recommendation-engine.md`).
13. A/B framework (`recommendation-engine.md`).
14. Refund-rate auto-suspend cron (`trust-and-safety.md` + `featured-placements-and-monetization.md`).
15. Manual review queue UI (`trust-and-safety.md`).

## Test-plan summary

- Unit: filter canonicalisation, cursor encoding, ranking score, banned-claim regex, geo math, achievement category gating, attribution chain.
- Integration: end-to-end card render, featured-slot purchase, refund-rate suspension, testimonial consent revocation, transformation-photo retention.
- E2E: anonymous browse → click → profile → application → checkout; coach views funnel; admin moderation flow.
- Load: 10k coaches, 1k QPS on `/discover/coaches`, p95 < 250ms.
- Security: cursor forgery, IDOR, SSRF, rate-limit bypass.
- Privacy: GDPR export/delete cascade, PostHog PII linter, cookie-consent gates.

## Rollback plan

- `DISCOVERY_PUBLIC_ENABLED` feature flag.
- `FEATURED_SLOT_BILLING_ENABLED` kill-switch.
- `DISCOVERY_RECO_SHADOW` for shadow ranking 30 days post-launch.
- Per-experiment rollback via `RankingExperiment.status = ROLLED_BACK`.
- Hard kill: weights reset to recency-only sort.

## Blockers / open items

- OWNER must confirm 5 numbered OWNER_DECISIONs before Day 1.
- Reverse-image-search vendor selection (vendor-agnostic in spec).
- Certifying-body API integrations to be enumerated (per Wave 7.5 follow-up).
- A/B framework integration with PostHog dashboards (out of scope; tracked).

## Notes for next session

- Wave 8 (affiliate + rewards) feeds verified-completion ledger; Wave 7 trust badges depend on it. Confirm Wave 8 PR shape.
- Mobile (`growth-project-mobile`) PR mirroring this wave to be authored after backend draft merges.
- Finance (`tgp-finance-app`) PR for featured-slot reconciliation feed to be authored after Stripe path validated.

## Status

Draft. PR is the spec. No runtime, no migrations, `prisma/schema.prisma` untouched.

---

End PERP_HANDOFF.
