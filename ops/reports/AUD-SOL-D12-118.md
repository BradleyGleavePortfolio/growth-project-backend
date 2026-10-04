# AUD-SOL-D12-118 — independent dunning D1/D2 T4 audit

## Completed verdicts

Posted at **10:01:46 PDT October 4**, after an immediate full-head re-read for each PR; no head movement occurred between the reviewed candidate and posting. [D1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) [D2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)

| PR | Exact reviewed head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| growth-project-backend#687 | `f8e47bf40fe81064d679fc2831cedf3b1cd90b2c` | REQUEST CHANGES | 0/2/0 | [Posted D1 audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) |
| growth-project-backend#688 | `b17f514ccd8da195d18588ca4b7ca407a789f20e` | REQUEST CHANGES | 0/2/0 | [Posted D2 audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473) |

Claims are in `ops/lanes118/claims/backend-{687-f8e47bf4,688-b17f514c}-sol`; all candidate metadata, diffs, prior comments, checks, before/after logs, probe specs and complete posted payloads are retained in `ops/aud-118/AUD-SOL-D12-118/`.

## Prior findings: disposition and evidence

No original Sol APPROVE was reused, and no other lens's approval was adopted; both complete pieces, every fix delta and importing/dependency boundaries were independently reviewed. D2's restack contains only the lower D1 safe-error change/test and its own five-file patch remains byte-identical with stable patch-id `f120facf6a6906cd288bfa10f7bd979052b027c3`; because no verdict existed at `6718d211`, the full fix round was audited. [D1 scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) [D2 scope/restack](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)

