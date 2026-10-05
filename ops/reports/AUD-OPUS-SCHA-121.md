# AUD-OPUS-SCHA-121 (Claude Opus 5.5 lens, agent 121) — scheduling split b#712-#720 + #653

Started 12:38 PDT 10-05. Queue: SCHA #712 7fd99dce, #713 a7c8b33a, #714 55dfbdce, #715 8040f149, #716 31318708; then SCHB #717 112e0452,
#718 6feb18bb, #719 c79c3e67, #720 c2b27193, #653 9a23e3b2. Heads verified on GitHub 12:39 and again right before each post.
Claims: ops/lanes121/claims/backend-<n>-<head8>-opus for #712-#716.
Worktrees: wt/AUD-OPUS-SCHA-121-1 (c2b27193, detached), wt/AUD-OPUS-SCHA-121-2 (7fd99dce, detached). Notes/verdict drafts/probes:
ops/aud-121/AUD-OPUS-SCHA-121/.

## Evidence base
- My model's lens approved #634 at e18e8055 (5972118900, merge-only after 3d989702 5971916062). Tree(#720) == tree(M 6fc88c45) ==
  0595cfd7 (verified locally). Files of M byte-identical to e18e8055 rest on that evidence; files changed since are audited in full:
  migration 20270222 (session_start_at removed), schema.prisma, booking.emitter.ts (R4), reminder.job.ts (R3), lifecycle (R2 + 2 log
  sites), tests/fakes.
- Every piece merges cleanly with current main 5da537d6 (git merge-tree, no conflict). Main since ee55f814 shares only ci.yml with the
  stack (separate hunks).
- Migration commute (static): 20270222 touches SessionType / CoachingSession / NotificationDeliveryLog columns that predate 20270301;
  20270301 adds NotificationDeliveryLog.start_at + re-keys the unique; no shared object; no migration after 20270222 (20270223, 20270224,
  20270225, 20270301 community_win, 20270311) references these tables. Lane proof pending (mig-1).

## Verdicts posted
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #713 | a7c8b33a | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/713#issuecomment-6001956738 |
| #714 | 55dfbdce | REQUEST CHANGES | 0/1/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/714#issuecomment-6001957114 |
| #715 | 8040f149 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/715#issuecomment-6001957517 |
| #716 | 31318708 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/716#issuecomment-6001957966 |
| #712 | 7fd99dce | pending mig-1 lane | | |

## Findings
- B-714-1 booking.emitter.ts:516 deliver() pushes the full in-app body (display names, coach-written type names) through legacy
  pushToUser to lock screens, for every BOOKING_* kind incl. reminders; main sends no booking push today. Breaks A6.5 "reminder pushes
  show no name" and the push stack's B-692-1 fixed per-kind lock-screen copy. Proof: the PR's own green test
  test/booking-emitter.spec.ts:126-139 (push body == 'Jamie asked for Quick Q/A Call on ...'). Fix: push leg uses fixed per-kind copy
  (#693 lock-screen-copy.ts wording; reminders may keep the time, no name); in-app row unchanged. Verify: probe
  ops/aud-121/AUD-OPUS-SCHA-121/probes/booking-lock-screen.probe.spec.ts (all 11 emitters, canary name + type).

## Follow-ups (C)
- C-714-2 (= builder C-S120-1) booking.emitter.ts:436 stored 24h title 'Session tomorrow'; fix: no relative day in the stored title.
- C-716-1 reminder.job.ts:601 dueIds skip precedes the start-mismatch park (:602-608): an old-start retry row stays unfinished while
  the new start is in band (<=10/30 min, no double send; >200 such rows pin the recovery page). Fix: park on start mismatch first.
- C-634-11 (carried, mine) orm-diagnostics.ts:109-170 instanceof outside try; fix: wrap after safeDiagnostic in try/catch -> OtherError.
- C-712-1 (to post with #712) migration.sql:28-29 says the operator preflight query is in the PR body; #712's body has none. Fix: add
  the two read-only queries (overlaps, inverted ranges) to the body. Operator already ran both 12:09 (0/0).

## Operator notes
- Cross-stack: push #692/#693 (cc0a167f) and this stack both rewrite src/notifications/emitters/booking.emitter.ts,
  scheduling-session-lifecycle.service.ts, test/booking-emitter.spec.ts, test/scheduling.service.spec.ts. #693 adds sendPush (outbox,
  generic copy, dedupe) to main's old emitter; #714 adds pushToUser to the new one. Whichever lands second must restack so booking pushes
  go through sendPush exactly once (never both senders, never names on the lock screen).

## Probes
- mig-1: audit/AUD-OPUS-SCHA-121/mig-1 (from #712 7fd99dce), run 37365508852 (queued 12:46; GitHub runner incident): production-order
  deploy of 20270222 (P1 deploy all but 20270222; P2 status/deploy applies it; P3 fresh chain; P4 prisma migrate diff prod-order vs
  fresh --exit-code; P5 catalog compare; P6 down.sql + re-apply round trip). Workflow: ops/aud-121/AUD-OPUS-SCHA-121/probe-mig-order.yml.

## Status
- [x] SCHA #713-#716 verdicts posted 12:59
- [ ] #712 (waits for mig-1)
- [ ] SCHB #717-#720, #653

## HANDOFF
In progress (13:00). Next: #712 verdict when mig-1 finishes (draft: APPROVE 0/0/1 with C-712-1 + carried C-634-11 if lane green), then
SCHB claims + verdicts.
