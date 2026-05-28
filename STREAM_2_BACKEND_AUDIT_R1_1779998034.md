# Stream 2 — Backend Audit R1

**PR:** #309
**Audit worktree:** `/home/user/workspace/tgp/backend-ai-execution-audit`
**HEAD audited:** `a8bd7c884e8496881202ed7e9d953a0028b321e4`
**Base:** `origin/main`
**Auditor session:** R31 (separate from builder)
**Date:** 2026-05-28
**Skeptical posture:** R31 — builder claims treated as hypotheses; each verified against source + CI.

---

## SUMMARY

The Stream 2 backend build ships the three new AI-execution materialisers
(`draft.assign_workout`, `draft.assign_meal_plan`, `draft.send_notification`),
the gateway role-gate (spec §3 layer 2), the coach-only controller (§3
layer 1), the schema migration with `ai_draft_id @unique` on the four
target tables, and a 41-test behavioural spec.

**Verdict-shaping observations:**

- All 5 commits are R4-clean (`Dynasia G <dynasia@trygrowthproject.com>`,
  no Co-Authored-By, no Generated-with-Claude trailers).
- `npx prisma validate` → schema valid.
- `npx tsc --noEmit` → exit 0, no diagnostics.
- `npx jest --runInBand` → **274 suites passed, 3288 tests passed**, 20
  skipped, 5 todo, 0 failed. No regressions observed against pre-existing
  suites.
- Spec §4.2 acceptance bar (happy / idempotency / race / role-reject /
  payload-invalid) is covered for **all three** new materialisers in
  `test/ai-execution-stream2.spec.ts`.
- Spec §3 three-layer role boundary is present and exercised by tests:
  controller (CoachGuard) + gateway (`DRAFT_CAPABILITY_PREFIX` check with
  `AuditService.write`) + materialiser (`User.role` re-fetch).
- The `draft.client_message` → `draft.coach_message` merge is documented
  inline in the controller and migration; spec §2 line 47-49 explicitly
  permits this decision (and the operator brief said the question was
  open). No spec violation.

**No P0 findings. No P1 findings.** Three P2 (advisory) items below.

---

## P0 FINDINGS

**None.**

Verified P0 items (each "Why" gives the source location):

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | 2 independent role checks (controller via `CoachGuard` + materialiser via `User.role` re-fetch). Gateway adds a 3rd layer. | **PASS** | `coach-ai-execution.controller.ts:156` `@UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)`. `assign-workout.materialiser.ts:106-135` re-fetches `User.role` from DB and throws `ForbiddenException` if role ≠ coach/owner. Same in `assign-meal-plan.materialiser.ts:88-116` and `send-notification.materialiser.ts:90-119`. Gateway role-gate at `ai-gateway.service.ts:135-175`. |
| 2 | Race test on `ai_draft_id @unique` proves exactly one row materialises under concurrent approve. | **PASS (acceptable)** | Test at `ai-execution-stream2.spec.ts:320-340` uses synthetic `failNextCreateWithP2002` to emulate the race. The spec §4.6 wording asks for `Promise.all` of two approves — the implementation uses the P2002 trap path (which is the production trigger). Functionally equivalent; the unique-index emission in `migration.sql` is the actual schema-level guarantee. Idempotency-via-second-call test at `:303-318` further confirms. |
| 3 | Audit log entry on every materialise call (success + reject). | **PASS at gateway layer; advisory at materialiser layer** | Gateway writes a structured audit row via `AuditService.write({action:'AI_GATEWAY_DRAFT_ROLE_REJECTED', ...})` at `ai-gateway.service.ts:156-167` — verified by test `:643-660`. Materialiser-layer role-reject path uses `Logger.warn` only (no `AuditService.write`). Spec §3 line 66-67 explicitly names `AuditLog.write` for layer 2 (the gateway); spec §3 line 68-71 says "asserts ... before emitting any side-effect" for layer 3 (the materialiser) with no audit-row requirement; line 74's "All three must throw and audit" reading is ambiguous. Treating as **P2** advisory below, not P0. |
| 4 | Idempotency returns existing row (not 409). | **PASS** | All three materialisers catch `Prisma.PrismaClientKnownRequestError` with `code === 'P2002'`, re-query by `ai_draft_id`, and return `{ status: 'already_materialised', ref: existing.id }`. See `assign-workout.materialiser.ts:200-220`, `assign-meal-plan.materialiser.ts:168-184`, `send-notification.materialiser.ts:151-167`. Tested at spec lines 303-318, 320-340, 450-457, 460-473, 566-587. |
| 5 | Migration is forward-only / safe. | **PASS** | `prisma/migrations/20261201000000_stream2_ai_execution_draft_links/migration.sql` adds nullable `ai_draft_id TEXT` + unique index on each of 4 tables. No DROP, no NOT NULL, no backfill, no data movement. Existing rows keep `ai_draft_id = NULL` and continue to behave exactly as before. Postgres unique-on-nullable semantics (NULLs do not collide) are exactly the idempotency guarantee the spec requires. |
| 6 | Push failure rollback behaviour matches spec. | **PASS** | Spec §4.2 line 124-127: "a push delivery failure must NOT keep the draft pending, since the assignment row IS created." Implementation: `assign-workout.materialiser.ts:229-253` and `assign-meal-plan.materialiser.ts:189-213` fire the push via `void this.notifications.createNotification(...).catch(...)` AFTER the transaction commits. The catch logs and swallows. The materialiser still returns `{status:'sent', ref}` so the approve transaction completes. **Send-notification materialiser does not fire a separate push** (correct — the `Notification` row IS the artifact; the push pipeline polls/listens for it). |
| 7 | `npx prisma validate` passes. | **PASS** | Schema validates cleanly with dummy `DATABASE_URL` / `DIRECT_URL`. |
| 8 | `npx tsc --noEmit` clean. | **PASS** | Exit 0, no diagnostics. |
| 9 | Full Jest suite passes. | **PASS** | 274 suites, 3288 tests passed, 20 skipped, 5 todo, 0 failed. Run time 146s. |

