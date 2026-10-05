AUDIT Claude Opus 5.5 — growth-project-backend#720 @ c2b271936f47ecf1827f7a46607d29add381579f — VERDICT: APPROVE

A/B/C = 0/0/0

Job AUD-OPUS-SCHA-121 (agent 121). Tier T4 (piece 9/9 of the S-SCHED-2 split of #634). It carries the last part of the integrity spec, the live no-double-booking spec on real Postgres, and `ci.yml`, which is a CI gate file. This is the first review of the split. I judged the stack as a whole and this piece as safe on main alone.

### Whole stack
- tree(`c2b27193`) == tree(M `6fc88c45`) == `0595cfd7`. I checked this locally.
- M is #634 at `e18e8055`, which my model's lens approved ([5972118900](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-5972118900)), merged with main `ee55f814`.
- `git merge-tree` with current main `5da537d6` is clean. Main since `ee55f814` touches only `ci.yml` (a separate hunk, see below).

### Delta audited in full
- **`test/scheduling-lifecycle-integrity.spec.ts` part C** (+581, additions only, now final). In the C-634-6 catch-up block:
  - `failTakeovers` became `failClaimWrites('create' | 'updateMany')`. Under the 4-column key, the first claim for a moved session is an insert, and re-arming a parked row for the same start is an update. Both failures at the band's last tick are delivered on the next tick, never twice. The earlier start's rows are never rewritten.
  - The legacy start-less case is removed, because 20270301000000 backfilled `start_at` and made it NOT NULL. The covered case now also proves that catch-up logs neither a failure nor an uncovered session.
- **`test/scheduling-booking-concurrency.live.spec.ts`** (+633, final). It differs from `e18e8055` only in three places:
  - The `BookingEmitter` takes `prisma`.
  - The column list says `start_at`.
  - The B-634-7 live case now asserts the parked earlier-start row stays `parked` and that the new start gets its own `sent` claim on real Postgres.
  - It ran, and did not skip, in this head's mwb-3-live-tests job: `PASS test/scheduling-booking-concurrency.live.spec.ts`, 8/8 suites and 73/73 tests in that step.
- **`.github/workflows/ci.yml`** (+4, == `e18e8055`). It adds the live spec at the head of the mwb-3 jest list, with a comment.
  - The merge with main's #661 hunk keeps both entries (`checkout-settlement.live.spec.ts` stays). I checked this in the merge-tree result.
  - No permission, trigger, secret or gate changes.

### Piece boundary
- 3 files, +1,218 (under 1,500). Test and CI only.

### CI at this head
All checks that run on a stacked PR are green.

### Method
- I read the files at the exact head and diffed them against #719, M, `e18e8055` and main.
- I read this head's mwb-3-live-tests job log.
- No local suites. Nothing was pushed to the PR branch.
