AUDIT GPT-6.1 Sol — growth-project-backend#679 @ 958806d15af64863786337699020428cd89ffaf3 — VERDICT: REQUEST CHANGES

A/B/C = 0/7/0

Full T4 review of all nine own files / 2,952 changed lines, every line of the checkout service and included tests, call sites, request/row identity, money snapshots, provider authority, cancellation/deletion races, error handling and split-boundary wiring; no approval evidence reused because this lens never approved original #654. [Exact R2 scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679) [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5965039762)

## Prior findings first

- **B-654-5 narrowed:** fixed for exact-key replay: old uncertain attempts look up the provider object before any resend, old confirmed misses expire, unreadable lookups remain retryable; **not fully closed across new-key admission**, which discards the same unresolved row by age (B-679-1). [Replay/admission implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts) [Independent exact-source probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)
- **B-654-8:** the reported recent-attempt changed-terms cancellation branch and lost-successful-cancel readback are fixed, and `past_due`/`unpaid` are not replaced; **not fully closed across stale-attempt cleanup/admission**, where failed cancellation or unavailable truth still permits a new subscription (B-679-1). [Cancellation/admission implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts) [Independent exact-source probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)
- **B-654-9 / C-654-10 error-label boundary:** closed on its reported service boundary: arbitrary name/code/message canaries are rejected by the fixed label and actual cancellation logger; no claim about the separately owned R3 webhook changes. [Fixed error-label helper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Ferror-label.ts) [Independent exact-source probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

## Findings

### B-679-1 — elapsed time is still used as proof that an unresolved subscription cannot charge

`src/checkout/subscription-checkout.service.ts:481–485, 701–715, 728–733, 1583–1615`: new-key admission excludes every attempt older than 23 hours, while stale cleanup skips unbound attempts and swallows provider-read/cancel errors. [Attempt selection and stale cleanup](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

Three independent counterexamples each produce **a second provider subscription**: a 25-hour-old unbound uncertain trial; a bound old trial whose saved card cannot currently be read; and a bound old trial whose cancellation fails. The new key bypasses the pinned-row lookup/confirmed-cancel protections and can also obtain a second trial reservation. [Three new-key age probes](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** unresolved attempts must continue to exclude replacement regardless of age; reconcile the original metadata/binding, protect paid/card-saved/in-flight plans, and expire/release a trial only after authoritative provider absence or confirmed termination. Pagination may remain bounded and fail closed; unavailable truth must block this package's replacement, not be treated as successful cleanup.

### B-679-2 — the same key returns another package's purchase and credentials under the requested package's label

`src/checkout/subscription-checkout.service.ts:423–431, 1078–1094, 1431–1435`: the replay checks client identity but not the original package/coach identity; the result takes `package_id`/name from the newly requested package. [Replay and result construction](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

Create Plan A at $49/month, then request equally priced Plan B with the same key: the response labels Plan B but returns Plan A's purchase, subscription and PaymentIntent, whose metadata/fulfilment still identify A. [Cross-package same-key probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** bind replay to the original package and coach before any recovery/provider work; reject cross-product key reuse with an actionable coded conflict, or return only the original canonical identity, never a relabelled product.

### B-679-3 — a late ephemeral-key reply repopulates credentials on a retired or already-entitled row

`src/checkout/subscription-checkout.service.ts:956–974, 1351–1367`: both mint completion and reuse perform an unconditional purchase-id-only update after the external await. [Post-await credential writes](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

The probes transition/clear the purchase during that await: active, canceled, expired on the first mint, and expired on reuse. Each late path writes `pi_1_secret_x` and an ephemeral key back and can surface a sheet after the winning lifecycle transition; cancellation includes the state/credential clearing required by account deletion. [Four lifecycle/credential probes](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** conditional update against the same subscription, open attempt state, non-entitlement, no trial start and expected lifecycle generation; reread after a lost condition and return already-active/ended/no-sheet as appropriate. Never persist or return payment credentials from the stale pre-await row.

### B-679-4 — a delayed resume response overwrites a newer cancellation

`src/checkout/subscription-checkout.service.ts:637–653`: the local update trusts the earlier Stripe response and has no state/version reproof. [Resume update](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

Resume succeeds, its response is delayed, then a newer cancel and webhook set `cancel_at_period_end=true`; when the old response arrives, this method changes the row back to false although Stripe remains scheduled to cancel, displaying a false next charge/kept-plan result. A cached idempotent resume response has the same authority problem. [Delayed-resume probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** serialize or version lifecycle commands and condition local writes on the pre-await generation; reconcile a stale/cached response with current provider/row truth instead of overwriting a newer event.

### B-679-5 — plan reads discard the immutable bought billing cadence

`src/checkout/subscription-checkout.service.ts:1440–1474`: `toPlanView` reads interval/count from today's package, while amount remains the purchase snapshot and `checkout_terms` is ignored. [Plan read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

The probe drives the real package-update service while checkout is pending (so its active-subscriber pricing lock correctly permits the edit), changes month/$49 to year/$59, then completes the original immutable monthly purchase; GET reports $49 **per year**, not the bought $49/month. [Supported package-edit/read probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** use pinned `checkout_terms` cadence/currency/amount for all native plan views, with a deliberate authoritative legacy fallback; current package metadata may supply the display name, not money terms.

### B-679-6 — uncertain provider outcomes are presented as proof that nothing was charged

`src/checkout/subscription-checkout.service.ts:1813, 1822–1834` (also the unconfirmed-setup failure at 992–997): generic provider/uncertain retry errors assert “Nothing was charged” before that fact is established. [Payment-error mapping](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

The probe makes Stripe produce an active, paid first invoice and then lose the create response; the 503 returned to the client nevertheless says nothing was charged. The copied no-charge phrase is unsafe for timeout, unreadable prior attempts and unconfirmed cancellation. [Lost-paid-create-response probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** distinguish proven refusal/no-charge from unknown outcome; unknown must state that confirmation is unavailable and provide a working check-again/plan/support path with a short reference and sanitized telemetry. Do not invite a blind fresh-key payment on an unverified no-charge assertion.

### B-679-7 — a retired attempt can still send its first create and orphan an already-paid subscription

`src/checkout/subscription-checkout.service.ts:819–869, 924–933`: no attempt-authority reproof occurs after the terms-pin await and before subscription creation; the later bind guard is too late to prevent money movement. [Pin, create and rejected-bind handling](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/958806d15af64863786337699020428cd89ffaf3/src%2Fcheckout%2Fsubscription-checkout.service.ts)

The independent deferred-response probe commits the terms pin, pauses its reply, retires/cancels the purchase, then releases the worker: it still sends create, receives an active/paid subscription, fails the pending-row bind and leaves that billable provider object unbound (it cancels only unpaid objects). [Retired-pin late-create probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131)

**Minimal fix:** re-prove/conditionally claim the original open purchase/terms generation after awaits and before sending create; a retired or deletion-canceled attempt must not send. Preserve durable provider reconciliation for an already-sent create that races retirement, rather than dropping a paid provider object and reporting an expired/no-charge checkout.

## Evidence, size and landing gates

Independent exact-source CI at `76d07c8e583ca88db1d9b01232f389fe004d1806` (candidate head + test-only commits `1e75b636` / `631ccbda` + disposable lane workflow): **12 acceptance failures across the seven findings; 12 independent prior-finding controls and all 98 candidate controls pass (110 passing / 122 total, four candidate suites green)**. The probes execute the actual checkout service and real package-update authority with synthetic stateful DB/provider boundaries and controlled await schedules, not live Stripe/Postgres. The first run was a probe-fixture type error, not a candidate failure; no assertion failure is attributed to it. [Executed replacement probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174065131) [Fixture-only run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173852052)

**Fix location / 3,000-line guard:** all seven findings originate in this R2 service; do not put their live wiring into unrelated fees/trials/dunning PRs. R2 currently has only 48 lines of headroom, and the builder put its last regressions into R3 specifically to keep R2 below the cap. [Current R2 size](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679) [Builder's size/ownership report](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976053666)

Recommended default: first mechanically extract approximately **600 existing R2 lines** of inert contracts/terms, pure error factories/read-model and isolated attempt-authority helpers into R1 #678, without an R1 import of later R2 code; restack R2/R3 under the stack lock, then fix the R2 service/helper boundaries and place new regressions in R2's freed budget. An illustrative budget is R1 `747+600+80=1,427`, R2 `2,952−600+200+370=2,922`, R3 unchanged; this is a planning allocation, not measured output. Recalculate actual additions+deletions before every push, including tests; extract more or create an operator-approved additional slice if necessary. Any changed R1 needs fresh exact-head audits.

All seven required contexts emitted at the candidate head are green; this independent adversarial result is additional evidence, not a claim that ordinary CI was red. CodeQL/danger/banned casts/SBOM remain unexecuted on the stacked base and must pass after main-based composition, with the complete fees/recurring train, R3 webhook wiring and native mobile/configuration acceptance. No other PR is audited by this verdict. [Exact-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172708421/job/111348789748) [Declared main-base/security gates](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976053666)
