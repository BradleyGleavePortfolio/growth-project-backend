# PR #282 v2 — Nudge v1 re-audit (HEAD `2240ef95`)

**Verdict: CLEAN — 0 P0 / 0 P1 / 0 P2 / 7 P3**

(P0 / P1 / P2 / P3 / N-notes. v1's 1 surviving P2 [SUPPRESSED_QUIET_HOURS
dead constant] is unchanged and was never in the refix scope — flagged
in §Continuing, not blocking.)

> The three refix commits land cleanly. Every P1/P2 the refixer claimed
> to address is genuinely fixed — verified against the diff and the
> actual run-paths, not just the commit message. Full test suite passes
> 2933/2933, `tsc --noEmit` is clean, and a trial three-way merge with
> `origin/feat/dunning-v1-rewrite` now auto-resolves (no conflicts in
> `email.*`). The 5 P3s from v1 persist (none were claimed) plus a
> handful of small new P3 hardening notes from the refix surface.

---

## Verification of the 6 claimed fixes

### P1-1 · email merge collision — FIXED

`cb144154` moves the four nudge entries to the TOP of `EmailTemplateKey`
(`src/email/email.types.ts:7–16`) and `TEMPLATE_SUBJECTS`
(`src/email/email.service.ts:36–46`), above an explicit anchor comment
(`─── existing template keys below; append new keys above the legacy
block ───`).

Trial merge against `origin/feat/dunning-v1-rewrite`:

```
$ git merge --no-commit --no-ff origin/feat/dunning-v1-rewrite
Auto-merging prisma/schema.prisma
Auto-merging src/email/email.service.ts
Auto-merging src/email/email.types.ts
Automatic merge went well; stopped before committing as requested
```

No conflicts in `email.types.ts`, `email.service.ts`, or `schema.prisma`.
The dunning PR's appends (after `DUNNING_FINAL`) and the nudge PR's
appends (before the legacy block) now live in independent hunks.

### P1-2 · atomic 48h cap — FIXED

`bb627096` adds `cap_bucket DateTime?` + `@@unique([user_id, cap_bucket])`
on `NudgeLog`
(`prisma/schema.prisma:1952,1956`,
`prisma/migrations/20261002000000_nudge_v1/migration.sql:48,62–63`).
Reservation is wired into the engine at
`src/notifications/nudges/nudge-engine.service.ts:178–188` (process) and
`:337–341` (processExisting), placed **after** quiet-hours and
**before** delivery — exactly where the audit asked.

Race trace verified end-to-end:

1. Replica A at `*/15` boundary reads cap (no `sent`), passes quiet
   hours, calls `tryReserveCapBucket` → owns bucket K.
2. Replica B, 0.5s later, reads cap (still no `sent` — A hasn't called
   `finalize` yet), passes quiet hours, calls `tryReserveCapBucket` →
   PG raises 23505, Prisma maps to P2002, engine returns
   `status='suppressed_cap'`, no transport side-effect.

NULL semantics in PG unique indexes are exploited correctly: every
non-sent terminal leaves `cap_bucket=NULL`, so sibling
`deferred`/`suppressed_*` rows for the same user coexist. Confirmed in
schema (`@unique([user_id, cap_bucket])` with `cap_bucket` nullable)
and in the test fake (`test/nudge-v1-engine.spec.ts:72–86` enforces the
same NULL-distinct semantics).

The read-side cap check at `:142–153` is retained as a single-tick
fast-path so the common no-race case avoids one update round-trip.

Note: bucket is epoch-aligned floor at 48h granularity, NOT a sliding
window. Sliding semantics are preserved by the read-side check, which
is `now - 48h`. The bucket is purely the cross-replica serialization
primitive. Spec §3 ("max 1 nudge per user per 48h") is satisfied
because the read-side blocks any sequential <48h second send and the
write-side blocks the concurrent edge.

### P2-1 · `detectInactive` N+1 — FIXED

`src/notifications/nudges/nudge-detector.service.ts:303–375` is now a
single `user.findMany` plus two parallel `groupBy`s
(`checkIn.groupBy by ['user_id'] _max: { logged_at }` +
`notification.groupBy by ['user_id'] where: { read_at: not null }
_max: { read_at }`). Total: **3 DB round-trips regardless of user
count**.

