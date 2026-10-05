Split piece 3/9 of #634 (S-SCHED-2 native scheduling lifecycle), B-SPLIT-SCHED-120 (agent 120). Draft. Owner order 09:45 PDT 10-05: every piece under 1,500 changed lines.

## Tier header
- **Tier:** T4 (max-tier rule: piece of the T4 S-SCHED-2 split).
- **Why:** Shared notification primitive rewrite (BookingEmitter): every booking event writes one in-app row and sends a real push with tap routing; user-facing copy (copy truth) and recipient time zones.
- **T4 trigger scan:** Read-access/RLS/money: no. PII: copy and payloads carry no free-form error text; the emitter's no-pii legacy baseline entry is removed (count now 0). CI gate file: no.
- **T3 trigger scan:** Shared notification primitive: YES. Schema/routes: no.
- **Bounded T1:** none.
- **Canonical builder:** B-SPLIT-SCHED-120 (agent 120), split of S-SCHED-2 (#634; builders agents 110-114, not self-audited).
- **Parent owner:** operator agent 120.
- **Acceptance evidence:** local (ops/heavy.sh, one spec at a time): tsc clean; booking-emitter 21/21, booking-reminder-local-time 8/8, booking-reminder.job 20/20, notification-emitters 29/29, no-pii-in-logs 11/11, scheduling.service 13/13, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, log-diagnostic-closed-enum 12/12, lockscreen-privacy 18/18, push-preference-defaults 16/16, notification-timezone-provenance 8/8, notification-local-time 11/11, billing-payout-failed 7/7, coach-new-purchase-prefs-routing 3/3, notification-prefs 15/15, purchase-fanout-coach-new-purchase 5/5, s-fee-r5-or-111-1 22/22, first-payment-throttle-rollback 3/3, drip-dispatcher.cron 32/32. Full suite and live lanes in this PR's CI.
- **Promotion triggers:** any change to the access predicate, the exclusion constraint, the occupying-status set, the transition fence, the reminder claim/lease semantics or the reminder switch semantics re-opens T4 review (as #634). No behaviour change beyond the main-merge resolution is allowed in the split.

## Contents (1382 changed lines vs base `agent120/sched-split-2-test-infra`)
| File | Lines |
|---|---|
| `src/notifications/emitters/booking.emitter.ts` | +477 / -150 |
| `src/scheduling/jobs/reminder.job.ts` | +1 / -1 |
| `test/booking-emitter.spec.ts` | +551 / -175 |
| `test/booking-reminder-local-time.spec.ts` | +14 / -12 |
| `test/privacy/no-pii-in-logs.spec.ts` | +0 / -1 |

Live in this piece: booking notifications from main's lifecycle and reminder job go through the new emitter (one in-app row plus push, zone via main's resolveRecipientTimeZone, no clock time without a usable zone).

## Intermediate lines (replaced by a later piece; the top equals M)
src/scheduling/jobs/reminder.job.ts line 123: the emit callback type widens from `Promise<void>` to `Promise<unknown>` (the new emitter returns a delivery result); 5/9 replaces the whole job with M's version. test/booking-reminder-local-time.spec.ts keeps main's world and takes the S-SCHED-2 wording without the call-link sentence (main's job does not pass the link state); 5/9 brings M's version with the call-link sentence.

## Split provenance
- Original: #634 (`agent110/s-sched-lifecycle`) @ `e18e8055454b04856d2c5ab5568d0a7127b74939` (30 files, +9,378/-1,286 vs merge-base 0d33c4d4).
- Reference merge M = `6fc88c457b917d74773f881ffed60c9d3f8d9d35` (branch `agent120/sched-split-0-merged-reference`): #634 @ e18e8055 merged with main `ee55f814eb02b530e6578a168dc16c7ea7e2b07b`, conflicts resolved once; `git show --remerge-diff 6fc88c45` shows every resolved hunk. M vs main: 33 files, +9,774/-1,454.
- Stack: #712 <- #713 <- #714 (this) <- #715 <- #716 <- #717 <- #718 <- #719 <- #720. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11). #653 (S-SCHED-5 request auto-expiry) restacks onto 9/9.
- Top-tree equality: `git rev-parse 6fc88c45^{tree}` == `git rev-parse c2b27193^{tree}` (9/9 head `c2b271936f47ecf1827f7a46607d29add381579f`) == `0595cfd70254cde577bf1cc3a844fa0c179c1d20`; `git diff 6fc88c45 c2b27193` is empty. No A/B fixes are included (the job is split only).

## Main-merge resolutions (all in M; full list in ops report B-SPLIT-SCHED-120)
Main #643/#647 (B-643-1, B-647-1/2, C-647-2/3, migration 20270301000000 applied in prod) re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE fence, made reschedule keep claims, and added zone provenance. R1 schema [1/9]; R2 lifecycle [4/9]; R3 reminder job [5/9]; R4 emitter [3/9]; R5 emitter spec [3/9]; R6 job spec [5/9]; R7 service spec [2/9, final in 6/9].
In this piece: R4 (emitter: main's zone rules, constructor (notifications, prisma), no-zone copy variants, 24h body names the date, `tz` required) and R5 (emitter spec, main's B-643-1 cases ported) live here.

## Prior verdicts on #634 (evidence reuse is each lens's decision, byte-identical code only)
- Opus APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971916062
- Sol APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971921481
- FIX ROUND 5 @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971822865
- Operator update-branch @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972077899
- Opus merge-only APPROVE @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900 (Sol has no verdict at e18e8055)

## Decisions
- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (recommended default; the newer-than-20270316000000 rule does not apply to existing migrations). The two commute (20270222 adds state columns, indexes and the constraint; 20270301 adds start_at); `prisma migrate deploy` applies the unapplied one. Alternative: rename to a timestamp newer than 20270316000000.
- Reminder switch: unchanged from #634 (unset means off; set `BOOKING_REMINDERS_ENABLED=on` through the B-FLAGS manifest in the deploy window). Pairs with mobile #325 (OR-112-13).
