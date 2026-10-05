# AUD-SOL-R34-119 — recurring R3 #680 and R4 #696

## Status
DONE; started 2026-10-04 12:30:33 PDT; ended 2026-10-04 12:40:34 PDT (Los Angeles `date`). Both verdicts posted and cleanup complete.
Sol lens, agent 119; T4 independent audit. No local heavy work.

## Exact heads and CI
- #680: `216489ff5fa707147b50ef0e387aba5b3079e4b1`, +2672/-94 = 2766 lines; current checks successful (deploy-readiness gate skipped). [PR and acceptance evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).
- #696: `276610a3a3cc7877b30a3a5f1214e24c7cbb7eae`, +1910/-0; current checks successful (deploy-readiness gate skipped). [PR and acceptance evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696).

## Posted verdicts
- #680 exact head `216489ff5fa707147b50ef0e387aba5b3079e4b1`: REQUEST CHANGES, A/B/C = 0/2/1; immediately re-read unchanged head before posting, 2026-10-04 12:39:48 PDT. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983671709).
- #696 exact head `276610a3a3cc7877b30a3a5f1214e24c7cbb7eae`: APPROVE, A/B/C = 0/0/0; immediately re-read unchanged head before posting, 2026-10-04 12:39:51 PDT. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5983672143).
- PR checks were green at both unchanged exact heads; this excludes the nonrequired readiness skip and absent stacked-base CodeQL/danger/Banned cast/SBOM contexts, which remain main-composition gates. [R3 build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224655542/job/111501711383) [R4 build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225236249/job/111503416386).

## Plan and evidence
Read common instructions 119, 118, 116 in order and only assigned JOBS119 entry. Read builder B-RECUR6B-118 report; claims remain to verify. Must replay dead Sol authority probe, investigate prior B closures, examine entire R3/R4 diffs, and validate live-Stripe authority, trial own-card evidence, version fencing, webhook order, deletion and lock compatibility. [Builder round 6](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676).

## Follow-ups (C)
- C-680-7 retained: `src/checkout/checkout-webhook-handler.service.ts:785–791` prefix fallback on `stripe_client_secret` is unindexed; store/index the SetupIntent id in an additive migration newer than `20270316000000`, and demonstrate lookup scaling with representative EXPLAIN results; metadata-first avoids this fallback for the attempt-created SetupIntent, not Stripe's own pending intent. [Existing disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676).
- Outside-diff ticket candidates (not newly counted on R3): `src/checkout/dunning.service.ts:204–330,333–388` commits failures/resolution on its own client independently of the webhook tx; thread the ambient tx or use post-commit idempotent delivery. `src/checkout/dunning-v2/dunning-v2.service.ts:86–88` writes ClientPurchase on another transaction while the webhook holds its row; pass the ambient tx or run post-commit before enabling V2. [Recorded builder follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676).

## Execution and emerging findings
- Independent exact-source R3 replay: SUCCESS, 10 suites / 111 tests, including real PostgreSQL dunning FK window + both reminder rows without 55P03; probe commit `ff82575a` changes no runtime source, and copies prior Sol authority probe with only required `liftTrialEnd: true` assertion addition, prior legacy fixture shim and real-Postgres lock shim plus candidate regression suites. [Run 37228714856](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856).
- Exact R4 five-suite execution: SUCCESS, 91/91 tests, wrapper `2640c197d1f34f77b64e0404dda1556d93cdeea1`; candidate implementation unmodified. [Run 37228779131](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228779131).
- Additional independent boundary probes: FAILURE by assertions, 7 failed / 12 passed; test-only commit `d2e87ddd`, no product fixes. [Run 37228836878](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).
- Own worktrees `wt/AUD-SOL-R34-119-680`, `wt/AUD-SOL-R34-119-696` removed after preserving probes; all three `audit/AUD-SOL-R34-119/*` branches deleted locally and remotely, with no remaining remote refs. Claims remain for the posted exact heads in lanes119.
- Durable bundle: `ops/aud-119/AUD-SOL-R34-119/probes/` contains final 19-case authority file, original passing 12-case replay, PG lock shim, legacy shim and probe-only diff; `replay680.log`, `boundaries680.log`, `tests696.log`, all three comments JSON histories, posted comment drafts and URLs remain alongside.

## Findings (classification for posting)
### B-680-2 — residual remains: a paid write can also enter past_due
`src/checkout/checkout-webhook-handler.service.ts:1905–1913`: prefetch purchase status active + invoice open; invoice pays, while another invoice leaves live subscription past_due; `invoice.paid` writes past_due and resolves dunning; delayed old decline passes `enteredPastDue`, appends decline error and calls recordFailure for the now-paid invoice. This is the same original stale-decline invariant, not a new finding. [Independent failing probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).

