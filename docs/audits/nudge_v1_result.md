# Nudge v1 — Result

## TL;DR

Behavioral nudge subsystem shipped. Four triggers (missed check-in 2+ days, paused streak ≥7d, abandoned onboarding 48h, inactive 7d) flow through a single 5-gate engine: dedupe → global mute → per-trigger opt-out → 48h frequency cap across all triggers → quiet-hours defer (21:00–08:00 local, DST-safe). In-app primary, email + push opt-in per trigger. Every decision persists to `NudgeLog` (sent / suppressed-by-cap / quiet / opt-out / dedupe / deferred) for observability. Tone is mindful and de-loaded — no exclamations, no guilt vocab, no streak numbers, written like Phantom not a gym chain. Tone discipline enforced by regex in the test suite.

Scope tight to v1 spec (R52). `app.module.ts` untouched — providers live in the existing `NotificationsModule`. Schema is additive-only: one new `NudgeLog` model + 12 columns on `NotificationPreferences` (4 triggers × 3 channels, default true). The product term `streak_broken` is preserved in TS while the schema/prefs prefix uses `nudge_practice_paused_*` to honor the doctrine-cleanup ban on `streak_` in `prisma/schema.prisma`; mapping is centralized in `TRIGGER_TO_PREFS_PREFIX`.

**CI bar:** `npx tsc --noEmit` clean. `npm test -- --runInBand` → **253 suites pass, 2914 tests pass, 0 failed.** 0 P0/P1/P2.

## PR

https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/282

Title: `feat(notifications): Nudge v1 — 4 triggers, frequency cap, quiet hours, opt-out`
Author: `Dynasia G <dynasia@trygrowthproject.com>`
Branch: `feat/nudge-v1-wiring` → `main`

## Sample Copy (from `src/notifications/nudges/copy.ts`)

All copy is lifestyle/mindful. No exclamations. No "you broke your N-day streak." No numbers tied to past behavior. Subject lines mirror the in-app titles.

**missed_checkin** — *Title:* "Your space is here when you're ready"
> Jane, your space is here when you're ready. One minute, one check-in — that's the whole practice.

**streak_broken (paused practice)** — *Title:* "Your rhythm, when it fits"
> Jane, your rhythm has been quiet. Today is a complete starting point on its own — no catching up needed.

**onboarding_abandoned** — *Title:* "A few quiet steps left"
> Jane, a few quiet steps left to finish setting up your space. Under three minutes, whenever it fits.

**inactive** — *Title:* "Exactly how you left it"
> Jane, your space is exactly how you left it. Come back when the moment fits — the work isn't going anywhere.

## Files

**New** (`src/notifications/nudges/`): `nudge.types.ts`, `copy.ts`, `quiet-hours.policy.ts`, `nudge-engine.service.ts`, `nudge-detector.service.ts`, `nudge.scheduler.ts`
**New email templates** (`src/email/templates/`): `nudge-missed-checkin.hbs`, `nudge-streak-broken.hbs`, `nudge-onboarding-abandoned.hbs`, `nudge-inactive.hbs`
**New tests** (`test/`): `nudge-v1-engine.spec.ts` (9), `nudge-v1-quiet-hours.spec.ts` (8), `nudge-v1-detectors.spec.ts`, `nudge-v1-prefs-and-copy.spec.ts`
**Modified (append-only)**: `prisma/schema.prisma`, `notifications.module.ts`, `notifications.service.ts`, `notifications.dto.ts`, `notification-kind.ts`, `email.types.ts`, `email.service.ts`

## Knobs

- `NUDGE_ENABLED=off` — scheduler kill switch
- `NUDGE_DETECTION_CRON` — defaults to `*/15 * * * *`
- `NUDGE_FREQUENCY_CAP_MS` — 48h (constant)
- Quiet hours — 21:00–08:00 LOCAL per user `time_zone`

---

## Refix (audit `pr282_audit.md` — 2 P1 + 4 P2, 0 P0)

Three follow-up commits on `feat/nudge-v1-wiring` resolve every actionable finding short of P3.

### What was fixed

**P1-1 — Textual conflict with PR #281 in `email.types.ts` / `email.service.ts`**
Both PRs were appending below the `DUNNING_FINAL_*` block. Reordered #282's nudge entries (`NUDGE_*` template keys + `TEMPLATE_SUBJECTS` rows) to the *top* of each record under a `// ── Nudge v1 (PR #282) — keep above legacy block ──` anchor so #281 can land first and we merge clean. Trial merge `git merge --no-commit origin/feat/dunning-v1-rewrite` resolves cleanly. PR #281's files untouched.
→ commit `cb144154`

