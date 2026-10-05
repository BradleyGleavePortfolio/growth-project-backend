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

## B-WIZ3-120 — mobile wizard W2 #346 FIX ROUND 3 (+ #347 merge-only restack) (T3/T4: publishes priced offers, stack lock: wizard)
Heads: #346 26cf23b7987c866615ab9a4b2f95a10e6e318f40 (base = #345's branch), #347 8437fb94. #345 ed29833c: Sol APPROVE 0/0/0
(5998775552). #346: Sol REQUEST CHANGES 0/1/2 (5998775024): B-346-3 remains — an early tap while the $49 defaults are displayed
publishes a later-hydrated $990 offer, or publishes/binds an unseen Free offer, without fresh confirmation (Sol W2 lane
https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37341467340: 2 failing challenges). Fix rule (Sol): a
publish needs a fresh tap AFTER hydration, on the exact price/offer the coach sees; any hydration that changes price or offer type
invalidates a pending tap. Also fix every A/B in the Opus W12D-120 verdict on #345/#346 (read it first; if Opus found an A/B on #345,
fix it there too). C-346-1 / C-346-4 stay follow-ups. Replay both lenses' probes (ops/aud-120/AUD-SOL-W12D-120/, ops/aud-120/AUD-OPUS-
W12D-120/, plus prior ops/aud-119/*W12*). Then merge-only restack #347. One comment per PR, READY FOR AUDIT. Size: #346 2,873 of
3,000 (grandfathered): 127 lines of headroom; if tests do not fit, put them in #347 and say so.

## B-PROG2-120 — mobile programs P1 #355 + P2 #356 FIX ROUND (+ merge-only restack #357 -> #358) (stack lock: programs)
Heads: #355 902c64a64156255ce9ce54147db896ac2142a954 (base main, BEHIND), #356 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5.
Sol REQUEST CHANGES: #355 0/1/0 (5998781633): assignable roster silently stops at 20 clients (paginate to completion or say plainly
that the list is partial; never a silent cap). #356 0/2/2 (5998828937): Undo races an explicit Save, allowing a stale full replacement
after restoration; HTTP 408 wrongly reopens editing as a definite refusal (408 = unknown outcome: re-read before allowing edits).
Sol probes: ops/aud-120/AUD-SOL-P12-120/ (P1 lane run 37341534822: 1 failing; P2 lane run 37341985729: 4 failing). Also fix every A/B
in the Opus P12-120 verdicts (read them first). Cs (false Undo confirmation from another session's revision; post-unmount history
refetch) stay follow-ups. You own ONLY the #355/#356 branches: B-PROG4-120 owns #357/#358 in parallel and merges your #356 head when you
write ops/lanes120/notify/programs.txt ("programs P2: #356 @ <full sha> (B-PROG2-120, <time>)"). Merge main into #355 (newest main). Replay both lenses' probes, one comment per PR,
READY FOR AUDIT. Sizes: #355 1,716, #356 1,501 (grandfathered 3,000).

## B-PROG4-120 — mobile programs P3 #357 + P4 #358 FIX ROUND (stack lock: programs-p34; parallel with B-PROG2-120)
Heads: #357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381 (base = #356's branch), #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94.
Sol REQUEST CHANGES: #357 0/4/1 (5998892359), #358 0/4/0 (5998829473): eight behavioural counterexamples proven in CI (P3 lane
37342607062: 4 failing; P4 lane 37342003294: 4 failing). Sol probes: ops/aud-120/AUD-SOL-P34-120/. Also fix every A/B in the Opus
P34-120 verdicts (read them first). C-357-1 (paginated/searchable asset selection, truthful partial-library empty states) stays a
follow-up. You own ONLY the #357/#358 branches. B-PROG2-120 fixes #355/#356 in parallel; when ops/lanes120/notify/programs.txt shows
its #356 head, merge it into #357 (merge-only; resolve nothing silently: if it conflicts, resolve, say so), then #357 into #358. Replay
both lenses' probes, one comment per PR, READY FOR AUDIT only after the #356 merge is in. Sizes: #357 2,421, #358 1,323 (grandfathered).

## AUD-OPUS-PUSH-120 / AUD-SOL-PUSH-120 — backend push notifications P1 #692 + P2 #693 (first review; T4: PII, consent, migration)
Owner 09:43 PDT 10-05: "we need app notifs" — push is now day-1 scope. Heads: #692 27156167037d5c1be687c597ad349e5a151f5228 (base main,
BEHIND, 815 lines: migration 20270307000000 + schema, quiet hours and preference rules, lock-screen copy, Expo push client, deletion
manifest entries; inert), #693 13417e7be58b96b6fccf203f71ec3b1f1ac8bb20 (base #692's branch, 2,382 lines: delivery, send-time quiet
hours, emitter wiring). Split of #648 (Sol RC 0/1/0 at ab607b34: read it; prior verdicts do not carry). Operator verified 09:48:
migration 20270307000000 is absent from production _prisma_migrations (in-place edits are safe). Full review of both. Check: lock-screen
copy never shows health/PII; quiet hours in the client's zone; preferences honoured at send time; outbox idempotency and retry;
Expo receipts and DeviceNotRegistered token cleanup; account deletion erases tokens and outbox rows; works with no FCM key configured
(Android delivery fails gracefully). Grandfathered sizes (3,000 ceiling).

## B-SPLIT-SCHED-120 — split backend #634 S-SCHED-2 (10,664 lines) into pieces UNDER 1,500 lines each (T4, stack lock: sched)
Owner 09:45 PDT 10-05, verbatim: "the 10k LOC PR- SPLIT IT DOWN TO 1500>LOC/CHUNK! (less than 1500)". Head e18e8055454b04856d2c5ab5568d0a7127b74939
(branch agent110/s-sched-lifecycle, base main, DIRTY vs main; 30 files, +9,378/-1,286; 5,789 test lines). Stacked on it: #653
17b2be25 (S-SCHED-5 request auto-expiry, 1,434, branch agent113/s-sched-request-expiry). Dual APPROVE exists at an earlier #634 head
(read the verdicts; evidence reuse is each lens's decision for byte-identical code only).
Do: (1) build a split plan: N stacked pieces, each strictly under 1,500 changed lines (additions + deletions; tests count; lockfiles,
generated files and snapshots excluded), each compiling and passing its own tests, inert pieces first (schema/migration + types, then
services, then controllers/routes, tests with the code they cover; the ci.yml live-spec line goes with the live spec), the composed
top tree equal to #634's content merged with current main; (2) merge main into the content first and resolve conflicts once (state
every resolved hunk); (3) open each piece as a draft PR (branches agent120/sched-split-<k>-<name>), bottom on main, each on the previous;
title prefix "S-SCHED-2 split <k>/<N>"; body: tier header, contents, tree-equality proof for the top, prior verdict links; (4) restack
#653 onto the top piece (merge-only) and note it; (5) post FIX ROUND 1 (OPENING, B-SPLIT-SCHED-120, agent 120) + READY FOR AUDIT on each
piece; (6) comment on #634 that it is superseded by the pieces (do NOT close it; the operator closes it after the pieces land).
This is more than two PRs because the owner ordered the split; no behaviour change is allowed beyond the main-merge resolution.
Check sizes before every push. CI for every piece runs on GitHub; local work only via heavy.sh.

## Annex day-1 jobs (owner 09:46 PDT 10-05, verbatim: "coachless/featured coach, invite codes, broadcasts, and messaging inbox -> ALL DAY 1 NECESSARY!")
Common to the four annex jobs below: backend PRs from 10-03 (branches annex/*, feat/a3-*). New split pieces are new PRs: each strictly
UNDER 1,500 changed lines (tests count). Merge main into the content first, resolve conflicts once and list every resolved hunk. Every
piece compiles and passes its own tests; inert pieces first (migration/schema/types), then services, then controllers/routes; tests
travel with the code they cover. Open pieces as drafts on branches agent120/<feature>-split-<k>-<name>, bottom on main, each on the
previous; title prefix "<FEATURE> split <k>/<N>"; body: tier header, contents, top-tree equality proof against the original merged with
main (plus listed A/B fixes, if your entry has them), prior verdict links. Post FIX ROUND 1 (OPENING, <JOB>, agent 120) + READY FOR AUDIT
on each piece; comment on the original PR that it is superseded (do NOT close it). Also report, without building it: which mobile
screens on mobile main (cc4ceeed or newer) already use this backend feature and what mobile work is missing for day 1 (file paths).
Feature flags stay as they are; flag flips are a separate PR by the operator after the features land (b#650 community core flags).

## B-SPLIT-MSG-120 — split backend #660 messaging inbox (3,041 lines; one inbox, read-up-to, edit/delete, reply, pins, mute) (T4: PII, access)
Head 6055648506036c4b649cc7958c50ff86c132e997 (branch feat/a3-msg-core-inbox, base main, DIRTY vs main; 25 files +3,002/-39). Never reviewed.
Split only (no behaviour change beyond the main-merge resolution). Stack lock: msg.

## B-SPLIT-COACHLESS-120 — split backend #657 coachless / featured coach / coach-code redemption (3,184 lines) (T4: auth, money-adjacent)
Head c25960a8b82ed4dd6bea0b7da9f1d77ce783078d (branch annex/a1-coachless-be, base main, DIRTY; 27 files +3,184). Never reviewed.
Split only. Open-signup / coachless accounts were approved by the owner 10-01 (DECISION_LOG). Stack lock: coachless.

## B-SPLIT-BCAST-120 — split backend #659 broadcasts (3,929 lines; segmented, scheduled, recurring) AND fix its A/B findings (T4)
Head fa9a7cbd33c5f1c1d5108f3a3d57ea70f3177faf (branch annex/a4-broadcasts-be, base main, BEHIND; 31 files +3,928/-1). Opus REQUEST CHANGES
(5964501283), Sol BLOCK (5964574829) at this head (10-03). Read both in full. Split, and fix every A/B in the piece that owns the code
(say per piece which lines differ from the original and why). Cs to follow-ups. Stack lock: bcast.

## B-INV2-120 — backend #658 invite-code tools FIX ROUND (create, rotate, revoke, QR) (2,565 lines, grandfathered 3,000) (T4: auth)
Head 08534e17c686602415f0836abc66db0182aeea3f (branch annex/a2-coach-code-tools-be, base main, BEHIND; 26 files +2,522/-43). Opus REQUEST
CHANGES (5964473420), Sol REQUEST CHANGES (5964522757) at this head (10-03). Fix every A/B in place (stay at or under 3,000; if a fix
would cross 3,000, split the PR into pieces under 1,500 per the annex common rules instead), merge main, replay both lenses' probes
(write failing-before probes for each B if none exist), FIX ROUND comment, READY FOR AUDIT. Check overlap with #657 (coach-code
redemption) and with mobile invite flows; report the mobile gaps. Stack lock: inv.

## B-661R2-120 — backend #661 FIX ROUND (B-661-14) with regressions in #702 (T4: secrets at rest, stack lock: secrets)
Heads: #661 bc399edd5911c9c1e83e4bb1051fde05bfeda64d, #702 9ddda117d89f72c8d4a7a5b58a2c7ba6173053a2. Sol: #661 REQUEST CHANGES 0/1/1
(5998892091), #702 APPROVE 0/0/0 (5998892592, stack-provisional). B-661-14: recurring invoice/subscription activation keeps spent
PaymentIntent/SetupIntent client secrets and ephemeral keys at rest; Sol proved it with four real-PostgreSQL acceptance cases (lanes
37341623338, 37342234566; probes in ops/aud-120/AUD-SOL-661D-120/). Fix rule (Sol): bounded, atomic credential clearing on every
recurring activation path (same transaction as the state change), preserving payable native trials; regressions go in #702 (owner
decision 3 default: #661 tests live in #702). Also fix every A/B in the Opus 661D-120 verdict (read it first). C-661-13 ticketed,
C-661-10 additive follow-up, historic cleanup approval-only, C-656-1 stays the trials release prerequisite. Replay both lenses' probes;
FIX ROUND comment on #661, RESTACK/FIX ROUND on #702; READY FOR AUDIT. #661 is at 2,849 of 3,000: code only in #661, tests in #702
(#702 is under the 1,500 rule: 513 now).

## B-HC11-120 — mobile Health Connect H7 #369 FIX ROUND 2 (B-369-2) (T4: health consent, stack lock: hc)
Head #369 3252ec79cd9ab1f28165a1913d8ae3096b590d4a (1,205 lines, 1,500 rule: 295 headroom). Sol REQUEST CHANGES 0/1/2 (5998888199):
B-369-1 closed; new B-369-2: an in-flight Connect can recreate durable consent during an interrupted sign-out (Sol lanes 37341997614,
37342514128; probes ops/aud-120/AUD-SOL-H7-120/). Fix rule: sign-out first fences/invalidates in-flight Connect (generation/epoch
check before any durable consent write), so no consent survives or is recreated after sign-out starts, including after an app kill.
Also fix every A/B in the Opus H7-120 verdict (read it first). #362: Sol conditional APPROVE (5998888651) in the H1-H7 composition.
C-369-2/3, C-362-5 follow-ups. B-HC10-120 has an H8 PR stacked on #369: write ops/lanes120/notify/hc.txt ("hc H7: #369 @ <sha>
(B-HC11-120, <time>)") so it can merge your head. Replay probes, FIX ROUND comment, READY FOR AUDIT.
