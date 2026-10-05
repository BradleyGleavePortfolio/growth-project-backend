# JOBS120 — agent 120 job board. Read _COMMON_120.md first. Do ONLY your entry. Heads verified on GitHub 09:13-09:27 PDT 10-05.
# Lens jobs run as a pair (Claude Opus 5.5 + GPT-6.1 Sol), independent: never read the other lens's notes or comment for this round
# before posting your own verdict. One verdict per PR per exact head. If the head moves while you work, stop and tell the operator.

## AUD-OPUS-661D-120 / AUD-SOL-661D-120 — backend #661 + #702 (secrets stack, T4) — conflict-resolution main refresh delta
Heads: #661 bc399edd5911c9c1e83e4bb1051fde05bfeda64d (base main, clean), #702 9ddda117d89f72c8d4a7a5b58a2c7ba6173053a2 (base
agent/clinic/b-secrets-3 = #661's branch). Last dual APPROVE was at #661 f80f0088 / #702 20d2eb4f (void: heads moved).
What changed: B-661R-119 (died before commenting) pushed
- 010f9b57 = merge of recurring final head 8c925944 into approved f80f0088, WITH CONFLICTS in src/checkout/checkout-webhook-handler.service.ts
  and src/checkout/checkout.service.ts (see `git show --remerge-diff 010f9b57`);
- bc399edd = clean merge of main ee55f814 (recurring landed) into 010f9b57;
- #702 9ddda117 = merge of bc399edd into approved 20d2eb4f.
No builder READY was posted; the operator posts a RESTACK note on both PRs before you start. You verify the conflict resolution
yourself: both sides' behaviour kept (#661: no client secret is returned or stored except as its round-7 contract says; recurring:
R1-R5 webhook and subscription-checkout behaviour unchanged), the reply codes the mobile sheet maps (409 PAYMENT_ALREADY_COMPLETE,
PAYMENT_REFUNDED_OR_IN_REVIEW, PAYMENT_CHECKOUT_CLOSED; 503 PAYMENT_IN_PROGRESS; PAYMENT_SUCCESS_RETRY / PAYMENT_FAILURE_RETRY) and
the recurring codes still reach the client, C-661-3 / C-656-1 combined behaviour (whichever merges second carries it: #661 is second).
Replay your previous probes (ops/aud-*/ for #661/#702 from agents 116-119) on the composed tree in a CI lane, plus at least one new
probe on the conflicted hunks. Size: #661 is grandfathered (2,849 / 3,000 ceiling). Verdict on BOTH PRs at the exact heads.
Recommended scope: delta review (conflict hunks + every recurring line the merge touched in those two files), not a full re-review.

## B-CM7-120 — backend coach stack #674, #676, #677, #703 (T4, stack lock: coach)
Heads: #674 9e8a3a6b (base main, BEHIND main ee55f814), #676 296067fb, #677 921299fe, #703 b16021ab. CI green at all four.
B-CM6-119 died before commenting. It pushed: 7a10fe1a (conflict main refresh onto fees f48267f9, 13 files), f4634d99 (move live
reversal concurrency spec + CI step to #703), 90884240 (owner reconcile records a found reversal in one transaction), fa673d6b
(B-674-14: stamped attempt with no reversal op sends only after Stripe's complete list shows none), 9e8a3a6b (reversal slot takes
base and cap from the row under the slot), merge-only restacks into #676/#677/#703, and b16021ab (B-CM6-1 spec on #703).
Do: (1) read every coach lens report and comment (AUD-*-CM*, B-CM*-11x/119 reports, PR comments) and reconstruct which A/B findings
B-CM6 was fixing; verify 7a10fe1a's conflict resolution and each fix commit against those findings; (2) merge main ee55f814 into #674
(merge-tree shows no textual conflicts; still check semantic overlap with recurring in checkout/connect code), then merge-only restack
#676 -> #677 -> #703; (3) replay every prior probe from both lenses; money-list self-check; (4) post ONE comment per PR:
"MAIN REFRESH + FIX ROUND <n> (B-CM7-120, agent 120)" listing what 119's unreported commits do, the main merge, probe results, CI
URLs, then "READY FOR AUDIT". Sizes: #674 2,948, #676 2,984, #677 2,915 (grandfathered 3,000; check after the main merge, which may
change the diff against base), #703 838 (1,500 rule). If a merge would push a grandfathered PR over 3,000, move tests to #703 and
say so. Write ops/lanes120/notify/coach.txt when done.

## B-DUNMR-120 — backend dunning D1 #687, D2a #688, D2b #704, D2c #705 (T4, stack lock: dunning)
Heads: #687 f3c7fd37 (base main), #688 5003e7e6, #704 32d886bb, #705 279ec167 (DIRTY: conflicts with #704 in
src/checkout/checkout-webhook-handler.service.ts). No lens has ever reviewed D1/D2a/D2b/D2c at any head (B-DUNSPLIT-119 posted READY
at 13:31 PDT 10-04). The main refresh f3c7fd37 (merge of main ee55f814, conflicts in src/connect/stripe-connect-api.service.ts,
src/email/email.service.ts, src/email/email.types.ts) was pushed with NO comment; #688/#704 are merge-only restacks of it.
Do: (1) verify f3c7fd37's conflict resolution keeps both sides (fees F-stack connect/email code from main, dunning code from D1);
(2) restack #705 onto #704 32d886bb and resolve the checkout-webhook-handler conflict (dunning D2c dispute pause vs recurring R1-R5
webhook code now on main) — R-DISPUTE-PAUSE must hold on the composed tree: a dispute on any charge of a recurring plan pauses all
billing for that plan and ends access immediately; no auto-restore; (3) HARD OBLIGATION C-680-18 (Opus R34D-119, owner default yes):
dunning lands second, so the guard lands in this stack (FEATURE_DUNNING_V2 stays off until it lands): read ops/reports/AUD-OPUS-
R34D-119.md lines 30-75 and ops/op118/FOLLOWUPS.md line 81; if the guard belongs in D2a #688's applyImmediateClear, fix it there and
add its probe; C-680-19 (refund-dispute-handler.service.ts:952-956 won-dispute restore) belongs to the R-DISPUTE-PAUSE build: fix it
in #705 if not already; (4) replay probes, money-list self-check; (5) one comment per PR ("MAIN REFRESH" / "RESTACK" / "FIX ROUND",
B-DUNMR-120, agent 120), then READY FOR AUDIT. Sizes: #687 2,640 and #688 2,440 grandfathered (3,000); #704 694 and #705 1,287 are
under the 1,500 rule: #705 has 213 lines of headroom. Write ops/lanes120/notify/dunning.txt when done. Do NOT touch #689/#690/#691.

