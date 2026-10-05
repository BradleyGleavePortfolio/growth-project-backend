# AUD-SOL-DUN1-122 — GPT-6.1 Sol, agent 122

## Scope and clock

Started Monday 2026-10-05 15:12:40 PDT, from `TZ=America/Los_Angeles date`; total deadline 16:27:40 PDT. Part 1 is #725; parts 2/3 are the dunning train #687 → #688 → #704 → #705 → #724 → #689 → #690 → #691. No other lens's current-round report or comments have been read.

Common brief and only this job's JOBS122 entry were read; SoT A1, A2 overrides and A5 rules 11/12 were read.

## Access and evidence

Default gh/git proxy authentication failed. `gh api --hostname github.com` works for public reads with `api_credentials=["github"]`; use that explicit hostname for reading. Git's proxy URL rewrite still fails even with a per-command direct origin URL, so no further remote git retries are planned. The required SoT pull failed; the latest main SoT was subsequently retrieved via public REST and the required sections re-read, resolving source freshness. Exact GitHub source archives were fetched through the working REST route and expanded read-only under `wt/AUD-SOL-DUN1-122-{725,724,691}`; no registered git worktree or CI branch has been created.

Evidence lives in `ops/aud-122/AUD-SOL-DUN1-122/`; API output and source archives are preserved. No code edits, local tests/builds, PR-branch pushes, merge, deployment or production interaction.

Auth probes under the operator's explicit five-minute retry instruction: 15:25:05, 15:31:01 and 15:37:47 PDT each returned 401. At 15:37:47 PDT public `api.github.com` also reached the shared anonymous rate limit (403); do not repeat those reads until auth returns. Local git metadata works for prefetched refs; full source archives already preserve the relevant code.

Operator 15:41 mail said authorization is restored, but this worker's fresh injected-credential probe at 15:44:46 PDT still returned proxy 401; the alternate direct-host user probe at 15:45:03 PDT remained anonymous/rate-limited (403), and connector discovery still returns CONNECTED/CLI-only. Operator notified that parent authorization may be refreshed while this worker's context is stale. #725 payload remains ready for parent publication after head verification.

## Part 1 — #725

Reviewed exact head `1dbc59b690119f03f010e406f9f1e0e43d1e6556`, 117 changed lines. Verdict APPROVE, A/B/C = 0/0/0, in `ops/aud-122/AUD-SOL-DUN1-122/verdict-725.md`; head rechecked immediately before POST at 15:16:17 PDT, but POST failed HTTP 401 Requires authentication. No verdict comment URL exists. Operator notified through `ops/lanes122/notify/AUD-SOL-DUN1-122-auth.txt`. [Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725).

JWT/student-role guards and client/assigned-coach thread scoping survive the exact-method dunning allow-list; intentionally free basic handlers carry no extra entitlement guard. [Controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dbc59b690119f03f010e406f9f1e0e43d1e6556/src/messaging/client-messaging.controller.ts), [service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/1dbc59b690119f03f010e406f9f1e0e43d1e6556/src/messaging/messaging.service.ts).

CI snapshot at 15:24:03 PDT: all 11 mandatory checks green, including build-and-test and every live suite; deploy-readiness skipped. [PR checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725/checks).

## Train review in progress

Starting source snapshots: D1–D2d at `e77a8d360f7a7ad02cf465b525eeed648a3a7825`, D3–D5 at `e0afe6780e5954b20e88cfaefd63f12cd31d218d`. Own prior Sol findings read in AUD-SOL-D6-120 and AUD-SOL-D34-118. Only normal-use Bs and changed lines will be checked; operator-reclassified edge findings are deferred without further analysis.

Read #687's prior-approval delta: the inquiry/dispute copy and email subject no longer assert a reversal. [Reviewed delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/f3c7fd37777ef1cde75ec5fb984edf5cb973f864...d86b31a67e1d89352c3e92dde674cb4d45a25a1a).

Own B-705-1's durable pause check ignores the rollout flag; own normal-use B-705-5's restart writes the resumed subscription's status and access period, removing the old `disputed`/`chargeback_lost` guard rejection for a normally active resumed plan. [Durable read and restart](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/dunning-v2/dunning-v2.service.ts).

The #724 lockout waiver now shares `hasOtherLiveAccess` with the client status projection; same-package restart checks another live plan before resuming; coach identity is checked before any provider action. [D2d changes](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/724/files).

Own prior B-705-2/3/4, B-689-1/4/5/6 and B-690-1/2/5/6/7: C (edge, deferred to 10k clients), per the operator's binding reclassification; no edge probes/analysis performed.

Two additional normal-use candidates were identified after the initial snapshot review: B-689-S1 and B-690-S1 below. These are not fresh-head train verdicts: builder restack is still in progress.

### B-689-S1 candidate — inquiry cancellation asserts a bank reversal

**Normal-user story:** A client whose bank opens an inquiry without reversing the payment cancels the paused plan and is told the bank reversed their money.

`client-billing.service.ts:1643–1645` at the starting #689 head appends “Ending the plan does not settle the payment your bank reversed” whenever `disputeOpen` is true. Inquiry `charge.dispute.created` follows the ordinary initial dispute path, records `warning_*`, mirrors the purchase to `disputed`, and D2c/D2d sets the active dispute-pause marker; `cancelPlan` treats that active dunning cycle as delinquent and takes the dispute branch, so the statement appears on a normal sequential cancellation. [D3 cancellation path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/bb992fedf0095446f916f3261742bd262c3d94da/src/checkout/client-billing.service.ts), [inquiry/dispute recorder](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/refund-dispute-handler.service.ts).

