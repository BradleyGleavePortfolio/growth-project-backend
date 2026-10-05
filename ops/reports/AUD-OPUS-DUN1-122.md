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

## HANDOFF
In progress (15:4x). #725 posted. Train: waiting for the builder (heads unchanged at 15:42; nothing pushed).
