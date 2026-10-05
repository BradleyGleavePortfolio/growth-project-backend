# AUD-OPUS-DUN1-122 (Claude Opus 5.5 lens, agent 122) — dunning train + b#725, RUTHLESS SCOPE

Started 15:12 PDT 10-05 (time box 75 min -> 16:27 PDT). Read-only. No CI lane, no heavy.sh.
Notes and verdict bodies: /home/user/workspace/ops/aud-122/AUD-OPUS-DUN1-122/ (verdict-<n>.md, prior-<comment>.json, d2d-service.diff).
Sol's report, notes and notify files for this round were NOT read.

## Blocker: GitHub auth
`gh` / git over git-agent-proxy return 401 "Bad credentials" for the whole session (15:12 onward; operator mail 15:25 confirms,
owner reconnect pending). Workaround (read-only): anonymous bare mirror of the public repo at
/home/user/workspace/wt/AUD-OPUS-DUN1-122-mirror.git (fetched refs/pull/*/head) and worktrees
/home/user/workspace/wt/AUD-OPUS-DUN1-122-725 (1dbc59b6) and /home/user/workspace/wt/AUD-OPUS-DUN1-122-724 (e77a8d36).
CI states read from unauthenticated api.github.com (60/h, shared IP). Verdicts are written as files; post when `gh api user` works.

## Part 1 — b#725 @ 1dbc59b690119f03f010e406f9f1e0e43d1e6556
APPROVE 0/0/2 (verdict-725.md). Exact METHOD+PATH allow for the client's own coach thread (GET/POST messages, POST messages/read,
GET messages/unread-count); thread resolved from the caller's coach_id; voice-upload (paid), coach-review, coach routes stay locked.
CI: 16 runs, 15 success, 1 skipped. Claim: claims/backend-725-1dbc59b6-opus.
Posted 15:42 PDT (auth back 15:41): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6004668014
C-725-1 coach-review stays locked (pill renders nothing); C-725-2 main's FEATURE_MESSAGING_CORE_V2 routes (inbox/pins/mute/edit) stay
locked; decide before that flag turns on.

## Part 2 — prior Opus Bs on the current train content
- B-687-8 (#687, dispute copy said "reversed"): CLOSED at #687 d86b31a6 (copy says the bank opened a dispute or inquiry; subject
  "Your plan is paused after a payment dispute or inquiry"). No client copy in D1-D2d at #724 claims a reversal (rg).
- B-705-4 (pause read gated by the flag): CLOSED at #705 2a03d7dd (`isDisputeCycleOpen` no longer checks `enabled()`).
- B-705-1 (re-pause reused the first pause key): CLOSED at #724 e77a8d36 (lease fence in every pause/resume key; re-pause in finally).
  Was an edge race anyway under the freeze.
- B-705-2 (restart after a re-buy bills two plans): CLOSED at #724 (`otherLivePlan` pre-check and again under checkout's advisory
  lock -> `other_live_plan`). Matches A6.5 (re-buy allowed, restart refuses).
- B-705-3 (lost closure after a restart ends access while billing runs): CLOSED at #724 (`restarted_at` on obligations; lost branch
  moves money and returns before the access flip; a redelivered opening does not re-mark `disputed`). Matches A6.5.
- #688 note from D34-118 (dispute notices / status used `last_failed_amount_cents`): moot at #724; dispute status and copy carry no
  amount (`amount_cents` null).
- B-689-5 (#689 disputed amount = last failed renewal): OPEN; builder B-DUNR3-122 is fixing it during the move onto #724.
- #690: Opus APPROVE 5982575812 stands for the D4 diff; needs a delta verdict after the move.
- D2d normal paths read (dispute pause -> Stripe pause -> billing_paused_at -> notices; coach restart -> resume -> access with Stripe's
  status and period; lost closure after restart). No item-1 problem found. Lease/fence/sweep code is edge hardening: not analysed.

## Part 3 — builder delta
Waiting for READY FOR AUDIT (notify/dunning.txt, PR comments). Builder status 15:30: nothing pushed (same 401).
What to check when ready: (1) #687 main-merge conflict hunk in coach-alert.emitter.ts (main side kept + dunning side kept);
(2) #688/#704/#705/#724 merge-only restacks by tree equality vs merge-tree; (3) #689 moved onto #724: D3 must call D2c/D2d's
pause semantics (no card path settles a pause, cancel during a pause ends access now) and B-689-5 fix: amount only from
ChargeDispute rows or omitted, and the reply copy makes no reversal claim (B-687-8 rule: an inquiry moves no money);
(4) #690/#691 restacks merge-only except conflict hunks.

## Pre-read for Part 3 (done while waiting)
- #687 + main merge-tree: one conflict, coach-alert.emitter.ts emit(). Main side (C-643-2): inbox row + `notifications.sendPush`
  (quiet lock-screen copy, coach_alert_push preference, no second `push` row). #687 side: delivery receipt (`only`, `verifiedPush`,
  returns CoachAlertDelivery), non-verified push via raw `pushToCoach` (alert text as lock-screen title) + a `push` row.
  Correct resolution keeps #687's receipt contract AND main's sendPush for the non-verified path. A resolution that keeps pushToCoach
  for ordinary coach alerts reverts main's lock-screen privacy fix (would be a regression B).
- #689 merges into #724 textually clean. #691 (D3+D4+D5) vs #724: 9 conflicted files (webhook handler 13 hunks, checkout.module,
  dunning-lockout.guard 2 hunks, public-pages.html, 5 lockout specs). D4's runDisputeEffect calls detectAndHandleLateReversal /
  onDisputeClosed with disputeId; #724 has both APIs with that shape (R-DISPUTE-PAUSE goes live through D4).
- Guard conflict: #724 `hasOtherLiveAccess` vs D4 `effectiveLock` (same rule, effectiveLock also covers rows with entitlement on);
  either is fine for a dispute-paused plan.
- D3 copy at bb992fed :1424 and :1645 says "Your bank reversed an earlier payment" + "contact support"; check the B-689-5 fix
  makes it true for inquiries (B-687-8 rule) and drops the last_failed_amount_cents figure.

## Part 3 — builder delta (pre-READY reading, heads as of 16:03 PDT)
Heads: #687 c140575c, #688 610c5254, #704 524c4025, #705 346b7757, #724 410fb1b3, #689 0fbd18ca, #690 b3ae2f29, #691 d8c229a6.
- #687 c140575c: main merge; only coach-alert.emitter.ts (+ its spec) differs from merge-tree. Receipt contract kept, all pushes via
  main's sendPush (quiet lock-screen copy). Correct. Size 2,648. -> APPROVE 0/0/0.
- #688 610c5254: tree == merge-tree(2662d01a, c140575c). 2,784. -> APPROVE.
- #704 524c4025: only the dunning.service.ts import conflict; both import sets kept. 694. -> APPROVE.
- #705 346b7757: tree == merge-tree(2a03d7dd, 524c4025). 1,425 (1,500 rule). B-705-4 closed here; B-705-1/2/3 close in #724
  (lands as one). -> APPROVE.
- #724 410fb1b3: only refund-dispute-handler lost branch conflict: main's B-674-5/B-676-1 once-only reversal kept, B-705-3
  `restartedByCoach` + `if (restarted) return` kept inside `if (purchase && firstPass)`. 1,133. -> APPROVE.
- #689 0fbd18ca: 4f875a39 == merge-tree(bb992fed, 410fb1b3). ebb522fa B-689-5: amount from outstanding ChargeDispute rows (one
  currency) or null; copy omits unknown amounts. CLOSED. onBehalfOf / positional voidInvoice follow main. 0fbd18ca typing fix only
  (owner check on SetupIntent metadata intact). 2,942. C-689-6 (see notes): card-result / cancel copy still says "Your bank reversed
  an earlier payment ... contact support"; false for an inquiry; no mobile consumer today. -> APPROVE 0/0/1 if CI green.
- #690 b3ae2f29: 620c9e8b resolution read (guard keeps effectiveLock; allow-list keeps checkout/*, messages exact paths; module keeps
  both provider sets; footer keeps main's policy links; webhook awaits runDisputeEffect with dispute id; disputePaused read in
  sub.updated and invoice.paid). b3ae2f29 == merge-tree. 2,789.
  **B-690-8**: no HTTP route calls `restartAfterDisputePause` (git grep src at b3ae2f29). The D4 plan included it (B-DUNSPLIT-119
  decision 3 "Restart endpoint lands in D4. Default: yes"; B-DUNMR-120 carried). -> REQUEST CHANGES 0/1/0.
- #691 d8c229a6: b2631440 and d8c229a6 == merge-tree; 3641c007 tests only (adds the B-689-5 P3 spec). 2,912. -> APPROVE.
- CI at 15:58: #689 ebb522fa and #690 f97c46e2 build-and-test Type-check failed (fixed by 0fbd18ca typing; re-check at READY).

## Verdicts posted (READY FOR AUDIT 16:12 PDT; heads re-read right before each post; posted 16:13 PDT)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #725 | 1dbc59b690119f03f010e406f9f1e0e43d1e6556 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/725#issuecomment-6004668014 |
| #687 | c140575c8b857023ce69ae28a1dcf6e8ab925335 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-6005163422 |
| #688 | 610c52542c0a1865bd9c448d78291d9d663f67fb | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-6005163863 |
| #704 | 524c4025e36fe4b3c925f7cc0072fd6951f01605 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-6005164226 |
| #705 | 346b77570eb4d40a344d4bd0007c70039c34981a | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-6005164663 |
| #724 | 410fb1b3b82b0ab49c8387a8d01e6e3ca6060a6c | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/724#issuecomment-6005165030 |
| #689 | 0fbd18cae72f4fdea7c4876034a0d3d1d3dac1cd | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-6005165494 |
| #690 | c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae | REQUEST CHANGES | 0/1/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-6005165998 |
| #691 | 17cfa5662b7014a90d54a3d6747ae651c37e8793 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-6005166527 |

Final deltas after the pre-read: #690 c15f157c = b3ae2f29 + privacy-log count spec only (2,792); #691 17cfa566 = b0b47959 (spec
compile fix) merged with c15f157c, tree == merge-tree (2,914). CI: #687-#689 every check name green (duplicate runs cancelled);
#690/#691 build-and-test and live lanes running at 16:13; builder lane run 37386724702 green at #691 b0b47959 (tsc + 67 suites).

B open: B-690-8 (no coach route calls restartAfterDisputePause; planned for D4). Story: with dunning v2 on, a dispute or inquiry
pauses a monthly plan, the coach is told restarting is their decision, but nothing can restart it; the client stays locked out and
the coach's recurring income stops unless the client re-buys.
Cs: C-725-1 (coach-review locked), C-725-2 (messaging core v2 routes locked; decide before that flag), C-724-1 (restart grants the
current, voided period; coach's call), C-689-6 (D3 card-result / cancel copy says "reversed ... contact support"; false for
inquiries; no mobile consumer yet).

## Operator decisions (recommended default first)
1. B-690-8: builder adds one coach-only restart route + controller test in #690 (fits: 2,792 of 3,000). Alternative: reclassify to
   C and make "restart route + mobile coach button (agent 123)" a hard gate on flipping FEATURE_DUNNING_V2. Either way the mobile
   button is needed before the flag flips.
2. C-689-6: defer (no consumer); fix together with the mobile card screen. Alternative: one-line copy change in #689 now.
3. #725 vs the train: both open the coach thread in the lockout guard (#725 exact METHOD+PATH pairs; D4 exact paths any method).
   Default: whichever lands second keeps one list and the route-table spec's expected list; no new audit beyond a merge check.

## HANDOFF
DONE 16:14 PDT. All nine verdicts posted (above). Next: builder fixes B-690-8 (or operator reclassifies); then a delta re-review of
#690 (changed lines + B-690-8) and merge-only checks on #691 by an Opus lens. Worktrees removed; anonymous mirror
wt/AUD-OPUS-DUN1-122-mirror.git removed. No ci/* or audit/* branches were created. Claims stay in ops/lanes122/claims.
