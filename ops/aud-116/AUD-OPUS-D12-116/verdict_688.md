AUDIT Claude Opus 5.5 — growth-project-backend#688 @ 6627044cce3c7a210099b77b72e53f782cba2801 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/4

**Scope.** D2 of the #628 split, base D1 (`agent115/dunning-split-1-foundation` @ `c2a901a8`), 6 files: `dunning-v2.service.ts`, `dunning-v2.cadence.ts`, `dunning-v2.dispatcher.ts`, v1 `dunning.service.ts`, and the service and cadence specs. Every v2 path is gated by `FEATURE_DUNNING_V2` (OFF). With the flag OFF, two changes are live: the v1 email link default (C-688-2) and the hourly sweep schedule (which is a no-op while the flag is OFF).

**Evidence reuse (G09).** All 6 files are byte-identical to #628 @ `dc47e0ef`. `dunning-v2.cadence.ts` and both specs are unchanged since this lens's APPROVE @ `739e9a54` (comment 5957537166), so that evidence is reused. `dunning-v2.service.ts`, the dispatcher and `dunning.service.ts` changed since `739e9a54` (R4-R9: delivery claims, dispute obligations, B-628-13), so they were audited fresh. That includes checking whether this lens's B-628-13 (RC @ `33e0696a`, comment 5972127476) is closed. No other lens's verdict was read before this one.

**CI at this head.** build-and-test is green: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152162539 (tsc, 713 suites, including dunning.service, dunning-v2-service and dunning-v2-cadence). CodeQL, danger, banned casts and sbom do not run on a PR whose base is not main. They run on this content when the stack lands into #687, which is main-based.

### B-688-1 — B-628-13 is still open when a dispute is lost before the renewal is paid
- `src/checkout/dunning-v2/dunning-v2.service.ts:1187-1200` `hasOpenDisputeObligation` counts only obligations whose merged status is not final (`:1199` `!DISPUTE_TERMINAL_STATUSES.has(d.status)`). So `lost` and `charge_refunded` obligations do not count. At `:1223-1234`, `onDisputeClosed` records the lost status and returns `not_won` without touching the active cycle.
- Sequence:
  1. A payment cycle is active (decline marker).
  2. The client disputes an earlier cleared charge. `handleLateReversal` returns `cycle_already_active` (`:1049`) and records an `open` obligation, which correctly blocks.
  3. The dispute closes `lost`. This is realistic: an accepted dispute closes lost at once, and a locked client may pay weeks later.
  4. The renewal is paid. `isDisputeCycleOpen` (`:1147`) now returns false, so invoice.paid → `resolveDunningOnPaid` (D4) runs v1 `recordResolution`, and `applyImmediateClear` (`:930-937`) lifts the Day-10 lock and turns entitlement back on.
  The renewal payment has settled a disputed payment that was lost.
- In the other order (a dispute cycle first, then lost), the cycle and its lock stay. `resolveDisputeCycle` says "open, or lost, keeps the cycle", and `onDisputeClosed` says "support settles it". The two orders disagree, which is the B-628-13 defect. This lens's B-628-13 fix rule named "any open/lost row".
- Probe (CI lane; PR head + probe spec only, branch `audit/AUD-OPUS-D12-116/688-lost-dispute`): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171961725 — `test/aud-opus-d12-688-lost-dispute.probe.spec.ts`.
  - Three controls pass: an open dispute during a payment cycle blocks the clear; a lost dispute on a dispute cycle keeps the lock; a won dispute lets the payment cycle resolve.
  - Both probes fail: after `lost`, `isDisputeCycleOpen` expected true, received false; `applyImmediateClear('p1','retry')` expected `{liftedLockout:false}`, received `{liftedLockout:true}`.
- Fix rule: a not-won final close of a dispute recorded while a non-dispute cycle is active must make that cycle the dispute cycle. Preferred: in `onDisputeClosed`'s not-won branch, under the DunningState row lock, call `keepAsDisputeCycle` (CAS on the active row). Alternative: have `hasOpenDisputeObligation` also count `lost`/`charge_refunded` obligations closed at or after the active cycle's `entered_at`. A won close must still let a payment cycle resolve. Verify: the two failing probe cases pass, the three controls still pass, and the D5 e2e gains the order "dispute during a payment cycle → lost → renewal paid", by webhook and by card update.