## B-TR7-120 — backend trials T5 #707, then the trials main refresh (#671 -> #707) (T4, stack lock: trials)
Heads: #671 c75002c9 (base main, DIRTY: prisma/schema.prisma conflicts with main), #672 62c2c066, #673 dcf095b8 (2,999 of 3,000),
#706 3d95f96e, #707 ffed434e (base agent119/trials-split-4-tests, 739 lines, 1,500 rule). #671-#706 are dual APPROVE at these heads.
#707 is REQUEST CHANGES from both lenses (Sol 5985426719, Opus 5985519108): B-707-1, renewal invoices still in `draft` are outside
the cancel fence (src/checkout/trial-conflict.service.ts:281-307, 521-524). Fix rule (Opus): read a complete status=draft page before
the paid list; DELETE each draft (confirm deleted:true) under the CAS renewal, before the voids; a failed delete means retry with no
DELETE; count drafts toward TRIAL_CONFLICT_MAX_VOIDS; tests for unknown or incomplete page, failed delete and ownership loss. Read both
comments in full first. C-707-2/3/4 go to follow-ups. Step 1: FIX ROUND on #707 (all tests in #707; stay under 1,500), replay both
lenses' probes. Step 2: merge main ee55f814 into #671 (resolve prisma/schema.prisma: both sides additive; keep migration order;
migrations newer than 20270316000000 rule does not apply to existing ones), run the schema-parity check in CI, then merge-only restack
#672 -> #673 -> #706 -> #707. #673 must stay at or under 3,000 after the refresh (if the refresh changes its diff, stop and tell the
operator). Post one comment per PR (FIX ROUND on #707; MAIN REFRESH on #671; RESTACK on the rest) and READY FOR AUDIT.
Write ops/lanes120/notify/trials.txt. Mobile #338 (dual APPROVE, BEHIND) is not yours.

## B-LOCK2-120 — mobile lockout #352, #353 (+ #354 merge-only restack) (T4: billing state and money copy, stack lock: lockout)
Heads: #352 ac244d22 (base main, BEHIND), #353 05d84f27, #354 f084cc0f. REQUEST CHANGES from both lenses at #352/#353 (Sol 5983776115
and 5983779129; Opus 5983819724 and 5983819833): dispute copy conflicts with R-DISPUTE-PAUSE, plus Sol's B findings. Contract: the
D2c backend #705 (head 279ec167, under restack by B-DUNMR-120: read only) exposes reason 'dispute_paused'; the app must render exactly:
access has ended, billing is paused, the coach decides on restarting; no automatic restore; never imply the client can fix a dispute by
updating a card. The app must still work against today's production backend (guide rule 5: capability check or truthful fallback).
Do: fix every A/B on #352/#353, merge main cc4ceeed (or the newest main) into #352, merge-only restack #353 -> #354, replay probes, one
comment per PR, READY FOR AUDIT. Sizes: #352 2,341, #353 2,520 (grandfathered 3,000), #354 1,119. Mobile deps: wait for
/home/user/workspace/deps/mobile/READY before running anything (read code first).

