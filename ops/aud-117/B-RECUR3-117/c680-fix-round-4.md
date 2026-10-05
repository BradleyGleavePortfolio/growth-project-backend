FIX ROUND 4 (B-RECUR3-117, agent 117) — growth-project-backend#680 @ d1c62ee100e4abd72c21295c32f8b32e450981da

Closes Sol REQUEST CHANGES 0/4/0 ([5976246125](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976246125)) and Opus REQUEST CHANGES 0/2/5 ([5976299710](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976299710)). Commits: test `d10fb8c407522a7af4570c4564f6da768512d74c` (spec alone, before the fix), fix `693015fa52c935bb459e6a27f4a350de8e4b620e`, size move `1753f1767db1ed8fd34fca15fa254b322eda4cb2`, restack merge `d1c62ee1` (#679 @ `0e1cfde0` = #678 @ `2174eb7c` = fees top #686 @ `e6893c97`; R3 content unchanged by the merge: `git diff f83dbdd2 1753f176` equals `git diff 0e1cfde0 d1c62ee1`).

Failing-before CI lane (spec alone on `929f3968`): [run 37177995713](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177995713) 19 failed / 4 controls passed, then with the race case added [run 37178249913](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178249913) 20 failed / 4 controls passed. Every failure is an assertion (no compile or fixture error).

| Finding | Change | Commit | Test (test/b-recur3-117-webhook-order.spec.ts) |
|---|---|---|---|
| B-680-1 stale created(incomplete) after invoice.paid / updated(active) revokes a paid plan | Subscription events read the live subscription out of the tx (`prefetchSubscriptionAuthority`, with a lifecycle revision), decide under the package lock on a fresh re-read: an incomplete snapshot of a purchase that left incomplete is skipped; unreadable Stripe throws so Stripe redelivers | 693015fa | "invoice.paid granted, then the created event ... stays paid"; "without a live read, a late incomplete snapshot never revokes"; "Stripe unreadable: ... redelivered" |
| B-680-1 / C-680-3 deleted, then an older active or past_due snapshot re-grants | An ended purchase (canceled / expired / incomplete_expired, not entitled) is never re-granted; a live ended status ends the purchase; the deletion takes the lock | 693015fa | "a deleted paid plan is never revived ... no second content fan-out"; "C-680-3: deleted, then a stale past_due snapshot" |
| B-680-1 a write between the Stripe read and the lock | Revision changed and state differs: throw (redeliver), never overwrite; state matches: claimed, no write | 693015fa | "a write that lands between the Stripe read and the lock is never overwritten"; control "a concurrent write that matches" |
| B-680-1 live authority | A past_due payload delivered after the retry paid follows Stripe (active) | 693015fa | "a past_due payload delivered after the retry paid" |
| B-680-2 late first-invoice decline after paid / after the attempt ended | `isNeverEntitledPaymentAttempt(purchase, billing_reason)` (same signature as #691's helper): `subscription_create` is a first attempt at any row state; an ended purchase answers `subscription_already_ended`; `last_error` only while never entitled (invoice and PaymentIntent paths) | 693015fa | "first-invoice decline delivered after a second card paid"; "first-invoice PaymentIntent decline after invoice.paid"; "Stripe expired the abandoned attempt"; "an attempt retired by checkout (expired)" |
| B-680-2 settled invoice | `prefetchFailedInvoice` reads the invoice (`retrieveInvoice`): paid or void answers `invoice_already_settled`; unreadable throws for redelivery | 693015fa | "a renewal decline delivered after its retry paid"; "the invoice cannot be read on Stripe" |
| B-680-2 race found in this round | Final decline and deletion arrive together: the past_due write re-reads under the package lock and skips an ended purchase (the write now runs on the webhook tx) | 693015fa | "(race) the deletion commits between the decline read and its write" (run 37178249913) |
| B-680-3 / C-680-6 first entitlement is not first payment | `maybeEmitInvoicePayment` on invoice.paid only: native rows, positive integer `amount_paid`, the invoice currency, a `findUnique` pre-check so a second notice never aborts the outer tx on P2002; trial card saves emit nothing | 693015fa | "saving a free trial card sends no first-payment notice"; "first paid invoice after a trial records the amount"; "a combo first invoice reports the $148 paid"; control "already has the notice ... $0 invoice" |
| B-680-4 / C-680-5 conversion-first delivery permits a second trial | `trialStartPatch` stamps on any first entitlement of a trial attempt (Stripe `trial_start` when present); deletion with carded-trial evidence stamps it too and ends as canceled | 693015fa | "the paid conversion delivered before the trialing event still uses the one trial"; "a carded trial that ended before any grant event" |
| C-680-4 metadata-bound attempt ends as churn | The metadata bind sets `stripe_checkout_session_id` to the subscription id and the first PaymentIntent id (live read expands the first invoice: `retrieveSubscriptionForCheckout`) | 693015fa | "C-680-4: an attempt bound by the webhook fallback ends as an expired attempt" |
| C-680-7 unindexed setup_intent lookup | Not changed: needs a migration (a SetupIntent id column or index), owned by R1. Operator decision below. | — | — |
| Controls | Renewal decline still enters dunning; a decline in the sheet records the decline only | — | 2 controls, green before and after |

Size ruling: #680 is 2,927 changed lines vs #679 (+2,860 / -67). `test/b-recur-116-fix-round-3.spec.ts` (433) and `test/b-recur-fix-round-1-http.spec.ts` (357) test #679's service and HTTP surface; they moved byte-for-byte to the new tests-only R4 #696 stacked on this PR.

Four specs that assumed the old 23-hour trial cutoff now follow B-679-1 (an open trial attempt holds the one trial at any age): `test/b-recur-fix-round-1.spec.ts` R1-6 (split into no-card / saved-card cases; the retire error reuses `sub_1`, one create), `test/b-recur-fix-round-1-trial-card.spec.ts` (the unreadable-SetupIntent cleanup is checked from another plan of the coach), `test/b-recur-116-fix-round-3.spec.ts` (now in R4: `sub_1`).

Local targeted jest on the R3 tree: 14 recurring suites 223/223, plus 5 billing/webhook suites (stripe-webhook, fixtures, routing, audit, analytics) green; eslint clean on changed files; banned casts net -2 (two removed, none added).

Lens note: probes that drive invoice.paid through the real handler need `coachFirstPaymentNotification.findUnique` in the fake tx (the pre-check), and subscription events now call `retrieveSubscriptionForCheckout` in `prefetchForOuterTx`.

Outside this diff (main-era, not changed): `maybeEmitFirstPayment` P2002 can abort an outer tx; the invoice.paid prefetch warning logs the error message.

Landing obligations unchanged: never-entitled helper unified by dunning (#691, lands second); C-661-3 credential clearing by the second of #661 / recurring; trials #673 converges to one trial ledger.

Operator decision: C-680-7 index for the SetupIntent lookup. Default: follow-up migration after the stack lands (timestamp after 20270316000000), not in this stack.

Required checks at this head: 10 pass, 1 skipping (deploy-readiness-gate, not required); build-and-test passed on its one rerun after the known SBOM flake (run 37178359487, test/ci/delivery-artifact.spec.ts assert-prod-sbom, 1 failed / 12,672 passed in the failed attempt).

READY FOR AUDIT
