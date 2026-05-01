# Expansion roadmap addendum — Commerce & Marketplace wave (rows #40–#45)

> **Status:** Draft. Folds into PR #119's `expansion-roadmap.md` once #119 merges. Coexists with PR #121's `expansion-roadmap-addendum.md` (rows #21–#29) and PR #123's `expansion-wave-coach-experience.md` (rows #30–#37).

This addendum reserves rows **#40–#45** in the same row-numbered scheme PR #119 introduces, so the commerce wave is trivially mergeable in either order with #119/#121/#123.

## Wave rows

| #   | Lane                               | Stage                  | Brief                                                  | Spec                                                                  |
| --- | ---------------------------------- | ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 40  | Coach Storefronts                  | discovery (this PR)    | [`40-coach-storefronts.md`](./handoff/commerce/40-coach-storefronts.md) | [`docs/specs/commerce/coach-storefronts.md`](../specs/commerce/coach-storefronts.md) |
| 41  | Payments + Checkout                | discovery (this PR)    | [`41-payments-checkout.md`](./handoff/commerce/41-payments-checkout.md) | [`docs/specs/commerce/payments-checkout.md`](../specs/commerce/payments-checkout.md) |
| 42  | Offer Builder                      | discovery (this PR)    | [`42-offer-builder.md`](./handoff/commerce/42-offer-builder.md) | [`docs/specs/commerce/offer-builder.md`](../specs/commerce/offer-builder.md) |
| 43  | Application Funnel                 | discovery (this PR)    | [`43-application-funnel.md`](./handoff/commerce/43-application-funnel.md) | [`docs/specs/commerce/application-funnel.md`](../specs/commerce/application-funnel.md) |
| 44  | Affiliate / Referral               | discovery (this PR)    | [`44-affiliate-referral.md`](./handoff/commerce/44-affiliate-referral.md) | [`docs/specs/commerce/affiliate-referral.md`](../specs/commerce/affiliate-referral.md) |
| 45  | Coach Marketplace                  | discovery (this PR)    | [`45-coach-marketplace.md`](./handoff/commerce/45-coach-marketplace.md) | [`docs/specs/commerce/coach-marketplace.md`](../specs/commerce/coach-marketplace.md) |

## Dependency graph

```
                  +--------+
                  |  #41   |  Payments + Checkout (Stripe Connect + future MoR)
                  +--------+
                       |
       +---------------+----------------+
       |               |                |
   +--------+      +--------+      +--------+
   |  #40   |      |  #42   |      |  #43   |
   +--------+      +--------+      +--------+
   Storefronts    Offer Builder   Application
       |               |                |
       +---------------+----------------+
                       |
       +---------------+----------------+
       |                                |
   +--------+                       +--------+
   |  #44   |                       |  #45   |
   +--------+                       +--------+
   Affiliate                        Marketplace
```

- **#41 is the foundation.** Read first; gate everything else.
- **#40 is the surface.** Read second; the page where every other lane attaches.
- **#42, #43 are sibling adjacencies** of #40. They depend on #41 but not on each other.
- **#44 depends on #41 + #42** (`Offer.affiliate_share_bps`). Optional dependency on #43 (setter attribution chain).
- **#45 depends on every prior lane.** Last to ship.

## Stage definitions (mirror PR #119's `expansion-roadmap.md`)

- **parking lot:** known idea; no spec; not actively being worked.
- **in discovery:** spec drafted; review in progress.
- **in flight:** at least one runtime PR opened against the spec.
- **shipped:** flag-on for the entire entitled cohort; runbook + dashboards live.

The six rows above are all currently **in discovery**. The §3 ("WHEN") sections of each spec enumerate the gates that flip a row to **in flight**.

## How to fold this in

When PR #119 merges, append the six rows above to the main `expansion-roadmap.md` table, in the order shown. The row numbers do not need re-allocation; they were chosen to leave space (#11–#19, #38–#39) for future additions before this wave.

When this wave is folded in, this addendum can be deleted (or kept as an archived snapshot of the add).