| Prior ID | Disposition |
|---|---|
| B-687-1 | Closed: `41404998` / `7d7e7db4` put “not itself locked” before the existence limit; before regressions fail and 19/20/21/60 alternatives plus other-client controls pass now. [Builder proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5976568403) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172705221) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) |
| B-687-2 | Withdrawn as policy-only, not a claimed behavior fix: binding OR-113-4 retains existing pending migration prefixes absent a real dependency defect; this existing #628 migration references earlier tables and does not require a later migration. Ordering pins pass before and after. [Ruling and dependency proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5976568403) [Forward apply](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174418097/job/111353953626) [Schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174418106/job/111353953919) |
| C-687-1 / Opus B-687-1 | Closed: `41404998` removes first-person footer; copy regression fails before and passes now. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5976568403) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172705221) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) |
| B-688-1 | Closed at reported ABA boundary: `09d4038f` adds entered-at CAS and locked current eligibility checks; old-cycle ABA, paid-meanwhile and ordinary Day-10 probes pass. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |
| B-688-2 / Opus C-688-4 | Closed: `09d4038f` due-selection plus fair skipped-row stamp/ordering resolves the reported 501-row and skipped-page starvation cases. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |
| B-688-3 | Original feed-throw/false-push cases close via moved D1 `41404998` and separate receipts; the actual Expo error-ticket residual is now B-687-3, not counted twice as a D2 blocker. [Moved code/fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5976568403) [Original before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) [D2 regression replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) [Residual proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) |
| B-688-4 | Closed at reported newly introduced catch/outbox boundaries by `09d4038f` plus D1 safe classifier, including sensitive-sentinel checks; unchanged transport loggers are not globally certified. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |
| B-688-5 / Opus B-688-1 | Original loss-during-payment sequence closes via `09d4038f`; the distinct historical-final replay case is B-688-6 below. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) [Before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |
| Opus C-688-2/3/5 | Env/legacy-link documentation corrected with land-as-one qualification; `6718d211` fences/retries the marker race, and `09d4038f` delegates zero-decimal display to formatMinor; current regressions pass. The additional marker-race failing-before run is attributed to the builder, not independently downloaded in this lens. [Builder evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976393847) [Current](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |

Original B-628-11 remains a D3-owned settlement-classifier finding and is neither closed nor imposed on D1/D2; C-628-12's qualified at-least-once delivery statement remains the evidence boundary. [Original Sol scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972111414) [Original fix/split context](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418)

## Open must-fix findings

### B-687-3 — rejected Expo ticket reported sent

**Locations:** `src/notifications/emitters/coach-alert.emitter.ts:76–85`, `src/checkout/dunning-v2/dunning-v2.dispatcher.ts:354–378`; actual dependency `src/notifications/notifications.service.ts:579–610` returns attempt-true without checking error-ticket status. The new per-channel receipt boundary converts that boolean to successful acceptance. [Emitter](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/src%2Fnotifications%2Femitters%2Fcoach-alert.emitter.ts) [Dispatcher](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/src%2Fcheckout%2Fdunning-v2%2Fdunning-v2.dispatcher.ts) [Actual dependency](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/src/notifications/notifications.service.ts)

**Proof:** real NotificationsService, emitter and dispatcher, Expo stubbed to an error/MessageTooBig ticket, return `sent` where `failed` is expected; accepted-ticket control passes. [Executed proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917)

**Fix/verify:** honest typed ticket-acceptance adapter; error remains retryable, absent/invalid token is not acceptance; preserve feed/push/email and successful-channel idempotency. Replay `687-probe.spec.ts`, add real transport missing-token/rejection controls and composed outbox retry proof.

### B-687-4 — copy claims saving a card equals payment and access

**Locations:** `src/email/templates/dunning-v2-client.hbs:9–11`, dispatcher `:263–281`; unconditional footer/card link appears in both ordinary and dispute messages, promising payment/access and cancellation-settled debt before confirmed success. [Template](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/src%2Femail%2Ftemplates%2Fdunning-v2-client.hbs) [Dispatch data](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/src%2Fcheckout%2Fdunning-v2%2Fdunning-v2.dispatcher.ts)

**Proof:** actual late-reversal dispatch data rendered in the actual Handlebars template contains “the amount owed is paid with it and your access stays on”; the rendered acceptance assertion fails. No actual card payment was performed. [Executed render](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917)

**Fix/verify:** obligation-specific truthful copy; ordinary card saving attempts collection, access only after confirmed success, truthful Day-10/locked case; dispute copy must not equate card update or plan cancellation with settling a reversed charge and needs a real resolution route. Render normal decline/required-action, already-locked and dispute variants; ensure all body/footer clauses agree. The inherited Roman body's similar restoration promise appears in the same render, so removing only the footer is not enough to make the experience truthful. [Rendered body/footer](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917)

### B-688-6 — historical unfavorable closure poisons later cycle

**Locations:** `src/checkout/dunning-v2/dunning-v2.service.ts:1277–1288,1341–1345` unconditionally mark the current cycle, bypassing its own earlier-cycle exclusion at `1234–1254`; `keepAsDisputeCycle:1210–1223` lacks obligation/cycle applicability. [Service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b17f514ccd8da195d18588ca4b7ca407a789f20e/src%2Fcheckout%2Fdunning-v2%2Fdunning-v2.service.ts)

**Proof:** seed an ordinary locked payment cycle and old lost obligation closed thirty days earlier; before replay it is not disputed. Replaying the same closure preserves the old closed_at but produces `{disputed:true,lifted:false,lock:<day10>,entitled:false}` after immediate payment clear, instead of false/true/null/true. [Recovery outcome proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476)

**Reachability qualification:** an already-committed global event ID short-circuits, so the probe does not claim all acknowledged webhook replays reach this service. The composed D4 caller commits the dunning effect during prefetch before the global outer processed-event transaction; a later outer failure leaves redelivery possible, making effect-level idempotency necessary. This is D4 context, not a new verdict on D4. [D4 prefetch/effect order](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06307883100ec142aa2818fc30ee276cab26c1ec/src%2Fcheckout%2Fcheckout-webhook-handler.service.ts) [Global transaction/dedup](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b17f514ccd8da195d18588ca4b7ca407a789f20e/src/billing/billing.service.ts)

**Fix/verify:** under the state lock use merged obligation, preserved closure timestamp and exact current-cycle applicability before writing the marker; old-final replay must be effect-no-op for a later unrelated cycle. Preserve current lost/open protection and conflicting finals; delayed first-close association must not use processing-now as evidence. Replay `688-probe-v2.spec.ts`, plus before/after-payment, current-loss, won and conflicting/order controls.

### B-688-7 — null-first capped status selection hides lock

**Location:** service `:1519–1535` uses plain DESC locked_at, take10, then eligibility/locked selection; the fake `test/support/dunning-v2-fake-prisma.ts:287–293` incorrectly implements plain DESC null-last. PostgreSQL defaults DESC to NULLS FIRST. [Read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/b17f514ccd8da195d18588ca4b7ca407a789f20e/src%2Fcheckout%2Fdunning-v2%2Fdunning-v2.service.ts) [Fake](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f8e47bf40fe81064d679fc2831cedf3b1cd90b2c/test%2Fsupport%2Fdunning-v2-fake-prisma.ts) [PostgreSQL contract](https://www.postgresql.org/docs/16/queries-order.html)

**Proof:** actual service with a PostgreSQL-ordering delegate yields past_due for ten unlocked cycles plus one eligible locked cycle; nine plus one is the passing control. This models documented query/order/limit semantics rather than executing against a live PostgreSQL instance. [Executed cardinality proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476)

**Fix/verify:** select a scoped eligible lock before any truncation using explicit null-last plus database-side eligibility or a bounded locked-selection query; retain effective-access waiver. Correct the fake's DESC behavior in its owning D1 piece; add cap boundary, ineligible-prefix, client-scoping and grant-waiver controls. Do not increase a magic cap or remove bounded work.

## CI, size and artifact index

| Evidence | Result | URL |
|---|---|---|
| D1 candidate required checks | All 11 green; BEHIND main at final head read | [Candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174418115/job/111357578068) |
| D2 candidate stacked checks | Seven applicable required checks green; main-only CodeQL/banned casts/SBOM/Danger absent | [Candidate check inventory](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976851597) |
| D1 failing-before fix bundle | Independently downloaded: 9 fail / 5 pass | [Before D1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172705221) |
| D2 failing-before fix bundle | Independently downloaded: 9 fail / 2 pass | [Before D2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695) |
| D1 exact-source audit | Five suites: 2 fail / 72 pass; only B-687-3/4 fail | [D1 acceptance lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) |
| D2 exact-source audit v1 | Five suites: 2 fail / 63 pass | [D2 initial lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218307746) |
| D2 exact-source audit v2 | Five suites: 2 fail / 63 pass; additionally verifies failed recovery after replay | [D2 final lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476) |

Size was independently checked from GitHub and local exact-base diffs: D1 **2,489+ / 228- = 2,717**, D2 **2,313+ / 613- = 2,926**, including tests; D2 has only **74 lines** remaining before the hard 3,000 cap. Neither exceeds it at these heads, but both require operator assessment in the 1,500–3,000 band. [D1 size](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) [D2 size](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)

Evidence folder:
- `verdict-{687,688}.md`, `posted-{687,688}.json`: exact outbound payloads and receipts.
- `pr-{687,688}.json`, `comments-{687,688,628}.json`, `checks-{687,688}.json`, `d1.diff`, `d2.diff`, `file-urls-{687,688}.jsonl`.
- `before-d{1,2}.log`, `probe-{687,688}.log`, `probe-688-v2.log`.
- `687-probe.spec.ts`, `688-probe.spec.ts`, `688-probe-v2.spec.ts`: test-only regressions; use the v2 D2 probe for the complete blocked-recovery assertion.
- Exact-source CI commits: D1 `dcf14dcf9101093feebb9b1103659693351d622f`, D2 v1 `23c193a3725566d1110413e463e8a5b48d17915c`, D2 v2 `132dbbb94724c4f97c112467735fb2df239ae8e7`. [D1 lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) [D2 v1 lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218307746) [D2 v2 lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476)

Audit lanes modified only auditor test/throwaway CI inputs, not candidate source; no heavy local tests/builds, production access, money calls, flags, settings, merge or deployment actions were performed. The proofs do not establish live provider delivery, real multi-node lock behavior or complete D3/D4/D5 integration. [D1 executed boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218308917) [D2 executed boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218555476)

## Follow-ups (C)

No new optional C findings; both verdicts are 0/2/0. Cross-piece dependencies needed to make B fixes truthful are explicitly identified rather than duplicated as independent blockers. [D1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) [D2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)

## Operator decisions — recommended defaults

1. Route B-687-3/4 and B-688-6/7 to the next D1/D2 builder; retain the freeze on unrelated Cs.
2. **Default: keep the logical split while complete fixes/tests fit; coordinate a logical re-cut if D2 exceeds 3,000, never waive the cap or omit evidence.** Refresh size assessment for the changed pieces.
3. **Default: retain the existing pending migration prefix under OR-113-4** absent a concrete dependency-order defect; the policy-only prior B was withdrawn, not magically fixed.
4. **Default: land as one #687 → #688 → #689 → #690 → #691, deploy only after D5, then mobile #352–#354**, after fresh dual-lens verdicts and composed main-based gates; no individual green stacked check authorizes deploy. [Binding operator landing rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975773031)

## HANDOFF

Both required verdicts are posted at exact reviewed heads, REQUEST CHANGES 0/2/0 each; fresh builders should replay the saved tests, fix the four Bs, restack within size limits and obtain fresh dual-lens review. [D1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982357490) [D2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)

At **10:04:02 PDT October 4** (from `TZ=America/Los_Angeles date`), the three owned remote audit branches `audit/AUD-SOL-D12-118/{687-acceptance,688-acceptance,688-acceptance-v2}` were deleted successfully. Final local source-delta checks show only the prior/new auditor specs, no source-file delta from either candidate. All local evidence and worktrees are preserved for the next lens; no candidate branch was pushed. Job complete.
