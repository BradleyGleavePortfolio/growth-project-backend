AUDIT Claude Opus 5.5 — growth-project-backend#712 @ 7fd99dce284405f018c545d31cdc1d3d25432f68 — VERDICT: APPROVE

A/B/C = 0/0/2

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 1/9 of the S-SCHED-2 split of #634, the foundation). It carries the schema, migration 20270222000000, the access gate for open slots, the slot computer, kinds, DTO and diagnostics. The base is main. This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone.

### Evidence reuse (G09) and the delta audited in full
- 12 files, +1,244/-115 = 1,359 (under 1,500). Every file is final (== M `6fc88c45`).
- Nine files are byte-identical to #634 at `e18e8055`, which my model's lens approved ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900)):
  - `notification-kind.ts`, `orm-diagnostics.ts`, `scheduling.dto.ts`, `scheduling-access.service.ts`, `scheduling-open-slots.service.ts`, `scheduling.types.ts` and `slot-computer.service.ts`
  - their two specs
- The changes since are `migration.sql`, `down.sql` and `schema.prisma`, and I audited them in full. The only change is the removal of `NotificationDeliveryLog.session_start_at`. The claim's start is now the existing `start_at` column of the applied 20270301000000 (B-NOTIF-4). The comment is restated, and `down.sql` no longer drops a column that this migration no longer adds. In particular, `down.sql` never drops `start_at`.

### Migration 20270222000000 against the applied 20270301000000 and 20270311000000 (D1: keep the name)
- **Static commute.** 20270222000000 touches:
  - `SessionType` (`is_welcome`, `default_meeting_url` with its CHECK, and the partial unique index for one active welcome type)
  - `CoachingSession` (the booking-revision and lifecycle columns, the range preflight, `btree_gist`, and the `no_overlapping_active_booking` exclusion constraint)
  - `NotificationDeliveryLog` (delivery state: status with CHECK, attempts, lease, token, per-channel receipts, and the `(kind, status)` index)
- 20270301000000 (zone provenance) adds `NotificationDeliveryLog.start_at`, backfills it from `CoachingSession.start_at`, sets it NOT NULL, and swaps the unique index to `(session_id, user_id, kind, start_at)`.
- So the two share no object. No later migration (20270223, 20270224, 20270225, 20270301 community_win, 20270311) references these columns.
- **Lane proof:** LANE_RESULT
- **Production preflight.** The operator ran it at 12:09: 0 overlapping active pairs and 0 inverted ranges, so the in-file preflight cannot abort the deploy.

### Safe alone (on main)
- Main's `SchedulingService` keeps its own reminder job and claim key. The new delivery-state columns are defaulted (`sent`, 1), and main writes 4-column claims.
- The new `SessionType` columns are written by nothing before 6/9, so `default_meeting_url` on main's raw list is always NULL.
- Main's open-slots route now goes through `SchedulingAccessService`, through `@Optional()` fallbacks. Its tests come in 7/9 to 9/9. The train lands as one, so this is accepted.

### C-712-1: the operator preflight queries are not in the PR body
- **Where:** `prisma/migrations/20270222000000_scheduling_lifecycle_integrity/migration.sql:28-29` says "Operator query to inspect before deploy is in the PR body". The body of #712 has no query.
- **Fix rule:** add the two read-only queries (overlapping active pairs per coach, and inverted ranges) to the body, so a later re-deploy or restore can repeat the check. The operator already ran both (0/0).

### C-634-11 (carried, mine): `instanceof Error` runs outside try
- **Where:** `src/observability/orm-diagnostics.ts:110`, `:125`, `:164-165`.
- **Problem:** a hostile error object (for example a Proxy with a throwing `getPrototypeOf` trap) makes the diagnostic itself throw inside a catch block.
- **Fix rule:** wrap the body after `safeDiagnostic` in try/catch, returning `'OtherError'`.

### CI at this head
- All required checks are green, including "Forward migrations apply cleanly", "New migrations are reversible" (the chain down and re-apply from the tip), Schema parity, rls-floor-guard and the live lanes.
- `git merge-tree` with current main `5da537d6` is clean.

### Method
- I read the code at the exact head and diffed it against `e18e8055`, M and main `ee55f814`.
- I compared migration objects with every later migration. Lane LANE_RUN.
- No local suites. Nothing was pushed to the PR branch.
