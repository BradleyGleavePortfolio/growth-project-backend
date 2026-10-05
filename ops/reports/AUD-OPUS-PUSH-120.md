# AUD-OPUS-PUSH-120 (Claude Opus 5.5 lens, agent 120 wave) — backend #692 P1 + #693 P2 (push notifications, T4)

Status: DONE (09:46 to 10:14 PDT 10-05). First full Opus review of both PRs; #648 verdicts not carried. Sol's comments for this round were not read before posting.

## Verdicts (posted at exact heads, heads re-read via REST at 10:12 PDT, unchanged)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #692 P1 | 27156167037d5c1be687c597ad349e5a151f5228 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/692#issuecomment-5999369595 |
| #693 P2 | 13417e7be58b96b6fccf203f71ec3b1f1ac8bb20 | REQUEST CHANGES | 0/1/9 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/693#issuecomment-5999369928 |

Comment bodies: ops/aud-120/AUD-OPUS-PUSH-120/comments/{692,693}.md

## State
- #692 base main, BEHIND main ee55f814; merge-tree with main clean; required checks green (forward/reversible migrations included). 815 lines (grandfathered).
- #693 base #692's branch; tree == #648 @ 22de1182; CI green (non-main-base set). 2,382 lines (grandfathered). merge-tree with main: CONFLICT in src/notifications/notifications.service.ts (CreateNotificationInput: main throttle_key vs push_twin).
- Migration 20270307000000 absent from production (operator 09:48); sorts before main's 20270311 (OR-113-4: acceptable).

## Probe run
- https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37345618739 (branch audit/AUD-OPUS-PUSH-120/693-probes-1 @ 9792c4f7 = #693 head + 2 specs + lane yml with Postgres 15; branch deleted after the run). Log: ops/aud-120/AUD-OPUS-PUSH-120/run-37345618739.log. Specs: ops/aud-120/AUD-OPUS-PUSH-120/probes/.
- 10 tests: 7 pass, 3 fail by design.
  - Live (Postgres, all pass): L1 two workers/two pools drain 30 rows, each sent once (real SKIP LOCKED claim); L2 concurrent same-event enqueue gives one row; L3 future row not claimed, unstarted lapsed lease released and sent once, handed-off lapsed lease closed; L4 receipts once across replicas, DeviceNotRegistered clears only that token, retention prunes; L5 manifest entry erases only the user's outbox rows; L6 migration backfill hides only proven twins.
  - Unit: U1 channelId 'default' (FAIL -> B-693-1); U2 stale "Session confirmed" at 08:00 (FAIL -> C-693-3); U3 connection refused dropped (FAIL -> C-693-4); U4 lock-screen copy control (PASS).

## Findings
- B-693-1 push-delivery.service.ts:540 `channelId: 'default'`; mobile creates only coach-messages, client-bot, milestones, system; Expo does not display pushes for a missing channel. Fix rule: map kind to an existing channel or omit; pin in a test.

## Follow-ups (C)
- C-692-1 #692/#693 PR bodies: no tier header. Fix rule: add Tier / Why / T4 trigger scan.
- C-692-2 prisma/schema.prisma PushOutbox, account-deletion.manifest.ts:249: counterpart names/ids kept 30 days after that counterpart deletes their account. Fix rule: null title/body/context/token once sent/dropped and receipt read.
- C-693-2 main refresh: keep throttle_key, channelGate/gateFrom, describeFailure; main payout-notice.service.ts:445-455 push row needs `push_twin: true` (else double inbox item vs :378-388).
- C-693-3 push-delivery.service.ts:324, :446: tie order by not_before only; non-reminder booking pushes not re-checked at send. Fix rule: order by not_before, created_at, id; drop superseded booking pushes.
- C-693-4 push-delivery.service.ts:610-617: connect-phase errors dropped. Fix rule: retry ECONNREFUSED/ENOTFOUND/EAI_AGAIN/UND_ERR_CONNECT_TIMEOUT.
- C-693-5 booking.emitter.ts:264-280: reschedule dedupe A->B->A->B loses a push. Fix rule: include oldScheduledAt.
- C-693-6 scheduling-session-lifecycle.service.ts:188, :281: requested/declined carry created_at, never urgent. Fix rule: pass session start.
- C-693-7 push-delivery.service.ts:245-249: collapse update count ignored. Fix rule: insert on count 0.
- C-693-8 (outside diff) users.service.ts:106-111: token not cleared from other users. Fix rule: clear same token elsewhere on register.
- C-693-9 (outside diff) direct pushToUser/pushToCoach senders bypass outbox/quiet copy (churn-intervention.service.ts:648 coach text on lock screen; dunning-v2.dispatcher.ts:169/282; coach-brief.scheduler.ts:402; coach-alerts.service.ts:244; workout-reminder.service.ts:302; nudge-engine.service.ts:417; drip-dispatcher.cron.ts:525; package-push.service.ts:734; purchase-fanout.service.ts:685; scout.service.ts:594). Fix rule: route through sendPush.
- C-693-10 keep a live Postgres spec for the claim SQL in CI (pattern L1-L4).

## Operator decisions (recommended default first)
1. Allow C-693-2 (payout-notice push_twin) in the #693 main refresh: YES (one line, otherwise money alerts show twice).
2. Merge #692 now or with #693: hold #692 until #693 is approved, then merge back to back; deploy only after #693.
3. Release dependency: mobile #341 (PUT /notifications/timezone) should ship with push; until then clients fall back to the coach's zone.

## Cleanup
- Remote audit/AUD-OPUS-PUSH-120/* deleted (0 remain). Worktree wt/AUD-OPUS-PUSH-120-1 removed. Claims left in ops/lanes120/claims/.

## HANDOFF
- #692: APPROVE at 27156167, no action needed from the builder.
- #693: builder fixes B-693-1 and does the main refresh (C-693-2 if the operator allows). Opus delta needed at the new head: channel map test, conflict resolution (throttle_key + push_twin), payout twin.
