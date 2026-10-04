AUDIT GPT-6.1 Sol — growth-project-backend#676 @ 564f33bf1469e483a253df29ecaac750c5c43a22 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/2

## Scope, independence and prior findings

Full-depth T4 review of every line of the 2,799-line M3 diff, including the 1,638-line Money service, queries/folds/export, self-only guards/controller, Connect state/refresh/payout changes, public fixed-target HTTPS landing, module wiring and changed production-writer/fixture specs; no other PR audited and no candidate-source edit. [Exact M3 scope and size assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975773022)

No wholesale prior Sol APPROVE is reused: original #641 never reached Sol APPROVE, the inspected M3 source/read-model specs are byte-identical to FIX ROUND 5, and this is a fresh full-piece audit with explicitly scoped prior-closure evidence rather than the other lens's verdict. [Prior Sol history](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972111823) [Original fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972277703)

- Original **B-641-1/2/3/4 remain closed on their stated boundaries**: sent-link metadata reads sent attempts, lost chargebacks are not paid/new clients, currency-scoped totals/MRR do not add raw cross-currency cents, and recurring cadence is normalized; B-641-5 belongs to the independent package piece and is not audited here. [Earlier closure record](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5963205655) [Current source](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.service.ts)
- Original **B-641-6 remains closed on first-success timestamp selection, pending→success completion and redelivery timestamp stability**; the new finding below concerns reallocating immutable cents between different completed refunds, not the closed timestamp defect. [Earlier disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5964824477) [Current real-writer controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171574493)
- C-641-2's exact-candidate fee/renewal/dunning integration and the other lens's C-641-13 payout actionability are carried as C-676-1/2 below, not duplicated as material findings belonging to unrelated PRs. [Prior composition condition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972111823) [Prior payout note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972121356)

## B — must fix

### B-676-1 — a later partial refund rewrites earlier Money/tax cents

`src/coach-money/coach-money.service.ts:408–445,1006–1023,1061–1075` loads all succeeded refunds/lost disputes and reallocates one cumulative `reversed_cents` proportionally over their client-refund amounts, assigning rounding remainder to the newest event; this is not the immutable per-event amount that the writer applied, and subsequent events retroactively move cents between reporting dates. [Allocation and event loading](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.service.ts)

The independent real refund writer→real Money query/fold/CSV probe uses a 4,900-cent purchase with a 4,802-cent destination slice: a 99-cent first refund posts **97 cents**, a later 101-cent refund posts **98 cents**, and the local ledger correctly accumulates **195 cents**, but the first day's previously reported net changes from **−97 to −96 cents** and its tax CSV changes. [Executed historical-cent counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171574493)

Thus aggregate lifetime parity is insufficient for the advertised occurrence-window invariant: the first completed event's amount changes even though its own timestamp, receipt and posting did not. [Window contract and folds](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.service.ts)

**Minimal fix rule:** derive window/export amounts from durable event-specific ledger postings, or a deterministic replay of the exact charge-scoped writer arithmetic with verified immutable per-event attribution, rather than re-weighting an ever-changing total; preserve exact-cent lifetime/window/CSV parity and cover unequal sequential partial refunds, rounding, later events, lost disputes and delayed/unrecorded head-coach reversals. [Affected reporting boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.service.ts)

The probe's first attempt stopped on a bad 100-cent fixture control caused by the unchanged legacy writer's floating-point floor; that control was corrected to unambiguous 99/101-cent real-writer values, and only the replacement run is claimed as proof of this historical reallocation defect. [Initial attempt](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171380744) [Final acceptance failure](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171574493)

### B-676-2 — new Connect refresh handler sends exception/provider text to logs

`src/coach-connect/coach-connect.service.ts:220–223` interpolates arbitrary `Error.message` or the thrown value into Logger.warn when the new `refreshStatus` operation fails; the independent canary reaches the real logger while the response correctly reports `refreshed:false`. [New refresh catch](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-connect%2Fcoach-connect.service.ts) [Executed canary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171574493)

**Minimal fix rule:** use a closed catalog/fallback with ids and safe correlation only, never exception text, arbitrary provider codes or raw exception objects; include the called `ConnectService.syncFromStripe` failure branch in sink review so a provider error swallowed there cannot bypass redaction before this catch, and prove arbitrary message/name/code canaries are absent while mirrored-status fallback stays usable. [Affected new caller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-connect%2Fcoach-connect.service.ts)

## C — carried / nonblocking

### C-676-1 — exact release composition (carried C-641-2)

`src/coach-money/coach-money.service.ts:989–1024,1196–1203,1495–1508` must be integration-tested against the exact fees/per-renewal/recovery and dunning-v2 send-record writers when the money train is composed; the passing legacy production-writer fixtures cannot certify those later inputs, and this is an operator release condition, not a blocker attributed to those other PRs here. [Relevant read contracts](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.service.ts) [Existing condition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972111823)

### C-676-2 — failed payout reason lacks an app-owned next action (carried C-641-13)

`src/coach-connect/coach-connect.service.ts:132–142,311–318` now correctly chooses `failure_message` before the generic payout description, but a closed bank account still yields provider English without an app-owned code/action; prefer a closed failure-code mapper with “Update the bank account in Stripe” and a bounded unknown fallback while preserving a useful payout reason. [Mapper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-connect%2Fcoach-connect.service.ts) [Existing optional disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5972121356)

## Evidence, piece safety and limits

Final one-job lane executes **2 failed acceptance assertions / 20 passing candidate controls** over exact candidate source plus audit-only specs/workflow; CI execution SHA is `74f36dc9179f1274568be67189ec61ed5eddd353`, not an approval or candidate implementation SHA. [Final probe run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171574493)

Queries are self-scoped to authenticated req.user.id, student and active-sub-coach guards are present, and the public onboarding landing uses fixed app URLs without reflecting tokens/account data; controller/module source does not import a later piece. [Self-only API](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fcoach-money%2Fcoach-money.controller.ts) [Fixed public landing](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/564f33bf1469e483a253df29ecaac750c5c43a22/src%2Fconnect%2Fconnect-onboarding-return.controller.ts)

Applicable stacked checks are green; CodeQL, danger, banned casts and SBOM do not execute until the stack is assessed against main, so no full main-merge eligibility is claimed, and M1 findings are not duplicated on this dependent piece. [Exact-head checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676/checks) [Operator land-as-one instruction](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-5975773022)

The larger service unit suite is intentionally in M4, while this piece carries real-writer/payout/Connect controls; the final combined stack must retain those tests and green required main checks, and these probes are synthetic-provider/database-double/HTTP evidence, not live money movement, live Postgres, device acceptance or release acceptance. [Piece boundary and test placement](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676)
