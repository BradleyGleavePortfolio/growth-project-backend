Split piece 4/9 of #634 (S-SCHED-2 native scheduling lifecycle), B-SPLIT-SCHED-120 (agent 120). Draft. Owner order 09:45 PDT 10-05: every piece under 1,500 changed lines.

## Tier header
- **Tier:** T4 (max-tier rule: piece of the T4 S-SCHED-2 split).
- **Why:** Concurrency and state authority for bookings: per-coach advisory-locked request/reschedule re-validated on fresh rows, the exclusion-constraint floor mapped to 409 SLOT_TAKEN, compare-and-set transitions on the booking revision, fenced provider write-back.
- **T4 trigger scan:** Read-access: booking writes go through SchedulingAccessService (1/9). RLS/money/PII: no (the lifecycle's no-pii legacy baseline entry is removed, count now 0). CI gate file: no.
- **T3 trigger scan:** Concurrency and state authority: YES. Schema: uses 1/9's columns and constraint. Routes: no (main's service and controller still call it until 6/9).
- **Bounded T1:** none.
- **Canonical builder:** B-SPLIT-SCHED-120 (agent 120), split of S-SCHED-2 (#634; builders agents 110-114, not self-audited).
- **Parent owner:** operator agent 120.
- **Acceptance evidence:** local (ops/heavy.sh, one spec at a time): tsc clean; scheduling.service 13/13 (the two completed-session cases assert 409 again), scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, availability-overrides 10/10, scheduling-providers 7/7, entitlement-guards-mounted 17/17, no-pii-in-logs 11/11, booking-emitter 21/21, booking-reminder.job 20/20, booking-reminder-local-time 8/8, google-calendar-webhook.controller 6/6, gcal-watch-startup 9/9, google-calendar.service 15/15, no-pii-probe-replays 13/13. The lifecycle's integrity regressions are in 7/9-9/9 because they drive the 6/9 service and the 5/9 job; 1,344 lifecycle lines leave no room for them here. Full suite and live lanes in this PR's CI.
- **Promotion triggers:** any change to the access predicate, the exclusion constraint, the occupying-status set, the transition fence, the reminder claim/lease semantics or the reminder switch semantics re-opens T4 review (as #634). No behaviour change beyond the main-merge resolution is allowed in the split.

## Contents (1355 changed lines vs base `agent120/sched-split-3-emitter`)
| File | Lines |
|---|---|
| `src/scheduling/scheduling-session-lifecycle.service.ts` | +972 / -372 |
| `test/privacy/no-pii-in-logs.spec.ts` | +0 / -1 |
| `test/scheduling.service.spec.ts` | +3 / -7 |

Live in this piece: the new lifecycle behind main's SchedulingService (the new TransitionOptions and constructor arguments are optional, so main's service compiles and calls it unchanged until 6/9). Reschedule never deletes reminder claims (claims are keyed by start_at, main B-647-1).

Every file in this piece is byte-identical to M.

## Split provenance
- Original: #634 (`agent110/s-sched-lifecycle`) @ `e18e8055454b04856d2c5ab5568d0a7127b74939` (30 files, +9,378/-1,286 vs merge-base 0d33c4d4).
- Reference merge M = `6fc88c457b917d74773f881ffed60c9d3f8d9d35` (branch `agent120/sched-split-0-merged-reference`): #634 @ e18e8055 merged with main `ee55f814eb02b530e6578a168dc16c7ea7e2b07b`, conflicts resolved once; `git show --remerge-diff 6fc88c45` shows every resolved hunk. M vs main: 33 files, +9,774/-1,454.
- Stack: #712 <- #713 <- #714 <- #715 (this) <- #716 <- #717 <- #718 <- #719 <- #720. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11). #653 (S-SCHED-5 request auto-expiry) restacks onto 9/9.
- Top-tree equality: `git rev-parse 6fc88c45^{tree}` == `git rev-parse c2b27193^{tree}` (9/9 head `c2b271936f47ecf1827f7a46607d29add381579f`) == `0595cfd70254cde577bf1cc3a844fa0c179c1d20`; `git diff 6fc88c45 c2b27193` is empty. No A/B fixes are included (the job is split only).

## Main-merge resolutions (all in M; full list in ops report B-SPLIT-SCHED-120)
Main #643/#647 (B-643-1, B-647-1/2, C-647-2/3, migration 20270301000000 applied in prod) re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE fence, made reschedule keep claims, and added zone provenance. R1 schema [1/9]; R2 lifecycle [4/9]; R3 reminder job [5/9]; R4 emitter [3/9]; R5 emitter spec [3/9]; R6 job spec [5/9]; R7 service spec [2/9, final in 6/9].
In this piece: R2 (reschedule takes #634's runBookingTx and CAS, drops #634's claim deleteMany per main B-647-1) and the two inlined safeLogDiagnostic log sites live here.

## Prior verdicts on #634 (evidence reuse is each lens's decision, byte-identical code only)
- Opus APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971916062
- Sol APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971921481
- FIX ROUND 5 @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971822865
- Operator update-branch @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972077899
- Opus merge-only APPROVE @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900 (Sol has no verdict at e18e8055)

## Decisions
- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (recommended default; the newer-than-20270316000000 rule does not apply to existing migrations). The two commute (20270222 adds state columns, indexes and the constraint; 20270301 adds start_at); `prisma migrate deploy` applies the unapplied one. Alternative: rename to a timestamp newer than 20270316000000.
- Reminder switch: unchanged from #634 (unset means off; set `BOOKING_REMINDERS_ENABLED=on` through the B-FLAGS manifest in the deploy window). Pairs with mobile #325 (OR-112-13).