Minimal rule: neutral “payment dispute or inquiry” wording for this response, consistent with the newly corrected #687 copy, without claiming a reversal for an inquiry. No edge condition or probe is involved. Builder/operator notice saved as `ops/lanes122/notify/AUD-SOL-DUN1-122-inquiry-copy.txt`; count only after checking the upcoming actual READY head.

### B-690-S1 candidate — no coach restart HTTP operation

**Normal-user story:** A client's bank dispute pauses the plan, the coach wants to restart it, but the backend offers no coach restart operation, so the client stays locked out and billing stays paused.

The only `restartAfterDisputePause` occurrence in #724's entire `src/` tree is its service definition at line 1505, while D4's `DunningStatusController` exposes only client GET status and its module registers only that controller. D4's `ClientBillingController` likewise contains client card/quote/cancel operations, not a coach restart. [Restart transition](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/dunning-v2/dunning-v2.service.ts), [D4 status controller](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06307883100ec142aa2818fc30ee276cab26c1ec/src/checkout/dunning-v2/dunning-status.controller.ts), [D4 module wiring](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/06307883100ec142aa2818fc30ee276cab26c1ec/src/checkout/dunning-v2/dunning-v2.module.ts).

The separate existing `POST subscriptions/:id/resume` is scoped to the purchasing client and refuses `entitlement_active=false`, so it cannot supply this coach-only dispute restart. [Existing voluntary-resume service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/subscription-checkout.service.ts).

Minimal rule: authenticated, coach-role, own-purchase HTTP route invoking the existing coach-checking service, with ordinary positive and foreign-coach negative controls. D4 owns API/module wiring; if a separate piece supplies the endpoint, name that exact launch dependency instead. Notice saved as `ops/lanes122/notify/AUD-SOL-DUN1-122-restart-route.txt`; recheck actual composed READY source before counting.

### Starting exact heads (not fresh-round attestations)

| PR | Exact head |
|---|---|
| #687 | `d86b31a67e1d89352c3e92dde674cb4d45a25a1a` |
| #688 | `2662d01a82c267f00af27566e3984d58fb0996d1` |
| #704 | `764af2e1df66612c503427016f83c3d1776cfdc0` |
| #705 | `2a03d7dd1d39e2553df10f4d7e10ecdb025807aa` |
| #724 | `e77a8d360f7a7ad02cf465b525eeed648a3a7825` |
| #689 | `bb992fedf0095446f916f3261742bd262c3d94da` |
| #690 | `06307883100ec142aa2818fc30ee276cab26c1ec` |
| #691 | `e0afe6780e5954b20e88cfaefd63f12cd31d218d` |

These were retrieved from public REST PR metadata; #687 and #689 remained unchanged at 15:24:03 PDT, and no B-DUNR3-122 READY comment or notify file existed. [Foundation PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687), [D3 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689).

### Prepared files, pending builder READY

Every requested `verdict-<n>.md` now exists in `ops/aud-122/AUD-SOL-DUN1-122/`. #725 is final source approval waiting only on authenticated posting; the other eight explicitly say **BASELINE DRAFT ONLY — DO NOT POST**, carry starting heads, and must be replaced/updated after builder READY.

Provisional baseline counts: #687 0/0/3; #688 0/0/1; #704 0/0/0; #705 0/0/4 (ordinary B-705-5 closes in mandatory #724 composition); #724 0/0/0; #689 0/1/4 (B-689-S1); #690 0/1/6 (B-690-S1); #691 0/0/0. These are not published attestations or a merge permission. Frozen Cs are one-line carryovers, not re-investigated findings.

## Launch obligation outside this round

Full-refund recurring-billing pause is explicitly assigned to a separate later piece by the prior builder/owner ruling, not delivered by this train's current source: refund handling ends access but contains no subscription pause or coach-restart marker. Treat this as an operator launch-path dependency, not a B charged to an unrelated slice. [Refund path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e77a8d360f7a7ad02cf465b525eeed648a3a7825/src/checkout/refund-dispute-handler.service.ts), [prior builder boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895).

Recommended default: confirm the later owning full-refund piece before enabling the entire day-1 money flow; do not expand this read-only audit into implementation.

## HANDOFF

CONTINUING on operator mail received 15:25 PDT: remain active despite session-wide 401, retry `gh api user` every five minutes, review local/raw/public REST sources, preserve `verdict-<n>.md` files and post when auth returns. Latest normal-host auth probe 15:44:46 PDT still failed 401 despite the operator's 15:41 recovery mail. Original 16:27:40 PDT total deadline remains.

#725 is independently APPROVE / 0/0/0 with all mandatory CI green, but authenticated POST failed; no verdict comment URL exists. No current-round train verdicts were posted because the builder has not produced READY/new heads.

B-689-S1 and B-690-S1 are normal-use candidates pending fresh-head inspection; the initial “no new B” conclusion is superseded by the documented ordinary paths. Normal-use prior B-705-1 and B-705-5 are repaired on the initial composed D1–D2d source; frozen findings remain one-line C dispositions. This lens will inspect builder READY's exact-head deltas and tree evidence and publish one verdict per train piece, without re-opening frozen edge work.

Operator defaults: (1) restore GitHub authorization now, (2) publish #725's exact prepared approval before landing it, (3) keep the existing already-built D2d edge fixes rather than spend another round removing them, (4) track the separate full-refund-billing-pause launch obligation to its owning piece.

All evidence and source archives are retained. No registered git worktree, local/remote audit branch, CI lane run, or lock was created; claims remain completion/reading evidence. No source modifications or external mutation succeeded.