Regression test `test/nudge-v1-detectors.spec.ts:353–383` fires 50
candidate users at the detector and asserts `userFindMany===1 &&
checkInGroupBy===1 && notificationGroupBy===1 &&
checkInFindFirst===0 && notificationFindFirst===0`. Plus a
`returns empty fast when there are no candidate users (no follow-up
groupBy)` test at `:385–394` confirming the no-users short-circuit.

NULL handling: users with zero check-ins / zero read notifications
produce no `groupBy` row → `lastCheckinByUser.get(u.id) ?? null` and
`lastNotifByUser.get(u.id) ?? null` → `maxDate(null, null) === null` →
`if (!lastActivity) continue` (`:362`). No false positives, no crashes.

### P2-2 · DST in `detectStreakBroken` — FIXED

`calendarDayDiff` and `localDateKey` exported helpers at
`nudge-detector.service.ts:400–423`. `localDateKey` uses
`new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month:
'2-digit', day: '2-digit' }).format(d)` — `en-CA` reliably renders
`YYYY-MM-DD` (this is its locale default). Confirmed with a manual
node spot-check (`'en-CA'` formats `2026-03-08T07:30:00Z` in
`America/Los_Angeles` as `'2026-03-07'`, matching test
`:444–448`).

Timezone source is `NotificationPreferences.timezone`, batched in a
single `findMany` (`:215–218`), fallback `'America/Los_Angeles'`
applied at `:224` (`tzByUser.get(user_id) ?? 'America/Los_Angeles'`).
Users with no prefs row → fallback. Schema column is
`String @default("America/Los_Angeles")` (not nullable,
`prisma/schema.prisma:861`) so the only path to fallback is "no row
at all" — exactly the case tested.

Tests cover spring-forward (23h day) at `test/nudge-v1-detectors.spec.ts:412`,
fall-back (25h day) at `:422`, same-day at `:431`, non-Pacific tz
(Tokyo) at `:437`, and `localDateKey` format at `:444`, plus two
end-to-end `detectStreakBroken` DST scenarios at `:452,498` and a
non-default tz scenario at `:512`.

### P2-3 · subscription-state gate — FIXED

`filterInactiveSubscriptions` at
`nudge-detector.service.ts:89–137` runs after all four detectors merge
in `scanAll` (`:62–71`). Reads:

* `coachSubscription.findMany where coach_id IN (userIds) select status` —
  drops users with status NOT IN `{'active', 'trialing'}` (set defined
  at `:35`). Verified against authoritative source:
  `CoachSubscription.status` taxonomy is `active | trialing | past_due
  | canceled | paused | incomplete | unpaid` (`schema.prisma:469`).
  All non-`{active, trialing}` are excluded.
* `clientPurchase.findMany where client_user_id IN (userIds) select
  entitlement_active` — drops users whose every purchase has
  `entitlement_active=false`. ANY active purchase → kept (test
  `:584` proves this with a mixed past_due/active set).

Users with NO billing rows (free / pre-paywall) are kept by
construction (no entry in `excludedCoach` or `excludedClient`).
Confirmed by test `:608` (all 6 candidates with no `coachSubs` or
`clientPurchases` rows are returned).

Trialing is explicitly included in active set
(`ACTIVE_COACH_SUB_STATES = new Set(['active', 'trialing'])`,
`:35`); test `:566` asserts `u-trialing` survives.

Empty-candidate fast path at `:92` (`if (candidates.length === 0)
return candidates`); test `:617` asserts neither
`coachSubscription.findMany` nor `clientPurchase.findMany` is called
in that case.

### P2-4 · `reprocessDeferred` + `processExisting` + cap collision tests — FIXED

Five new tests in `test/nudge-v1-engine.spec.ts`:

| # | Line | Name | Exercises |
|---|------|------|-----------|
| 1 | 383 | concurrent triggers collide on `cap_bucket` | `Promise.all(2 triggers)` → exactly one `sent` + one `suppressed_cap`; verifies the loser's `cap_bucket=null` |
| 2 | 423 | non-sent terminals leave `cap_bucket` null | muted user → status=`suppressed_muted`, `cap_bucket=null` |
| 3 | 436 | deferred → reprocessed → sent | 3am LA defers, 8:01am LA reprocesses, row finalises as `sent` with `cap_bucket!=null` |
| 4 | 475 | deferred row whose trigger is opted out between defer and reprocess | second pass finalises `suppressed_opt_out`, no cap reservation |
| 5 | 523 | idempotency: second reprocess of a sent row is a no-op | `reprocessDeferred` returns `0` on the second call |