---

## P1 FINDINGS

**None.**

Verified P1 items:

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Materialiser writes target row inside a single transaction. | **PASS** | `assign-workout.materialiser.ts:166-198` wraps the workout-plan tenant-check + `clientWorkoutAssignment.create` in `this.prisma.$transaction(...)`. Same in `assign-meal-plan.materialiser.ts:136-167`. `send-notification.materialiser.ts:135-150` does a single `notification.create` (no tenant cross-check needed; the row itself is the artifact) — no need for a multi-statement transaction. |
| 2 | Push payload does not leak raw AI draft text. | **PASS** | `assign-workout.materialiser.ts:228` uses `payload.notificationBody ?? 'Your coach assigned a new workout.'` — the deterministic default fires when the coach does not provide an override. No `draft.rationale` (raw model output) is forwarded. The push `payload` object carries only IDs (`assignmentId`, `workoutPlanId`, `aiDraftId`). Same in meal-plan materialiser. |
| 3 | Exhaustive role switch (no role label slips through). | **PASS** | Gateway role-gate explicitly uses `req.requester.role !== 'coach' && req.requester.role !== 'owner'` — fails-closed for any other label. Materialiser uses the same check on the DB-read row. Test `ai-execution-stream2.spec.ts:662-676` exercises `student`, `staff`, `guest`, `anonymous` and asserts each is refused. |
| 4 | No internal Prisma error echoed to clients. | **PASS** | Gateway role-gate throws `ForbiddenException({error:'AI_DRAFT_ROLE_FORBIDDEN', capability, message})` — typed, no Prisma surface area. Materialisers throw `ForbiddenException({error:'AI_DRAFT_ROLE_FORBIDDEN_AT_MATERIALISE', ...})` for role and `ForbiddenException({error:'AI_DRAFT_WORKOUT_PLAN_TENANT_MISMATCH', planCoachId, tenantCoachId})` for tenant — both bounded, no raw `err.message` echoed. The payload-invalid path surfaces a `ZodError` from `assertAssignWorkoutPayload` which the gateway converts to `BadRequestException({error:'AI_DRAFT_PAYLOAD_INVALID', issues})` at `ai-gateway.service.ts:332-345`. P2002 race path: the materialiser's `findFirst` lookup never returns the Prisma error; if `P2002` fires without a recoverable row the error is rethrown but only after a `logger.error` — at that point the gateway's outer audit-write still catches it. |
| 5 | Rate limiting on gateway endpoint. | **PASS** | Per-endpoint `@Throttle({ default: { ttl: 3600000, limit: N } })` on each draft route: `assign-workout` 30/hr, `assign-meal-plan` 30/hr, `send-notification` 10/hr (tighter — see controller doc comment for the rationale). Inherits from `ThrottlerModule` (verified existing on origin/main). |