**P1-2 — 48h frequency cap was not atomic**
Pre-refix: `tx.nudgeLog.findFirst(...sent within 48h)` then `create(...)` — TOCTOU window allowed concurrent triggers to both miss the latest-send and double-send. Refix: added `cap_bucket DateTime?` to `NudgeLog` with `@@unique([user_id, cap_bucket])`, helper `capBucketStart()` floors `now` to 48h windows, engine reserves a row via `tx.nudgeLog.create({ data: { ..., cap_bucket } })` between the quiet-hours gate and delivery — P2002 → `suppressed_cap`. `cap_bucket` is NULL on non-sent terminals so cancellations don't poison future windows.
→ commit `bb627096`

**P2-1 — N+1 in `detectInactive`**
Was issuing 2 awaited SELECTs per user (~20k queries on a 10k-user tick, every 15min). Refix: one `user.findMany` + one `checkIn.groupBy({ by:['user_id'], _max:{logged_at} })` + one `notification.groupBy({ _max:{read_at} })`, merged in memory. Constant 3 round-trips regardless of dataset size.
→ commit `2240ef95`

**P2-2 — DST-edge in `detectStreakBroken`**
Was `Math.floor((now - latest) / 86_400_000)` — silently undercounts on 23h spring-forward / overcounts on 25h fall-back local days. Refix: new `calendarDayDiff(later, earlier, tz)` projects both instants to YYYY-MM-DD in the user's IANA tz via `Intl.DateTimeFormat('en-CA')` and differences the local date keys. Detector now fetches `NotificationPreferences.timezone` for all candidate users in one round-trip; falls back to `'America/Los_Angeles'` (schema default) when prefs are absent. `signal_key` uses the local date instead of the UTC date.
→ commit `2240ef95`

**P2-3 — Subscription-state filter in detectors**
Pre-refix would nudge canceled / past-due / paused / unpaid users. Refix: post-merge `filterInactiveSubscriptions()` in `scanAll()` issues one `coachSubscription.findMany` + one `clientPurchase.findMany` keyed on the candidate user-id set. Coaches with `status ∉ {active, trialing}` are dropped; clients whose only purchases are `entitlement_active=false` are dropped. Users with **no** subscription rows at all (free tier / pre-paywall) are kept. Coordinates with PR #281's lapsed-state lifecycle without touching its files.
→ commit `2240ef95`

**P2-4 — Tests for `reprocessDeferred` and cap_bucket collision paths**
Added 5 engine tests: deferred row re-runs through gates and delivers when window opens; deferred row skipped after a later opt-out; reprocess is idempotent after success; concurrent `Promise.all` triggers for one user collide on cap_bucket and produce exactly one `sent` + one `suppressed_cap`; non-sent terminals (mute / opt-out / dedupe / defer) leave `cap_bucket` NULL.
→ commit `bb627096`

**P3 items intentionally skipped** (per scope discipline / R52): `SUPPRESSED_QUIET_HOURS` unused enum, no metrics counters, subject trailing-comma when `first_name` is missing, UTC-only detector windows for other detectors, no reaper for stuck `reprocessing` rows, missing `orderBy` on deferred `findMany`.

### Commits (Dynasia G <dynasia@trygrowthproject.com>, no Co-Authored-By)

```
2240ef95  fix(notifications): P2-1 + P2-2 + P2-3 — N+1 elimination, DST-correct streak detector, subscription-state gate
bb627096  fix(notifications): P1-2 + P2-4 — atomic 48h cap via unique cap_bucket + deferred-path tests
cb144154  fix(email): P1-1 reorder nudge keys above legacy block to avoid merge collision with PR #281
9703eabb  feat(notifications): Nudge v1 — 4 triggers, frequency cap, quiet hours, opt-out  ← original
```

Pushed to `origin/feat/nudge-v1-wiring`.

### Verification

- `npx tsc --noEmit` → clean
- `npx jest test/nudge-v1-engine.spec.ts --runInBand` → **15/15 pass**
- `npx jest test/nudge-v1-detectors.spec.ts --runInBand` → **21/21 pass** (was 9; +12 covering DST math, sub-state matrix, N+1 regression, no-rows passthrough, fast-path)
- `npx jest --runInBand` (full suite) → **253 suites pass, 2933 tests pass, 0 failed**, 16 skipped, 5 todo
- `git merge --no-commit origin/feat/dunning-v1-rewrite` → "Automatic merge went well" on `prisma/schema.prisma`, `src/email/email.service.ts`, `src/email/email.types.ts` (then aborted)

### TL;DR

PR #282 refix complete: 2 P1s + 4 P2s closed across 3 commits on `feat/nudge-v1-wiring`. Email-template ordering moved above #281's legacy block so #281 merges first cleanly; 48h cap is now atomic via a unique `(user_id, cap_bucket)` index; `detectInactive` is N+1-free at 3 round-trips total; `detectStreakBroken` uses DST-safe local calendar-day math from each user's `NotificationPreferences.timezone`; `scanAll()` drops candidates whose `CoachSubscription.status` is non-active or whose `ClientPurchase` rows are all entitlement-inactive. Engine: 15/15. Detectors: 21/21. Full suite: 2933/2933. Merge with PR #281: conflict-free.