Minimal fix: any intervening write redelivers unless its provenance proves exactly the same unpaid invoice's subscription-update transition; status-only inference cannot prove that. Default: remove the exemption and accept one safe redelivery, or use a durable invoice-bound authority marker. Verify the new active-to-past_due case, old already-past_due residual, ordinary open-renewal decline and genuine subscription-update-first order.

### B-680-1 — residual terminal authority: revoked purchases can regrant
`src/checkout/checkout-webhook-handler.service.ts:96–103,1305–1308,1754–1756`: terminal helper misses refunded / chargeback_lost, and invoice.paid applies its canceled/expired guard only when revision changed during prefetch or Stripe is also ended. Exact-head probes regrant refunded/lost rows on live subscription updates (2 failures), and canceled/expired/refunded/lost rows on invoice paid prefetched after revocation (4 failures), changing them to active/true and seeding content. [Independent failing probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).

The actual refund/dispute handler produces `refunded/false` and `chargeback_lost/false`; refunding the charge does not cancel the Stripe subscription, so a delayed old paid invoice may still read active. [Candidate runtime](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680).

Minimal fix: durable terminal/revoked authority wins before any subscription or paid-invoice grant, independent of prefetch timing; preserve known invoice settlement as separate from restoring access. Keep refund/lost/canceled/expired history, and incorporate the final fees dispute-pause marker without automatic restore (R-DISPUTE-PAUSE). Verify both prefetch-before and prefetch-after revocation, retaining normal first grant and genuine new-purchase flows.

## Prior finding disposition / evidence reuse
- B-680-1 concurrent unpaid and period-change narrow cases pass, but terminal boundary remains open; B-680-2 past_due-at-read case passes but transition-at-read boundary remains open. [Replays](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856) [New boundary failures](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228836878).
- B-680-3/4/5/6 and B-654-1/log boundaries closed on their stated counterexamples; real-PG proof is independent runner-only evidence, not full-schema/live-provider acceptance. [Replays](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228714856).
- R3 own 11-file diff read fully (955 source changes / 1811 test changes; total 2766), including inherited R1 `liftTrialEnd` integration; no original #654 Sol APPROVE exists to inherit. [Prior Sol history](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5977195657).
- R4 previous two files are byte-identical to Sol-approved `34a41818ee8aa559660304a1513661ed95d04932`; evidence reused only for that unchanged test content, with current-head execution and newly moved three files independently read. [Prior R4 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5977195253) [Current R4 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228779131).

## Operator decisions
1. Narrower past_due exemption still unsafe in one remaining transition case; recommended default: strict version fence and redelivery after every intervening write, not acceptance.
2. Deletion consumes only granted/own-card trials; recommended default: accept this proved boundary and preserve it.
3. Real-Postgres proof as a CI-lane probe; recommended default: accept the attributable runner proof for row/FK compatibility, but do not call it full-schema/provider acceptance.
4. Day-10 lockout plan view belongs to R1, coordinated with the lockout stack; recommended default: maintain ownership and add unlocked/locked past_due cancel truth tests at composition.
5. Keep stack unmerged until B-680-1/2 close; R4 tests-only approval does not approve R3 runtime. Final fees restack must preserve R-DISPUTE-PAUSE without restoring revoked access.

## HANDOFF
Posted at re-read exact heads: #680 REQUEST CHANGES 0/2/1, #696 APPROVE 0/0/0; links above. Operator should assign one R3 builder to repair B-680-1/2, replay both lenses' entire prior probe bundle plus this new 19-case file, and preserve the under-3000-line size and all moved tests. No more review work is owned by this ended lens.

Short delta after a merge-only restack onto the **final fees top** must:
1. Confirm ancestry and `git diff` from this verdict head contains only the approved lower fees/recurring merges; read every conflict resolution rather than treating a split restack as rule-12 exempt.
2. Check R3's unconditional terminal/revocation authority and final fees dispute-pause marker agree; late created/updated/paid events must not restore disputed, refunded, lost, canceled or expired access; the coach alone restarts disputed access, and all plan billing stays paused.
3. Recheck invoice version fencing against both active-to-past_due and already-past_due paid-invoice races; status-only exemption is not proof. Preserve exact-charge financial reconciliation separately from entitlement.
4. Preserve `trialOwnCardOn`, own metadata attachment, `liftTrialEnd:true` only on own SetupIntent, granted/own-card deletion consumption, package-then-NO-KEY-UPDATE lock order and real FK compatibility.
5. Verify R4 stays five tests-only files (or explain any new assertion delta), no runtime/gate changes or dropped coverage; re-run 91 cases against composed source, and R3 prior/new authority and PG proofs where lower-fee changes intersect.
6. Trace #661 credential-clearing/PI-ordering, #673 shared trial ledger, and lockout R1 planView obligations to their separately owned composed gates; require main-only checks at the landing tree and fresh short exact-head attestations for nonexempt restacks.

Nothing needed from the owner; operator defaults are listed above. Cleanup complete; all research, comments and probe evidence preserved. END.