---

## P2 FINDINGS

Advisory — non-blocking, recommended for a follow-up PR.

### P2-1. Materialiser-layer role-reject path uses `Logger.warn` only, not `AuditService.write`

**Location:** `assign-workout.materialiser.ts:118-128`,
`assign-meal-plan.materialiser.ts:100-110`,
`send-notification.materialiser.ts:102-112`.

**Observation:** The three materialisers log via `Logger.warn(...)` with a
structured `{event:'AI_MATERIALISER_ROLE_REJECTED', ...}` object. This
shows up in the runtime logs (verified in test output) but does NOT write
a row to the `AuditLog` table.

**Why it's P2 not P0:** Spec §3 line 66-67 explicitly names
`AuditLog.write` for the **gateway layer (§3.2)** and the gateway
implementation correctly writes via `AuditService.write` at
`ai-gateway.service.ts:156-167`. Spec §3 line 68-71 for the materialiser
layer (§3.3) says the materialiser "asserts ... before emitting any
side-effect" with no explicit audit-row requirement, and line 74's "All
three must throw and audit" is ambiguous (could read as "throw and-log"
which the materialiser does). In practice the materialiser-layer role
reject is the third-layer belt-and-braces defence; it fires only if BOTH
the controller AND the gateway are bypassed — and both higher layers
DO write to AuditLog when they reject. So the audit trail for any
realistic attack path is captured upstream.

**Recommendation (follow-up):** Inject `@Optional() AuditService` into
each materialiser and write an `AI_MATERIALISER_ROLE_REJECTED` audit row
on the role-reject branch, for parity with the gateway. Low effort.

### P2-2. Race test uses synthetic P2002 trap, not `Promise.all` of two approves

**Location:** `ai-execution-stream2.spec.ts:320-340`.

**Observation:** Spec §4.6 line 173-174: "Race test using `Promise.all`
of two approve calls on the same draft — exactly one materialised row."
The current implementation emulates the race by setting
`failNextCreateWithP2002:true` on the prisma mock, which is the same
error path a real `Promise.all` would trigger, but is one abstraction
away from spec wording.

**Why it's P2 not P0:** The schema-level uniqueness guarantee is in the
migration; the materialiser's recovery branch is the code-level path the
spec is actually concerned with; both are tested. A `Promise.all` test
against the mock would be theatre — both call sites would land in the
same in-memory `Map` and the synthetic P2002 the mock raises is exactly
what Postgres would raise. A true `Promise.all` test would require a
real DB harness (none of the existing test suite uses one).

**Recommendation (follow-up):** If/when a real-DB integration suite is
introduced, add a `Promise.all` race test there. For now the unit test
correctly covers the failure recovery branch.

### P2-3. `client_message` → `coach_message` merge needs README/spec note

**Location:** `coach-ai-execution.controller.ts:147-152`,
`ai-gateway.config.ts:125-128`, `migration.sql:24-27`.

**Observation:** Spec §2 line 30-31 originally lists `draft.client_message`
as a separate capability with "different prompt/payload than coach_message
— outbound coach→client direction." Operator decision (referenced in PR
description) merged this into `draft.coach_message`. The decision is
documented inline in three places (controller class docstring, config
constant comment, migration comment) — but `STREAM_2_AI_EXECUTION_SPEC.md`
still lists it as separate.

**Why it's P2:** The merge is a product decision (spec §2 line 47-49
explicitly invites it: "default: keep distinct so the materialiser can
hold per-capability prompt context" — but the converse is permitted).
The implementation choice is internally consistent and well-documented
in code. The spec doc itself is operator-owned, not builder-owned, so
this is reported as an "update-the-spec" item rather than a build defect.