All 5 tests directly exercise the claimed scenarios and pass:

```
PASS test/nudge-v1-engine.spec.ts (7.2 s)
  NudgeEngineService — five gates
    … 15 tests passed
```

The cap-collision test's fake Prisma at `:65–90` actually enforces the
`@@unique([user_id, cap_bucket])` constraint (rejects a second
`update` setting a duplicate non-null bucket for the same user) —
treating NULL as distinct just like real PG. This is a meaningful
test, not a tautology.

---

## Full test suite + `tsc --noEmit`

```
$ npx jest --runInBand
Test Suites: 253 passed, 253 total
Tests:       16 skipped, 5 todo, 2933 passed, 2954 total
Snapshots:   6 passed, 6 total
Time:        127.208 s

$ npx tsc --noEmit
(no output)
```

Refixer's 2933/2933 claim verified.

---

## P3 — new findings from the refix surface

### P3-N1 · `cap_bucket` is burned on `status='failed'` delivery

`nudge-engine.service.ts:184–193`: `tryReserveCapBucket` runs **before**
`deliver`. If every channel transport throws (`delivered.length === 0`)
the row is finalised as `'failed'` but `cap_bucket` remains set.
Result: the user's 48h cap slot is consumed by a delivery that produced
nothing, blocking the next 0–48h of legitimate nudges.

Severity: P3 — in-app delivery is best-effort-resilient and the worst
case is one missed nudge window. But strictly speaking spec §3 should
read "max 1 *delivered* nudge per 48h," not "max 1 attempted nudge."

Mitigation: on `FAILED` finalise, also `data: { cap_bucket: null }` so
the next tick can retry.

### P3-N2 · `localDateKey` does not validate the timezone string

`nudge-detector.service.ts:415–423` calls `new Intl.DateTimeFormat(...)`
directly with whatever `prefs.timezone` returns. The schema column is
`String @default("America/Los_Angeles")` so values from prefs creation
will always be valid, but a manual UPDATE or corrupt migration could
seed an invalid IANA value. `Intl.DateTimeFormat` will throw
`RangeError` and the surrounding `Promise.all([...detectors])` rejects
— the whole `scanAll` tick fails (one bad user kills the scan).

`QuietHoursPolicy.evaluate` already has `isValidTimeZone` (quiet-hours.policy.ts:157)
as a defensive wrapper; the detector should mirror it.

Severity: P3 — depends on data hygiene; not exploitable.

### P3-N3 · `Intl.DateTimeFormat` construction in a hot loop

`localDateKey` constructs a fresh `Intl.DateTimeFormat` on every call.
`detectStreakBroken` calls it once per check-in row (~90/user) plus
once per gap-walk step. At 10k candidate users × ~100 calls each =
~1M constructions per tick. Each is ~5–10µs of locale setup.

Severity: P3 — observable but not catastrophic (≤10s extra per tick on
a 15-minute cadence). Trivial cache by tz: `formattersByTz.get(tz) ??=
new Intl.DateTimeFormat(...)`.

### P3-N4 · dual-role user (coach + client) excluded if either side is lapsed

`filterInactiveSubscriptions:134` drops a user when `excludedCoach.has`
OR `excludedClient.has`. A coach with `CoachSubscription.status=active`
who is *also* someone else's client and has only canceled purchases on
that side is filtered out, even though they're an entitled paying
coach.

Population is small (users who are both coach and client) and the
impact is "calm-tone product fails to nudge an active coach,"
not a P&L hole. Mitigation would be to require BOTH (excludedCoach
AND excludedClient OR a per-role nudge dispatch). Severity: P3.

### P3-N5 · `IN` clause unbounded for large user sets

`detectInactive` passes `userIds` (potentially every account >7 days
old, no upper bound) into a `where: { user_id: { in: userIds } }`.
Beyond ~32k Postgres parameter binding the planner falls off the
index-scan fast path and Prisma's protocol gets unhappy. The previous
N+1 was worse, so this is a strict improvement, but at 100k+ active
accounts the IN list becomes a planning hazard.

Severity: P3 — same comment applies to `filterInactiveSubscriptions`
batch reads (`:99,103`). Mitigation: chunk `userIds` into 1k-element
batches.

### Continuing from v1 (unchanged)

* **P3-1** No nudge metrics counters — refix did not address; surface
  still relies on `groupBy` over `NudgeLog`.
