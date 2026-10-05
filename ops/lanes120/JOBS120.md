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
invalidates a pending tap. Opus W12D-120 APPROVED #345 (5999046073, 0/0/1) and #346 (5999046333, 0/0/1); its C-346-7 (FirstPackageForm.tsx:470-479:
Create stays enabled while the saved package loads) is the same lines as B-346-3: fix both together. C-346-1 / C-346-4 / C-345-7 stay
follow-ups. SECOND PR (#347, W3 own content, never fully reviewed): fix the known items from the W12-119 reports (first-person copy at
#347 line ~343; the missing `isLive` handling; grep ops/reports/AUD-*-W12-119.md and AUD-*-W12D-120.md for W3/#347 notes), then READY
FOR AUDIT for a full W3 review. Replay both lenses' probes (ops/aud-120/AUD-SOL-W12D-120/, ops/aud-120/AUD-OPUS-
W12D-120/, plus prior ops/aud-119/*W12*). Then merge-only restack #347. One comment per PR, READY FOR AUDIT. Size: #346 2,873 of
3,000 (grandfathered): 127 lines of headroom; if tests do not fit, put them in #347 and say so.

## B-PROG2-120 — mobile programs P1 #355 + P2 #356 FIX ROUND (+ merge-only restack #357 -> #358) (stack lock: programs)
Heads: #355 902c64a64156255ce9ce54147db896ac2142a954 (base main, BEHIND), #356 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5.
Sol REQUEST CHANGES: #355 0/1/0 (5998781633): assignable roster silently stops at 20 clients (paginate to completion or say plainly
that the list is partial; never a silent cap). #356 0/2/2 (5998828937): Undo races an explicit Save, allowing a stale full replacement
after restoration; HTTP 408 wrongly reopens editing as a definite refusal (408 = unknown outcome: re-read before allowing edits).
Sol probes: ops/aud-120/AUD-SOL-P12-120/ (P1 lane run 37341534822: 1 failing; P2 lane run 37341985729: 4 failing). Also fix every A/B
in the Opus P12-120 verdicts (read them first). Opus P12-120 REQUEST CHANGES: #355 0/3/1 (5999100428), #356 0/2/3 (5999100681): B-355-1/B-356-1 autosave/undo 409 replies
lose head index + lock token in the BACKEND error filter (backend fix is a separate job, B-MWB409-120: the mobile side must read the
fields the backend will return and fail truthfully until then); B-355-2 an "in progress" retry is treated as a final refusal, so the
next tap creates a duplicate program (treat in-progress/unknown as pending, re-read before allowing a new create); B-355-3 assign picker
shows only the newest 20 clients; B-356-2 any refusal on Check again is reported as "nothing was undone". Operator rulings (Opus
defaults accepted): REMOVE the clinic-build flag flips from #355's eas.json (flags flip in a separate PR after the backend fix deploys
and the backend FEATURE_MWB_* flags are on); fix shared helpers in #355. ALSO Opus B-358-1 (P34, 5999064225): the Assign screen gets only the 20 newest
clients because programsApi.ts (in #355) fetches one page: fix it in #355 together with Sol's #355 roster B (same root cause). Cs (false Undo confirmation from another session's revision; post-unmount history
refetch) stay follow-ups. You own ONLY the #355/#356 branches: B-PROG4-120 owns #357/#358 in parallel and merges your #356 head when you
write ops/lanes120/notify/programs.txt ("programs P2: #356 @ <full sha> (B-PROG2-120, <time>)"). Merge main into #355 (newest main). Replay both lenses' probes, one comment per PR,
READY FOR AUDIT. Sizes: #355 1,716, #356 1,501 (grandfathered 3,000).

## B-PROG4-120 — mobile programs P3 #357 + P4 #358 FIX ROUND (stack lock: programs-p34; parallel with B-PROG2-120)
Heads: #357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381 (base = #356's branch), #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94.
Sol REQUEST CHANGES: #357 0/4/1 (5998892359), #358 0/4/0 (5998829473): eight behavioural counterexamples proven in CI (P3 lane
37342607062: 4 failing; P4 lane 37342003294: 4 failing). Sol probes: ops/aud-120/AUD-SOL-P34-120/. Opus REQUEST CHANGES: #357 0/1/7
(5999063942) B-357-1: after a lost response, picking a different saved workout reuses the first request key
(ProgramDayPickerScreen.tsx:79-110); #358 0/2/4 (5999064225) B-358-1 (20-newest clients: FIXED IN #355 BY B-PROG2-120, not by you;
verify after merging #356's head) and B-358-2: Remove appears once per run but the server deletes upcoming workouts from every run,
including package copies; the dialog must show the true total and scope. Opus probes: ops/aud-120/AUD-OPUS-P34-120/probes/. C-357-1 (paginated/searchable asset selection, truthful partial-library empty states) stays a
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
decision 3 default: #661 tests live in #702). Opus 661D-120 (5999168270): #661 RC 0/1/7, B-661-15 = the same defect seen from the first-grant side:
handler :1643-1655 and :2285-2296 never clear stripe_client_secret / stripe_ephemeral_key on the first subscription grant (breaks #661's
own C-661-3 rule); its two-line fix passed 539 tests (run 37344323196; probe run 37343688493). #702 APPROVE 0/0/1 (5999168870). Operator
rulings: source lines in #661, tests in #702 (Opus decision 1 = owner decision 3 default); backfill includes subscription rows that already
hold credentials (Opus decision 2; production ClientPurchase has 0 rows at 10:01 10-05, so the backfill is a no-op today but must exist and
be tested). C-661-13 ticketed,
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

## B-MWB409-120 — backend: keep head index + lock token in MWB autosave/undo 409 replies (T4: API contract, error filter)
Opus P12-120 (#355 5999100428, #356 5999100681): the backend error filter (src/filters/http-exception.filter.ts, error-details.ts on
main ee55f814) strips the head index and lock token from the MWB autosave and undo 409 replies, so mobile autosave never completes its
first save and Undo reports "nothing was undone" even when it worked. Probes: backend lanes 37343254265 (production) and 37343228885
(main); notes in ops/aud-120/AUD-OPUS-P12-120/. Build a NEW backend PR on main (under 1,500 lines): an allow-listed, typed details
pass-through for exactly those 409 codes (no generic passthrough of internal fields; no PII), tests through the real filter for each
code, plus a test that other errors still strip details. Read the recurring error-details contract (src/checkout/error-label.ts,
src/filters/error-details.ts) so you extend it, not fork it. FIX ROUND 1 (OPENING, B-MWB409-120, agent 120) + READY FOR AUDIT.

## Roman day-1 jobs (owner 09:57 PDT 10-05: "roman needs all of that on day 1")
Stack: backend #667 bacd83e1 (A1, base main, 1,832) -> #665 eb7cb7a8 (A2, 2,282) -> #666 0ec835ca (B safety router + reply post-check,
1,735) -> #668 fabc2268 (C1 live-turn wiring, 2,159) -> #669 6386c00b (C2: failing-before tests only, red by design, 907) -> #670
fb671019 (C3 golden-set eval, 1,135). All grandfathered (3,000 ceiling), all draft, never reviewed at these heads (parent #651 had RC
from both). Approve-to-adjust: backend #655 bf9120c1 (2,058) + mobile #337 63be1013 (1,051). Chats: mobile #331 5b58a121 (5,067: Opus RC,
Sol BLOCK). Binding: OR-115-1 neutral roman.safety_route action + restricted reason code; OR-115-2 crisis templates without box-2
consent; AI chats kept until the client deletes them or the account; Roman never reads CoachingSession private notes, bloodwork,
purchases/invoices or other users' rows (docs/roman-client-context.md in #667).
- AUD-*-RA-120 (pair): #667 + #665 first full review.
- AUD-*-RB-120 (pair): #666 + #668 first full review.
- B-ROMAN-C2-120 (Opus builder): write the #669 fix commit per handoffs/op-115/reports/B-SCHED-ROMAN-115.md (tgp-agent-context; source
  branch agent115/roman-651-r2-wip-unsplit @ 675cf045), including the disclosed T4-gate ci.yml step for the spend-admission live spec;
  #669 and #670 go green; FIX ROUND + READY. Then AUD pair on #669 + #670.
- B-SPLIT-ROMANCHATS-120 (Opus builder): split mobile #331 into pieces under 1,500 and fix every A/B from its Opus RC and Sol BLOCK.
- AUD-*-RADJ-120 (pair): backend #655 + mobile #337 first full review (flag FEATURE_ROMAN_ADJUST_ENABLED stays off until landed).
- Operator after landing: flag PR for FEATURE_ROMAN_CHAT_ENABLED / EXPO_PUBLIC_FF_ROMAN_CHAT and FEATURE_ROMAN_ADJUST_ENABLED; confirm
  the Anthropic key is present in production (fly-env-desired-state.json), never set secrets ourselves.

## B-PUSH2-120 — backend push #692 + #693 FIX ROUND (T4: PII on lock screens, consent, delivery) (stack lock: push)
Heads: #692 27156167037d5c1be687c597ad349e5a151f5228, #693 13417e7be58b96b6fccf203f71ec3b1f1ac8bb20. Sol REQUEST CHANGES: #692 0/1/0
(5999124539): arbitrary profile/body text can put email or health details on lock screens -> generic lock-screen copy by default
(title/body from a fixed allow-listed template per notification type; details only inside the app). #693 0/4/2 (5999124426):
reschedule dedupe collisions; hidden sole notifications; failed token cleanup settled permanently; consent revoked during send
preparation must stop the send (re-check at dispatch). Sol probes ops/aud-120/AUD-SOL-PUSH-120/ (runs 37343801309, 37344206727). Opus
(10:12): #692 APPROVE 0/0/2 (5999369595); #693 RC 0/1/9 (5999369928) B-693-1: push-delivery.service.ts:540 sends channelId 'default'
but the mobile app only creates coach-messages / client-bot / milestones / system, so Android would record pushes as sent and never show
them: map each notification kind to an existing channel (single source of truth shared with mobile names). Opus probes
ops/aud-120/AUD-OPUS-PUSH-120/probes/ (run 37345618739, Postgres 15 lane). Operator rulings: #693's main refresh may carry the one-line
payout-notice `push_twin: true` fix (else money alerts show twice in the coach inbox); #692 and #693 merge back to back, deploy after #693
with migrations. #692 also gets the tier header in its PR body. Cs (cross-replica burst admission, legacy sender bypass) are follow-ups. Both PRs
must end under 1,500 lines each if they were opened after 12:33 10-04, otherwise under 3,000 (check created_at). Migration 20270307000000
is not in production: keep it additive. FIX ROUND comments + RESTACK #693 + READY FOR AUDIT. Android delivery claims need the FCM key
(owner uploaded it 09:51 10-05) and a device check: say "unverified on device" until then.

## AUD-OPUS-CM8-120 / AUD-SOL-CM8-120 — coach stack lens pair at FIX ROUND 5 heads (T4: money, Connect transfers/reversals)
Heads (B-CM7-120, all PR CI green): #674 e35c37a1db1da2949c366f681633b1b1f72a11b3 (2,965; main ee55f814 merged), #676
0ee4933d0f227991bde5e41c0a770b4887ec1957 (2,984), #677 b17888ab6eaa018a49d42a40eb2b773b89198d28 (2,915), #703
88940c3f5a0843a5979d1ac3196049e0be516141 (953). FIX ROUND 5 comments 5999161245 / 5999161517 / 5999161790 / 5999162145; report
ops/reports/B-CM7-120.md. Scope: full exact-head review of #674 and #676 (main merge + B-CM7-1 reversal race fix: Stripe 172 vs local
122); #677 and #703 are tests/restack: verify byte-identity of own content vs the last audited heads plus the new tests. Judge the
builder's substitution of the live reversal spec + slot specs for the 2 probes that cannot be adapted (accept only if they prove the
same property). One verdict comment per PR, at the exact head. Under 1,500/3,000 rules: #674-#677 grandfathered 3,000, #703 1,500.

## AUD-OPUS-L3-120 / AUD-SOL-L3-120 — mobile lockout m#352/#353/#354 lens pair at FIX ROUND 2 heads (T4: billing lockout, dispute copy)
Heads (B-LOCK2-120, all required checks green, mergeable clean): #352 c89f719cd8f5863c4150af1da5b96e273df319d6 (base main cc4ceeed,
2,586), #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85 (2,723), #354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649 (1,119, merge only). FIX
ROUND 2 comments 5999207160 / 5999207763 / 5999208351; report ops/reports/B-LOCK2-120.md. B fixed: B-352-2/3/7, B-353-2/3/6/7. Owner
rulings binding: dispute (incl. inquiries) pauses billing and ends access, the coach decides on restarting; a failed refund after access
ended alerts the coach only. Operator ruling on D1: Opus B-352-7 forbids "settle" in copy; Sol's 119 probe 1 assertion on the old sentence
is superseded - Sol updates its probe to the new wording rather than failing the PR for it. #354 is merge-only: tree check of own content.

## B-TR8-120 — backend trials #673 integration round against main's recurring trials, then restack #706/#707 (T4: money, access)
State (B-TR7-120, ops/reports/B-TR7-120.md): #707 8fc2660b FIX ROUND 2 READY (5999226884, 1,246); #671 ea7a9740 main refresh READY
(5999281437); #672 b0654c80 restack with a real conflict fix READY (5999282001, 2,959); #673 dcf095b8 RESTACK STOPPED (5999288854):
main's recurring #678 (native subscription trials, trial_started_at, live subscription authority + subscriptionGrantsAccess in
checkout-webhook-handler.service.ts) collides with T3's package trials (PackageTrialUsage) on customer.subscription.updated access and
the one-trial rule. Operator ruling (owner may overturn; asked 10:1x): ONE SHARED TRIAL RULE: a client gets at most one free trial per
coach, whichever kind (package trial or native subscription trial). Do option (a): resolve #673 against new #672 with main's live
subscription authority and subscriptionGrantsAccess as the base, enforce the shared rule in one place, move T3 test growth into #706 so
#673 stays within 3,000 (grandfathered), then restack #706 and #707 (merge-only where possible). Stripe draft fence (finalize with
auto_advance=false then void, since Stripe forbids deleting subscription drafts) is accepted by the operator; lenses confirm. RESTACK /
FIX ROUND comments, READY FOR AUDIT. Then one lens pair audits the whole trials train (#671 delta, #672 delta, #673 full, #706, #707).

## AUD-OPUS-D6-120 / AUD-SOL-D6-120 — dunning D1-D2c lens pair (first lens ever on D1/D2a/D2b/D2c) (T4: money, access, disputes)
Heads (B-DUNMR-120, all required checks green): #687 f3c7fd37777ef1cde75ec5fb984edf5cb973f864 (MAIN REFRESH, no code change,
5999323963), #688 21714f7bba299336cf71df0c87288c798fd5da13 (FIX ROUND 5, 2,784, grandfathered; 5999324310), #704
49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 (RESTACK merge-only, 694; 5999324570), #705 5138947cd082328b81cbeb787833914431b22fc1 (RESTACK +
FIX ROUND 1, 1,409; 5999324895). Report ops/reports/B-DUNMR-120.md. Full review of all four at exact heads (#704: verify merge-only +
own content). Binding owner rulings (DECISION_LOG 10-05): dispute and inquiry pause billing and end access, coach restarts; failed refund
after access ended = alert coach only, no access change; full refund on a recurring plan pauses billing and ends access (NOT in these PRs;
a later D2d piece). Check C-680-18 (A, fixed in #688: clearing a dunning cycle must not restore an ended/revoked plan) and C-680-19 (won
dispute keeps a paused plan revoked) on the composed tree. Known superseded probes: R34D C-680-19 cases on #688/#704 fail until #705 by
design; one old #705 case hand-writes the old `paid` status. One verdict comment per PR at the exact head.

## B-DUNB-120 — dunning D3 #689 + D4 #690 onto #705, plus operator rulings (T4) (after D6 verdicts; stack lock: dunning)
Operator rulings 10:1x (B-DUNMR decisions, defaults accepted): D3 #689 adopts main's Stripe method signatures; the dispute-pause check
runs whether or not FEATURE_DUNNING_V2 is on (flag rollback must not restore access to paused plans); D2c does not set `disputed` when it
pauses; the coach alert for a failed refund after access ended is built (owner decision 5) in the D-stack piece that owns refund events;
dispute event time is closedAt in D4. Fix every A/B from both D6 verdicts that lands in #687-#705 first (that is a B-DUNMR-style round on
those PRs), then move #689/#690 onto #705 with their own open RCs fixed (#689 RC both; #690 Sol RC). Then the decision-7 D2d piece
(full refund on a recurring plan pauses billing and ends access; C-680-16 at refund-dispute-handler.service.ts:301-302, 1408-1411) as a
new PR on #705 under 1,500 lines. Then D5 #691 + #642.

## AUD-OPUS-INV3-120 / AUD-SOL-INV3-120 — backend #658 invite-code tools lens pair at FIX ROUND 1 (T4: auth/linking, PII deletion)
Head 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0 (B-INV2-120, 2,960 of 3,000 grandfathered, main ee55f814 merged clean, 11/11 checks green;
FIX ROUND 1 5999613642; report ops/reports/B-INV2-120.md). Prior RC: Opus 5964473420, Sol 5964522757. Operator accepted B-INV2 decisions:
sub-coaches see only codes they issued, no team coach link; successor_code inside the PR's own unapplied migration; expected_code required
on coach-link rotate; signup records deleted on client/coach erasure. Overlap rule: whichever of #657/#658 lands second maps code_revoked /
code_expired / code_exhausted in ATTACH_TO_COACHLESS.

## M-INV-120 — mobile invite codes on the new backend (day 1) (T3/T4: linking) (after #658 is approved)
Mobile main cc4ceeed gaps (B-INV2-120): nothing calls /coach/codes; InviteCodesScreen.tsx uses the old /coach/invite-codes routes; no QR
library; day-one pairing (src/screens/day-one/api.ts:49-61) reads only `reason`, so revoked/expired/used-up codes show "not recognized";
the Codes screen must send Idempotency-Key and expected_code. New mobile PR(s) under 1,500 lines each: Codes screen on /coach/codes
(create, rotate, revoke, QR share), truthful day-one errors per code state, tests. QR library choice must work in Expo managed builds.

## Scheduling day-1 jobs (owner 10:31 PDT 10-05: "all required day 1 - make sure that coaches set their times and availability!")
Backend: #634 split by B-SPLIT-SCHED-120 (running; restacks #653 17b2be25 onto the top piece); #653 auto-expiry (1,411, never reviewed);
#643 f21b3c63 BOOKING_REMINDERS_ENABLED=on (RC both 5960175016 / 5960179586). Mobile: #365 cceeb33a (K1, base main, BEHIND, 2,025) ->
#366 fa7744cc (K2, 1,680) -> #367 6418e759 (K3, 2,294) -> #336 e043bb44 (expiry states, base is the dead #325 branch: retarget onto #367);
#341 7c791bb3 (device time zone + tap opens session + quiet hours; RC Sol 5972146496 / Opus 5972160274). None of K1-K3/#336/#653 has
ever had a lens. All created before 12:33 10-04: 3,000 ceiling. Migration 20270222000000 needs the two read-only preflight queries
(overlaps, inverted ranges) returning zero rows in production before deploy (operator runs them through the Supabase connector).
- AUD pairs: SCHED-BE (the split pieces + #653, after B-SPLIT-SCHED READY), SCHED-M1 (#365 + #366), SCHED-M2 (#367 + #336 after retarget).
- B-SCHED-FIX-120: #643 + #341 fix rounds (both RC both), then the K-stack fix rounds after the SCHED-M verdicts.
- S-AVAIL-120 setup gate: DROPPED by the owner 10:33 ("lets drop that - I want the optionaility but not reworking the whole onboarding
  right now"). No onboarding/wizard/checklist change, no setup block, no new push. Lenses only check that K3 shows truthful copy (not an
  empty picker) when a coach has no bookable types or hours.
- S-AVAIL-120 = coach booking options only (owner 10:32: "COACHES DECIDE THEIR TIMES AND AVAILABILITY"): nothing about when a coach can be booked is
  hard-coded. Coach-set per coach (per appointment type where it makes sense): minimum notice (default 5 min = today's rule), how far
  ahead clients may book (default 120 days = today's rule), buffer before/after sessions (default 0), optional daily maximum. Server
  enforces them in the same advisory-locked validation as #634 (additive columns, defaults reproduce current behaviour); open-slots honours
  them; coach editor screens next to open hours. Under 1,500 lines per PR; after the #634 pieces.
- Then flag/ops: BOOKING_REMINDERS_ENABLED=on through the manifest after #634 pieces deploy.

## B-MSG2-120 — messaging split #708-#711: CoachMessage RLS in #708's migration, restack (T4: RLS) (stack lock: msg)
B-SPLIT-MSG-120 split #660 into #708 5c9c6a0e (459, base main) -> #709 87f0bfff (1,141) -> #710 47b528ce (1,092) -> #711 5a7c41e8 (388);
tree of #711 == #660 + main (cd130ae4). community-live-tests fails one case on every piece (also on #660): "pin / reply columns are
visible to participants and to no one else", because no migration enables RLS on CoachMessage. Operator check 10:38 (production, read-only):
CoachMessage has RLS ON and FORCED with exactly one policy coach_message_participant_access, roles {public}, cmd ALL, permissive,
USING and WITH CHECK = ((app.current_user_id() IS NOT NULL) AND ((coach_id = app.current_user_id()) OR (client_id = app.current_user_id())
OR (sender_id = app.current_user_id()))). Ruling D1: add to #708's migration an idempotent block that ENABLEs + FORCEs RLS and creates that
exact policy only if absent (DO block on pg_policies), so it is a no-op in production and correct in fresh databases; down.sql must not
drop production's policy unless this migration created it (marker comment, same pattern as #634's btree_gist). D2 keep timestamp
20270303000000; D3 keep "delete erases content immediately". Restack #709-#711 merge-only. community-live-tests must go green on all four.
FIX ROUND comments + READY FOR AUDIT. Then lens pair MSG3 on #708-#711.

## M-MSG-120 — mobile messaging inbox on the new backend (day 1) (after #708-#711 are approved)
Gaps on mobile main cc4ceeed (B-SPLIT-MSG-120): no inbox screen on the new routes (src/screens/coach/MessagesScreen.tsx,
command-center/InboxScreen.tsx); reply sends parent_message_id which today's backend rejects (src/api/messagesApi.ts); no Idempotency-Key
or read-up-to (src/services/api.ts); no thread-updated realtime handling (src/services/realtime.ts); no edit/delete/pin/mute
(MessageActionSheet.tsx); no messaging_core_v2 flag (featureFlagsApi.ts). PRs under 1,500 lines each, flag-gated.

## AUD-OPUS-H9-120 / AUD-SOL-H9-120 — mobile Health Connect #369 FIX ROUND 2 + #370 H8 OPENING (T4: health consent, health data)
#369 a2bfe2fa906ff5e3b991613a6838a82456db920c (1,270; FIX ROUND 2 5999327369; CI 37345688498): fixes Sol B-369-2 (in-flight Connect at
sign-out checks a sign-out fence after every await; the in-flight write now rejects as stopped; end state no key, no grant). Opus approved
the prior head (5999043389); Sol RC (5998888199). Review: the delta since 3252ec79 in full + composition with H1-H6 (#362 Sol conditional
approve 5998888651 is in the H1-H7 composition). Five known by-design probe failures are listed in ops/reports/B-HC10-120.md.
#370 c7014623520baf23a697f4d646e3d80a423789c5 (1,050, H8, stacked on #369; OPENING 5999807045; CI 37349317509): C-360-1 late data
(1-day look-back), C-360-2 resumable import (Health Connect per page, Apple Health per day piece); no backend change. Full first review.
Operator rulings on B-HC10 decisions (defaults): 1-day look-back; Apple Health hourly steps/energy wait 2 h before posting; backend
"replace rewritten Health Connect records" is a follow-up ticket. One verdict comment per PR at the exact head.
