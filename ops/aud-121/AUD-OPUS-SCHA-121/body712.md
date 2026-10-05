Split piece 1/9 of #634 (S-SCHED-2 native scheduling lifecycle), B-SPLIT-SCHED-120 (agent 120). Draft. Owner order 09:45 PDT 10-05: every piece under 1,500 changed lines.

## Tier header
- **Tier:** T4 (max-tier rule: piece of the T4 S-SCHED-2 split).
- **Why:** Persistent schema migration (booking revision, lifecycle and reminder delivery-state columns, the no-overlap exclusion constraint with its range preflight) and the new client read gate on open slots (SchedulingAccessService).
- **T4 trigger scan:** Read-access change: YES (open slots: a client sees only the head coach or an active sub-coach assignment; SchedulingOpenSlotsService builds its own SchedulingAccessService when none is injected, so the gate is live from this piece). RLS/tenancy: no new table; SessionType, CoachingSession and NotificationDeliveryLog keep their enabled and forced RLS. Money/auth/PII: no. CI gate file: no.
- **T3 trigger scan:** Schema migration: YES (20270222000000_scheduling_lifecycle_integrity, additive, with down.sql; byte-identical to M). Concurrency: the exclusion constraint is the floor that 4/9 maps to 409. Routes: no.
- **Bounded T1:** none.
- **Canonical builder:** B-SPLIT-SCHED-120 (agent 120), split of S-SCHED-2 (#634; builders agents 110-114, not self-audited).
- **Parent owner:** operator agent 120.
- **Acceptance evidence:** local (ops/heavy.sh, one spec at a time): tsc clean; log-diagnostic-closed-enum 12/12, slot-computer-bookable 7/7, slot-computer 14/14, availability-overrides 10/10, scheduling.service (main's spec) 12/12, scheduling-permissions 20/20, qa-p0-launch-blockers 17/17, entitlement-guards-mounted 17/17, scheduling-providers 7/7, no-pii-in-logs 11/11, scout-diagnostics-boundary 33/33, booking-emitter 10/10, booking-reminder.job 20/20, booking-reminder-local-time 8/8, notification-emitters 29/29. Full suite and live lanes in this PR's CI.
- **Promotion triggers:** any change to the access predicate, the exclusion constraint, the occupying-status set, the transition fence, the reminder claim/lease semantics or the reminder switch semantics re-opens T4 review (as #634). No behaviour change beyond the main-merge resolution is allowed in the split.

## Contents (1359 changed lines vs base `main`)
| File | Lines |
|---|---|
| `prisma/migrations/20270222000000_scheduling_lifecycle_integrity/down.sql` | +47 / -0 |
| `prisma/migrations/20270222000000_scheduling_lifecycle_integrity/migration.sql` | +134 / -0 |
| `prisma/schema.prisma` | +42 / -0 |
| `src/notifications/notification-kind.ts` | +5 / -0 |
| `src/observability/orm-diagnostics.ts` | +149 / -0 |
| `src/scheduling/dto/scheduling.dto.ts` | +41 / -0 |
| `src/scheduling/scheduling-access.service.ts` | +186 / -0 |
| `src/scheduling/scheduling-open-slots.service.ts` | +226 / -69 |
| `src/scheduling/scheduling.types.ts` | +84 / -0 |
| `src/scheduling/slot-computer.service.ts` | +87 / -46 |
| `test/log-diagnostic-closed-enum.spec.ts` | +151 / -0 |
| `test/slot-computer-bookable.spec.ts` | +92 / -0 |

Live in this piece: the open-slots access gate and bookable-aware slot computation. Inert until later pieces: the new columns (4/9-6/9), the new types and DTO fields (6/9), the new notification kinds and orm-diagnostics helpers (3/9-5/9).

Every file in this piece is byte-identical to M.

## Split provenance
- Original: #634 (`agent110/s-sched-lifecycle`) @ `e18e8055454b04856d2c5ab5568d0a7127b74939` (30 files, +9,378/-1,286 vs merge-base 0d33c4d4).
- Reference merge M = `6fc88c457b917d74773f881ffed60c9d3f8d9d35` (branch `agent120/sched-split-0-merged-reference`): #634 @ e18e8055 merged with main `ee55f814eb02b530e6578a168dc16c7ea7e2b07b`, conflicts resolved once; `git show --remerge-diff 6fc88c45` shows every resolved hunk. M vs main: 33 files, +9,774/-1,454.
- Stack: #712 (this) <- #713 <- #714 <- #715 <- #716 <- #717 <- #718 <- #719 <- #720. Land as one stack (MERGE_DEPENDENCY_GUIDE rule 11). #653 (S-SCHED-5 request auto-expiry) restacks onto 9/9.
- Top-tree equality: `git rev-parse 6fc88c45^{tree}` == `git rev-parse c2b27193^{tree}` (9/9 head `c2b271936f47ecf1827f7a46607d29add381579f`) == `0595cfd70254cde577bf1cc3a844fa0c179c1d20`; `git diff 6fc88c45 c2b27193` is empty. No A/B fixes are included (the job is split only).

## Main-merge resolutions (all in M; full list in ops report B-SPLIT-SCHED-120)
Main #643/#647 (B-643-1, B-647-1/2, C-647-2/3, migration 20270301000000 applied in prod) re-keyed reminder claims to (session_id, user_id, kind, start_at) NOT NULL with a FOR SHARE fence, made reschedule keep claims, and added zone provenance. R1 schema [1/9]; R2 lifecycle [4/9]; R3 reminder job [5/9]; R4 emitter [3/9]; R5 emitter spec [3/9]; R6 job spec [5/9]; R7 service spec [2/9, final in 6/9].
In this piece: R1 (schema) lives here; the migration's semantic follow-through (no session_start_at column) too.

## Prior verdicts on #634 (evidence reuse is each lens's decision, byte-identical code only)
- Opus APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971916062
- Sol APPROVE @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971921481
- FIX ROUND 5 @ 3d989702: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5971822865
- Operator update-branch @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972077899
- Opus merge-only APPROVE @ e18e8055: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900 (Sol has no verdict at e18e8055)

## Decisions
- D1 migration 20270222000000 sorts before the applied 20270301000000: keep the name (recommended default; the newer-than-20270316000000 rule does not apply to existing migrations). The two commute (20270222 adds state columns, indexes and the constraint; 20270301 adds start_at); `prisma migrate deploy` applies the unapplied one. Alternative: rename to a timestamp newer than 20270316000000.
- Reminder switch: unchanged from #634 (unset means off; set `BOOKING_REMINDERS_ENABLED=on` through the B-FLAGS manifest in the deploy window). Pairs with mobile #325 (OR-112-13).