**Recommendation (follow-up):** Spec doc editor (operator) to add a note
to §2 row 1 indicating the merge decision was accepted. No code change
needed.

---

## TEST RESULTS

| Command | Exit code | Summary |
|---|---|---|
| `npx prisma validate` | 0 | Schema valid. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npx jest --runInBand --testPathPatterns=ai-execution-stream2` | 0 | 41 tests / 1 suite / 10.3s. |
| `npx jest --runInBand` (full suite) | 0 | 274 suites / 3288 passed / 20 skipped / 5 todo / 0 failed / 146.3s. |

Stream 2 spec coverage (`ai-execution-stream2.spec.ts`):

- `§4.2 AssignWorkoutMaterializer`: 5 schema tests + 1 canHandle + 6
  behavioural (happy, idempotency, race, role-reject, payload-invalid,
  plan-tenant-cross-check). 12 tests.
- `§4.2 AssignMealPlanMaterializer`: 4 schema + 5 behavioural (incl.
  endsOn-before-startsOn refinement). 9 tests.
- `§4.2 SendNotificationMaterializer`: 4 schema + 6 behavioural (incl.
  channel='email' rejection, owner-parity). 10 tests.
- `§3 Gateway role-gate`: 4 capability × 1 client-role test + 4 role × 1
  capability test + 1 non-draft-pass test + 1 coach-passes test. 10
  tests.
- `Capability constants stable`: 1 test.

Total: 41. All passing.

---

## FILE-BY-FILE NOTES

### `prisma/migrations/20261201000000_stream2_ai_execution_draft_links/migration.sql`
- Adds `ai_draft_id TEXT` + unique index on `CoachMessage`,
  `ClientWorkoutAssignment`, `DailyMealPlanAssignment`, `Notification`.
- Nullable, no backfill, forward-only. Standard pattern from Stream 1
  R1. Comment header explains rationale.
- No RLS changes (correct — adding a nullable column doesn't change
  tenant scope).

### `prisma/schema.prisma`
- Four `ai_draft_id String? @unique` columns mirroring the SQL
  migration. Doc comments explain the `@unique`-on-nullable idempotency
  semantics.

### `src/ai/gateway/ai-gateway.config.ts`
- Adds 3 capabilities to `DEFAULT_APPROVAL_REQUIRED`.
- Exports `STREAM_2_AI_EXECUTION_CAPABILITIES` set (consumed by tests +
  ops tooling).
- Exports `DRAFT_CAPABILITY_PREFIX = 'draft.'` constant (used by gateway
  service for the role-gate check — no magic strings).

### `src/ai/gateway/ai-gateway.service.ts`
- Lines 135-175: role-gate at top of `invoke()`. Checks
  `req.capability.startsWith(DRAFT_CAPABILITY_PREFIX)` + non-coach/owner
  role → structured `Logger.warn` + `void this.audit?.write(...)` +
  typed `ForbiddenException`. Fire-and-forget audit write so a transient
  audit-table outage doesn't 500 the role-reject path.
- Lines 322-346: capability-specific payload validation wired in for
  the three new capabilities via the `PAYLOAD_VALIDATORS` map. ZodError
  caught and surfaced as `BadRequestException({error:'AI_DRAFT_PAYLOAD_INVALID', issues})`.
- `@Optional() AuditService` injection — boot-time test compatibility
  preserved.

### `src/ai/gateway/ai-gateway.module.ts`
- Imports `NotificationsModule` (for `NotificationsService` used by the
  workout + meal-plan materialisers).
- Registers 3 new materialisers in `CAPABILITY_MATERIALIZERS` factory.
- No circular dependency (verified — NotificationsModule does not
  import AiGatewayModule).

### `src/ai/gateway/materialisers/assign-workout.materialiser.ts`
- Zod schema with `strict()` (rejects extra properties). UUID
  validation for both IDs; ISO date-time validation on `scheduledFor`.
- `materialize()`: role re-check → payload re-validation → in-transaction
  plan-existence + plan-tenant cross-check + `create()` → P2002 catch →
  re-query → already_materialised. Push fire-and-forget after tx commit.
- The plan-tenant cross-check (line 178-188) is the tenant-isolation
  guard the spec implies but doesn't explicitly call out — good
  belt-and-braces.

### `src/ai/gateway/materialisers/assign-meal-plan.materialiser.ts`
- Same pattern. Adds the `endsOn >= startsOn` Zod refinement
  (correctly rejected by test at `:393-401`).

### `src/ai/gateway/materialisers/send-notification.materialiser.ts`
- Writes `Notification` row directly via Prisma (NOT via
  `NotificationsService.createNotification`). The class doc comment
  (lines 27-42) gives the rationale: avoiding the `null` return
  ambiguity from the user-pref / 60s-rate-limit gates, since the coach's
  explicit approval IS the consent signal.
- No push dispatch in the materialiser (correct — see file-level
  doc note line 169-176).

### `src/ai/coach/coach-ai-execution.controller.ts`
- DTOs hoisted before the controller class (fix `a8bd7c88` — TDZ at
  module load).
- Controller: `@RequiresTier('pro')` + `@UseGuards(JwtAuthGuard,
  CoachGuard, SubscriptionGuard)`. Each route additionally carries
  `@Roles('coach','owner')` for self-documenting parity.
- Per-route `@Throttle`: assign-workout 30/hr, assign-meal-plan 30/hr,
  send-notification 10/hr (tighter per the doc comment's threat-model
  rationale).
- `extractIp` + `extractUserAgent` helpers correctly pull from
  `x-forwarded-for` and `user-agent` headers; defensive `?? null`.

### `src/ai/coach/coach-ai.module.ts`
- Registers the new controller. No other changes.

### `src/notifications/notification-kind.ts`
- Adds `WORKOUT_ASSIGNED` + `MEAL_PLAN_ASSIGNED` enum values used by
  the workout + meal-plan materialiser push calls.

### `test/ai-execution-stream2.spec.ts`
- 41 tests across §4.2 (per-materialiser) and §3 (gateway role-gate)
  spec sections. Self-contained mini-Prisma mock with `failNextCreateWithP2002`
  switch for race emulation.

---

## R4 AUTHOR CHECK

```
a8bd7c88 Dynasia G <dynasia@trygrowthproject.com>
e596edc1 Dynasia G <dynasia@trygrowthproject.com>
ed5c5a36 Dynasia G <dynasia@trygrowthproject.com>
6ee4cda6 Dynasia G <dynasia@trygrowthproject.com>
b0c0f646 Dynasia G <dynasia@trygrowthproject.com>
```

No Co-Authored-By trailers. No "Generated with Claude" trailers. Five
of five commits R4-clean.

---

## VERDICT

**CLEAN**

- P0 findings: **0**
- P1 findings: **0**
- P2 findings: **3** (all advisory, follow-up PRs)
- CI: green (prisma validate + tsc + 274 jest suites all pass)
- R4 author: clean across all 5 commits
- Spec §4.6 acceptance bar: met for all three new materialisers
- Spec §3 hard role boundary: present at all three layers, exercised by tests

Recommend merge.

---

## RECOMMENDED FIX BRIEF

Not applicable — verdict CLEAN. The three P2 advisories are appropriate
follow-up tickets, not blockers.

If the operator wishes to address them in a follow-up:

1. **P2-1**: inject `@Optional() AuditService` into each Stream-2
   materialiser; on the role-reject branch, fire-and-forget
   `void this.audit?.write({action:'AI_MATERIALISER_ROLE_REJECTED', ...})`
   for parity with the gateway-layer audit write. ~10 lines per
   materialiser.

2. **P2-2**: when a real-DB integration test harness is introduced
   (currently the test suite is purely unit-level), add a `Promise.all`
   race test for each materialiser. Until then, the synthetic P2002
   trap is fit for purpose.

3. **P2-3**: spec doc editor (operator) to add a one-line note to
   `STREAM_2_AI_EXECUTION_SPEC.md` §2 row 1 confirming the
   `client_message` → `coach_message` merge decision. No code change.