## AUD-OPUS-H7-120 / AUD-SOL-H7-120 — mobile Health Connect H7 #369 (+ Sol: #362 closure) (T4: health data, PII)
Heads: #369 3252ec79cd9ab1f28165a1913d8ae3096b590d4a (base agent115/wear-split-6-retire-samsung = #364's branch, 1,205 lines, 1,500
rule); #362 261e7d4c (Opus APPROVE 5985217014; Sol RC 5985235823 with B-362-8/9; Sol said B-362-9 closes in H7 and B-362-8 narrows).
#369: Sol RC 5985494019 at old head 35717bfe (B-369-1); B-HC9-119 posted FIX ROUND 1 at 3252ec79 (comment 5985690624: SecureStore is
the consent authority). Opus has never reviewed #369. Opus: full review of #369 at 3252ec79. Sol: delta review of FIX ROUND 1 and a
fresh verdict on #362 at 261e7d4c evaluated in the H1-H7 composition (the stack lands as one: #359 -> #369; a #362 APPROVE may be
conditioned on #369 landing in the same unit). H1-H6 #359-#364 heads are dual APPROVE except #362 (Sol). Probe in a mobile CI lane.

## AUD-OPUS-W12D-120 / AUD-SOL-W12D-120 — mobile coach setup wizard #345 + #346 (+ #347 restack delta) (T3/T4: Connect onboarding)
Heads: #345 ed29833cb2d5c597f0be3a557877bd3cf29d85a3 (base main, BEHIND), #346 26cf23b7987c866615ab9a4b2f95a10e6e318f40, #347
8437fb94 (merge-only restack of #346 into W3). Previous: Opus APPROVE at #345 97c9005e / #346 2baea5b8 (5983832209, 5983832366); Sol RC
(5983834812, 5983834774: B-345-1, B-346-3). B-WIZ2-119 posted FIX ROUND 2 at the current heads. Opus: delta since your approved heads.
Sol: verify B-345-1 and B-346-3 closure plus delta. Both: a short verdict on #347 covering only the restack (W3's own content gets a
full review later). Sizes: #345 2,726, #346 2,873 (grandfathered).

## AUD-OPUS-P12-120 / AUD-SOL-P12-120 — mobile programs P1 #355 + P2 #356 (first review)
Heads: #355 902c64a64156255ce9ce54147db896ac2142a954 (base main, BEHIND), #356 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5. READY FOR AUDIT
(operator 116, 02:26 UTC 10-04); never reviewed. Full review. Grade the tier yourself (anything touching auth, PII, money or deletion is
T4). Sizes 1,716 / 1,501 (grandfathered 3,000).

## AUD-OPUS-P34-120 / AUD-SOL-P34-120 — mobile programs P3 #357 + P4 #358 (first review)
Heads: #357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381, #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 (stacked on #356). READY FOR AUDIT
(operator 116); never reviewed. Full review of the P3/P4 diffs against their bases. Sizes 2,421 / 1,323 (grandfathered).

## B-HC10-120 — mobile Health Connect follow-up H8: late data (C-360-1) + resumable import (C-360-2) (T4: health data)
Ruling (116, binding): late-data and resumable import are a follow-up after #359-#369, before the clinic Android build. Build it now as
a NEW PR stacked on #369 (base = #369's head branch agent119/wear-split-7-signout-durable; your branch agent120/wear-split-8-late-data),
under 1,500 lines. Findings: ops/reports/AUD-SOL-H23-118.md lines 45-46 (C-360-1: healthConnectSyncService.ts:65,152-156 and
healthKitSyncService.ts:82,166-174 narrow overlaps lose late samples, e.g. a sleep record ending 07:00 arriving 07:30 after 07:15
progress; C-360-2: healthKitSyncService.ts:215,242,261 reads/posts the whole window and commits progress only at the end, Health
Connect commits a whole type pass), ops/reports/AUD-OPUS-W12-116.md line 60, B-W2-116.md line 7. Line numbers are from older heads:
re-locate them at #369 3252ec79. Design the smallest correct fix (bounded late-data re-read; first verify how the backend ingest
dedupes repeated samples and rely on it only if proven; progress committed per page/chunk so an interrupted import resumes; no backend
change in this job: if one is needed, stop and tell the operator), tests included, both platforms.
Do not change #359-#369. If H7 lenses force a FIX ROUND on #369 while you work, merge #369's new head into your branch (merge-only).
Open the PR as draft, post FIX ROUND 1 (OPENING, B-HC10-120, agent 120) with probes and READY FOR AUDIT. Wait for
/home/user/workspace/deps/mobile/READY before running anything.