### C (notes, not blocking)
- **C-688-2** `src/checkout/dunning.service.ts:1207`: the v1 email `billing_portal_url` default (not flag-gated) is now `DUNNING_UPDATE_CARD_URL` (`dunning-v2.cadence.ts:96`, `https://app.trygrowthproject.com/billing/update-card`). `BILLING_PORTAL_URL` is unset in production, so every v1 dunning email links to a page that only exists from D4 (#690). The PR's "deploy only after D5" covers it. `src/common/env-validation.ts:1028` still documents the old default `https://thegrowthproject.app/billing`; update it and name the link change in the PR body.
- **C-688-3** `src/checkout/dunning.service.ts:188-244`: `recordFailure` reads and then writes DunningState without a row lock. A dispute marker set by `keepAsDisputeCycle`/`handleLateReversal` between the read and the write is overwritten by the decline reason. While the obligation is open, `isDisputeCycleOpen` still answers true, so this is not unsafe today, but after B-688-1 is fixed by converting the cycle, this race matters more. Fix: a conditional write that keeps the marker (`updateMany` with `last_failure_reason` in the where clause), or the same `FOR UPDATE` lock the dispute path takes.
- **C-688-4** `dunning-v2.service.ts:779-780`: the sweep reads the oldest 500 active rows (`entered_at asc`). Rows that `tryLock` always skips (a canceled purchase on a dispute cycle at `:837`, or a purchase not past_due/unpaid at `:846`) stay at the head of the queue. With 500 such rows, no newer cycle is advanced or locked. This was already present at `739e9a54`. Fix later: exclude rows skipped for a terminal reason, or page past them; alert on the skipped count.
- **C-688-5** `dunning-v2.service.ts:1643` `formatMoney` divides by 100 for every currency. That is wrong for zero-decimal currencies; D1's `formatMinor` handles them. Only USD is sold today. Already present at `739e9a54`.

**Piece boundary.** The specs for D2's R4-R9 behaviour (dispute obligations, B-628-13 orders, delivery claims) live in D5 (`test/dunning-r3-money-truth-e2e.spec.ts`). That is acceptable while the stack lands back to back.

### Verified (no finding)
- `recordFailure` keeps the marker on an active dispute cycle and does not keep it when reopening.
- v1 `tick`/`runSweeper` skip under v2.
- `claimWithOutbox`: CAS + outbox in one transaction.
- `claimDeliveries`: CAS on status/attempts/claim_token; a takeover reuses `key_attempt`, so the email idempotency key is stable; receipts are fenced by the claim token; the sweep cancels only expired claims.
- `keepAsDisputeCycle` handles a null reason via OR.
- `mergeDisputeObligations`: a final status wins, and not-in-favour wins over won. `resolveDisputeCycle` runs under the FOR UPDATE lock. `handleLateReversal` records the obligation before reading the cycle.
- `tryLock` requires positive evidence (past_due and Stripe not paid; a Stripe error skips).
- `applyImmediateClear` joins the caller's transaction. Flag-off paths are no-ops.
- No first person, exclamation mark or emoji in new subjects or push copy.

**Outside this PR (reported to the operator, not blocking).** The same order-2 gap appears on the card-update path in D3 #689, at #628 head `dc47e0ef`. `client-billing.service.ts:581/:830` sets `dispute_open` from the marker only (`isDisputeCycle` at `:315`). So with an open obligation and a decline marker, the 1A pay runs `restoreAfterPayment` (`:1069`): entitlement on, `applyImmediateClear` correctly refuses, then v1 `recordResolution` (`:1115`, which has no dispute guard) resolves the cycle. The later invoice.paid then lifts the lock. This lens did not probe it; it is left for the #689 lenses.

Head re-read right before posting: `6627044cce3c7a210099b77b72e53f782cba2801`.
