AUDIT GPT-6.1 Sol — growth-project-backend#680 @ 216489ff5fa707147b50ef0e387aba5b3079e4b1 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/1

Agent 119 · AUD-SOL-R34-119 · independent T4 audit of the full 11-file R3 own diff (2,766 changed lines), the final authority/trial/locking changes, and BillingService completion, fanout, first-payment, refund/dispute and dunning boundaries; no runtime code was changed for the probes. [Candidate and tier](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680) [Independent execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856).

### Prior findings first

The reported B-680-1 concurrent unpaid/period-change cases, B-680-2 already-past_due residual, B-680-3 unreadable conversion, B-680-4 trial consumption, B-680-5 own-card/end-lift, B-680-6 purchase/FK lock compatibility, and B-654-1/logging counterexamples pass in the independent replay: **10 suites / 111 tests**, including the runner-only real-Postgres window and two reminder FK inserts, without 55P03. [Replay run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856).

However, **B-680-1 and B-680-2 remain open on the additional counterexamples below**, which produce seven assertion failures while all twelve prior authority controls still pass. [New boundary run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).

The dead Sol authority probe was replayed with only its attach expectation updated to require `liftTrialEnd: true`; the prior legacy first-payment fixture and real-Postgres adapter shims were reviewed and used explicitly, not represented as unchanged probes or live full-schema/provider acceptance. [Round-6 shape and shim disclosure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676) [Independent replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856).

### B-680-2 — residual: a paid-invoice write can also make the exempted transition into past_due

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:1905–1913`, the `enteredPastDue` exception to the write-version fence. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).

**Executed counterexample:** purchase is still `active` when decline prefetch reads invoice A `open`; A then pays, while a newer unpaid invoice keeps the live subscription `past_due`; `invoice.paid(A)` writes `past_due`, clears the error and resolves dunning; delayed decline A passes the exemption because the row changed from `active` to `past_due`, writes the old decline text and calls `recordFailure` for the now-paid A. [Failing “B-680-2 residual R119” probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).

**Minimal fix rule:** a status transition is not evidence that the intervening write was the same unpaid invoice's subscription-update event; redeliver after every superseding write unless durable invoice-bound provenance proves that specific safe exception.

**Recommended default:** remove the status-only exception and accept one safe redelivery, retaining normal open-invoice dunning; do not accept the current narrower exception.

**Verify:** new active-to-past_due paid-write case, existing already-past_due residual, genuine subscription-update-first order, and ordinary open latest-invoice decline.

### B-680-1 — residual: terminal/revoked authority is incomplete and depends on prefetch timing

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:96–103,1305–1308,1754–1756`; `purchaseHasEnded` excludes `refunded` and `chargeback_lost`, and invoice.paid preserves even recognized canceled/expired rows only when the revision changed during its read or live Stripe is also ended. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).

**Executed counterexamples:** live subscription updates change refunded/lost revoked rows to `active/true` and seed content (two failures); paid invoices prefetched after canceled/expired/refunded/lost revocation also restore `active/true` and seed content (four failures), while preserving the charge settlement descriptor. [Six terminal-boundary assertions](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).

The actual refund/dispute handler writes `refunded/false` (`refund-dispute-handler.service.ts:301–302`) and `chargeback_lost/false` (`:940`), without canceling the subscription in those writes; a delayed **old paid invoice for the reversed charge**, not a new purchase, can therefore still read a live active subscription and undo revocation. [Candidate refund/dispute integration](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).

**Minimal fix rule:** terminal/revoked local authority wins before every subscription/paid-invoice grant, independent of when prefetch began; preserve paid-invoice financial reconciliation separately from access restoration, and retain refund/lost/ended history.

**Composition rule:** preserve the final fees stack's R-DISPUTE-PAUSE marker too: dispute ends access and pauses all plan billing, and closure must not automatically restore access; the coach restarts separately.

**Verify:** both prefetch-before and prefetch-after revocation, including delayed old invoice paid after full refund/lost dispute; keep normal first grants, genuine new-purchase grants, and exact-charge settlement controls.

### C-680-7 — retained optional indexed SetupIntent lookup

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:785–791`; metadata-first attachment is fixed, but Stripe's own pending-intent fallback still filters `stripe_client_secret startsWith` without a dedicated indexed SetupIntent id. [Round-6 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676).

**Fix rule:** follow-up additive migration newer than `20270316000000` storing/indexing SetupIntent identity, with representative lookup-plan proof; do not spend this frozen fix round on unrelated cleanup.

### Evidence, scope and CI

- Probe-only `ff82575ac71484840936458000e8f2faa6eb91b7` plus wrapper `a5c6d07bda17af159aa8b51162eb0e21504432f1` passes 111/111; additional test-only `d2e87ddd98f0bff1322ae1b6244e302b5d89f506` plus wrapper `0e4a3a66c805d34e743505c48dc4bd5991823f95` fails **7 assertions / 12 passes**, with no compilation/fixture/runner failure or product-source patch. [Replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856) [Failing boundary proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).
- No original #654 Sol APPROVE is inherited; this verdict is an independent current-piece audit, not adoption of the other lens's verdict. [Prior Sol record](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5977195657).
- Emitted applicable PR checks are green at this exact head, with the nonrequired deploy-readiness gate skipped; CodeQL, danger, Banned cast tokens and build-sbom remain absent on the stacked base, so this is not a composed-main merge or release attestation. [Exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224655542/job/111501711383).
- No new migration/dependency/later-piece import is introduced by R3, and the tests-only R4 own delta is audited separately rather than inheriting these runtime blockers. [R3 scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680) [R4 scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696).

**Operator default:** keep the recurring train unmerged, close B-680-1/2 with failing-before/passing-after cases, retain own-card/deletion and NO KEY UPDATE fixes, and obtain both exact-head verdicts after the fix and the final fees restack. Report and saved probe bundle: `ops/reports/AUD-SOL-R34-119.md`, `ops/aud-119/AUD-SOL-R34-119/`.
