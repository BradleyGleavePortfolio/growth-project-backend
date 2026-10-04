AUDIT GPT-6.1 Sol — growth-project-backend#676 @ cf5ef18b6d6f892ce6d7b975539f4ea31730286e — VERDICT: REQUEST CHANGES

A/B/C = 0/2/1

Lens AUD-SOL-CM1-117, agent 117. Independent full-depth T4 audit of the complete 2,964-line M3 piece, 1,688-line Money service, all query/fold/CSV paths, tenancy guards, Connect state/refresh/payout copy, public HTTPS landing, source-aware writer interface and every changed spec; no candidate-source edits. [Exact candidate/FIX ROUND 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5976568778)

## Prior findings and evidence applicability

No prior Sol APPROVE on original #641 is inherited wholesale; this is a fresh piece review and fix-round closure check, not the other lens's verdict. [Previous Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975860399)

- **B-676-1 closes on the reported unequal sequential-refund/history boundary:** the immutable postings retain 97/98 cents from the real 99/101-cent refund writer, the first window/CSV is unchanged, and lost-dispute/head-coach/lifetime-sum controls pass. [Independent rerun of original Sol acceptance probe and moved M4 controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465) This is not certification of the CSV client-refund amount column, which the distinct failure below disproves. [Executed new CSV counterexamples](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
- **B-676-2 closes:** both refresh and delegated `syncFromStripe` logging avoid exception/provider text while preserving mirrored fallback, and the original Sol canary plus candidate two-sink tests pass. [Current independent execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
- **C-676-2 (= C-641-13) closes:** failed payouts now use app-owned known-code copy with a bank/Stripe action and a bounded unknown fallback instead of provider message/description; payout controls pass. [Current mapper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-connect%2Fcoach-connect.service.ts) [Passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
- Original **B-641-1/2/3/4/6** stay closed on sent dunning-link time, lost-chargeback state, currency/cadence and stable refund-success time; MRR now excludes `trialing` and reports separate trial count/value, but the required never-billed churn exclusion is missing below. [Real-writer and MRR controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
- The new **B-674-10** is attributed only to the lower writer piece; this comment does not duplicate it in M3's B count. [Independent lower-piece counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177598709)

## B — must fix

### B-676-3 — CSV client-refund amounts use posting time as event identity, duplicating or dropping real refunds

**Where:** `src/coach-money/coach-money.service.ts:428–431` attaches the client's entire refund amount to every slice posting; `:869–871` groups by purchase/charge/**posting timestamp**, then assigns rather than uniquely attributes that amount; `ReversalPortion:393–400` discards the source id available on the posting. [Current posting/CSV implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts)

**Three independently executed actual-writer counterexamples:**

1. One 2,450-cent refund of a 4,900-cent team sale posts destination/fee at time T and head-coach recovery only **1 ms later**: CSV `client_refunded` is **24.50 + 24.50 = 49.00**, although exactly one refund exists and all ledger/summary net controls remain correct. [Real writer→query→CSV latency probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
2. Head-coach recovery delayed two hours into the next window reports **another 24.50 client refund** there, although no client refund occurred in that window; the fee/head movement is legitimate but the duplicated client amount is not. [Delayed recovery probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
3. Two distinct 99/101-cent refunds completed in the same millisecond merge into one CSV row showing **1.01 rather than 2.00**; the immutable destination postings correctly remain [97,98] and net correctly sums to −1.95. [Distinct same-time refund probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

**Minimal fix rule:** carry stable `(source_kind, source_id)` identity through allocation/export, distinguish client refund occurrence from later slice-recovery postings, and report each client's refund/chargeback amount exactly once at its own event time; do not use timestamp equality to identify an event or repeat its entire client amount on later recovery rows. [Affected allocation and CSV path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts)

**Verify:** the three B-676-3 assertions in `test/audit-sol-cm1-117-money-boundaries.spec.ts` must pass unchanged; retain exact-cent net/window/lifetime/history parity and cover distinct same-time disputes as well. [Failing acceptance assertions and passing parity controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

### B-676-4 — churn still counts a trial client who never paid

**Where:** `src/coach-money/coach-money.service.ts:1271–1279,1335–1345` selects any positively priced canceled purchase and counts the client if no current paying purchase exists; positive listed price is not evidence that a trial ever billed. [Current churn query/fold](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts)

**Executed counterexample:** one canceled genuinely paid client and one canceled never-billed trial, both with a 4,900-cent price, produce **churned_30d=2 instead of 1**; MRR/paying/trial-count controls are all zero and the trial has no settled charge/slice/payment. [Independent query/fold probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

This misses the supplied operator ruling that MRR and `churned_30d` exclude never-billed trials; it is not a new product decision or a finding attributed to the separate trials PR. [Current Money implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts)

**Minimal fix rule:** require durable evidence of an actual successful paid event for the canceled purchase/client-coach relationship, rather than listed amount/current canceled status, and preserve genuinely paying-client churn and the rule excluding clients who still hold another paid purchase. [Affected churn boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts)

**Verify:** retain the B-676-4 probe unchanged, add canceled-before-first-bill versus trial-converted-and-paid controls and cancel-then-new-trial/another-paid-purchase controls, and exercise the exact composed recurring/trials cancellation writer. [Current failing acceptance assertion](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

## C — carried, optional within this piece

**C-676-1 (= C-641-2):** `coach-money.service.ts:316–335,509–527,1234–1241,1517–1614` still requires exact integrated fees/per-renewal/recovery and dunning-v2 writer acceptance when the train is composed; the legacy writer fixtures cannot certify those later inputs, particularly gross/`stripe_fee` parity and native card-update send records. [Current read contracts](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cf5ef18b6d6f892ce6d7b975539f4ea31730286e/src%2Fcoach-money%2Fcoach-money.service.ts) [Carried release condition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975860399)

## Piece safety, CI and limits

Every route remains authenticated/self-scoped, students and active sub-coaches are denied by the real guard chain, and the public onboarding landing reads/echoes no request data and targets fixed app URLs; M3 imports no M4 code and adds no migration. [Candidate scope and wiring](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5976568778)

The moved posting suite was read and copied byte-identically from #677 for execution, not audited as a third PR; its SHA-256 is `33950476824673d60cc29b932dc22657f83bd7ccd7374156dc2f8d6dc88db194`, and all four moved controls pass. [Executed moved controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

The independent one-job lane has **four failed acceptance assertions / 19 passing controls**, execution SHA `2deb7870714231a3d29c2487edf35266748f10de`; only audit specs and the approved lane wrapper differ from the exact candidate. [Independent evidence run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)

Applicable stacked candidate checks are green, but CodeQL/danger/banned-casts/SBOM do not run until the combined train targets main; M1→M3→M4 still lands as one only after all findings close and final required main checks pass. [Candidate checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676/checks) [Landing instruction](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975773022)

These are real-service/query arithmetic controls with synthetic providers/database doubles; this piece's guard assurance is source tracing, not live HTTP/auth-provider, Stripe, device/product acceptance or deployment authorization. [Probe execution scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177546465)