* **P3-2** Trailing-comma subject when `first_name` empty
  (`'Pick up where you left off, '`) — `email.service.ts:43–44`
  unchanged.
* **P3-3** UTC-only detector windows for missed-checkin and inactive —
  unchanged. (`detectStreakBroken` is now local-time correct per
  P2-2 refix; the other two still use UTC ms math.)
* **P3-4** `status='reprocessing'` transient state has no reaper —
  `nudge-engine.service.ts:230` writes the state, no sweep job exists
  to recover crashed rows.
* **P3-5** `reprocessDeferred` `take: 200` `findMany` has no
  `orderBy` — `:211–222` unchanged.

---

## Continuing P2 from v1 (unchanged, not in refix scope)

* **P2-5** `SUPPRESSED_QUIET_HOURS` constant declared at
  `nudge.types.ts:25` but never written — quiet hours always uses
  `DEFERRED`. Dashboard/analytics queries filtering on
  `suppressed_quiet_hours` return empty. The refixer did not claim to
  address this, and it persists at HEAD. Flagging for completeness;
  not a merge-blocker (it's a documentation/observability seam, not a
  correctness defect).

---

## N — verified-clean

* **app.module.ts wiring**: `git diff 22f21caf 2240ef95 -- src/app.module.ts`
  produces only the expected `NudgeModule` import + provider (no
  unrelated churn). Module composition unchanged.
* **Schema collision vs PR #281**: trial three-way merge with
  `origin/feat/dunning-v1-rewrite` auto-resolves all three files
  (`prisma/schema.prisma`, `src/email/email.service.ts`,
  `src/email/email.types.ts`). No human conflict resolution required
  in either merge direction.
* **Migration safety**: `20261002000000_nudge_v1` uses `IF NOT EXISTS`
  throughout — replaying the migration is safe, additive-only, no
  destructive ALTERs. The unique index on
  `(user_id, cap_bucket)` is partial in the practical sense (NULLs
  are distinct in PG), so existing data with `cap_bucket IS NULL`
  cannot collide.
* **CLEAN BAR**: no controllers in `src/notifications/nudges/` → no
  auth/RBAC surface. No outbound HTTP → no SSRF. Every `catch (err)`
  in the nudge tree logs via `this.logger.{error|warn|debug}` — no
  silent swallowing. P&L / billing only consulted read-only via
  `filterInactiveSubscriptions`; no writes.
* **Race-window claim**: `tryReserveCapBucket` reservation sits
  strictly between `QuietHoursPolicy.evaluate` (gate 5) and
  `deliver()` (`:184–190` in `process`, `:338–342` in
  `processExisting`). Verified by reading the function bodies, not
  trusting the comment.
* **Idempotency**: existing `@@unique([user_id, trigger_type,
  signal_key])` is preserved alongside the new
  `@@unique([user_id, cap_bucket])`. No interaction (the dedupe
  index keys on always-non-NULL columns; the cap index keys on
  often-NULL `cap_bucket`).
* **Tests pass**: 2933/2933 ✓, 253 suites ✓, `tsc --noEmit` ✓.

---

## TL;DR + merge recommendation

The refixer's three commits (`cb144154`, `bb627096`, `2240ef95`) close
every P1 and P2 the v1 audit flagged as in-scope. Each fix was
verified at file:line, against the actual call graph, with a passing
regression test. No new P0/P1/P2 was introduced by the refix surface.
Five P3s carried over from v1 (all known and accepted at that
classification), and five new P3 hardening notes have surfaced — none
are merge-blockers and most are perf / data-hygiene polish.

The one v1 P2 still on the books (P2-5,
`SUPPRESSED_QUIET_HOURS` dead constant) was never in the refix scope
and remains a documentation/observability seam, not a correctness
defect.

**Verdict: CLEAN. Recommend merge.**

If the team wants to clear the P3 backlog in a follow-up sweep, prefer
P3-N1 (cap-burn on FAILED) and P3-4 (`reprocessing` reaper) first —
they're the two with the highest likelihood of producing a confused
"why isn't this user getting nudged" support ticket.

---

**Audit file path:** `/home/user/workspace/audits/pr282_audit_v2.md`
**Verified at HEAD:** `2240ef95`
**Worktree:** `/home/user/workspace/tgp/backend-282-audit-v2`
**Base for diff:** `origin/main` (`22f21caf`)
**Trial merge against:** `origin/feat/dunning-v1-rewrite` — clean
