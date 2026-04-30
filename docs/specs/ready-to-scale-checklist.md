# Spec — Ready-to-scale checklist (B1)

**Roadmap row:** #25.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/25-ready-to-scale-checklist.md`](../architecture/handoff/25-ready-to-scale-checklist.md).
**Cross-references:** PR #119 (roadmap row #25), the existing
help center surface (`docs/help/`), the coach console BFF
(`docs/coach-console-integration.md`).

---

## WHY

The strategy memo describes B1 as: "extend profile readiness into
a 12-step 'ready to scale' business launch checklist; gate
optional features behind completion." The existing
`CoachProfile` (`prisma/schema.prisma:194`) carries pieces that
imply readiness — branding fields, business name, bio, invite
code — but there is no canonical, step-wise readiness object that
the coach console and the in-app prompts can read.

The checklist is the **coach-side analogue** of the help center's
self-serve onboarding: a small, opinionated set of states that
turn a freshly-created `CoachProfile` into a business that can
realistically take on clients. It is also the **gate** for
optional features (e.g. the public coach profile #27 won't be
discoverable until the underlying profile fields exist; the AI
weekly recap #23 won't be effective until voice #24 is set).

## WHEN

Trigger conditions:

1. The set of 12 steps is signed off by the founder (initial
   proposal in "Steps" below).
2. Each step's *source of truth* is identified — most steps are
   computed from existing tables, not stored as new fields.
3. The "gating" interface is agreed: optional features call a
   single `coachReadiness.isReadyFor(coachId, feature)` helper,
   not bespoke checks per feature.

## WHERE

- New module: `src/coach-readiness/` —
  `coach-readiness.module.ts`, `coach-readiness.service.ts`,
  `coach-readiness.controller.ts`, `steps/`.
- New table: `CoachReadinessStepOverride` — only for steps that a
  coach explicitly *dismisses* ("I do not want to set a logo;
  don't keep nagging me"). The default state is computed.
- New routes (paths under `/api/`):
  - `GET /coach/readiness` — full snapshot of all 12 steps.
  - `POST /coach/readiness/:stepId/dismiss`
  - `POST /coach/readiness/:stepId/undismiss`
- Reads:
  - `CoachProfile` for fields-based steps (logo, bio, business
    name, accent color, timezone).
  - `User` for client roster size.
  - `CoachAIVoiceSetting` (#24) for voice step.
  - `OutcomeCheckInTemplate` (#21) for outcome-template step.
  - `CoachSubscription` for billing-active step.
  - `MealPlan` / `WorkoutRoutine` count for first-program step.
  - `CoachMessage` count for first-message step.
- Read by:
  - Coach console (renders the checklist).
  - Public coach profile (#27) — gates the public route on
    `isReadyFor("public_profile")`.
  - Weekly recap (#23) — surfaces a suggestion when voice (#24)
    is unset.

## WHO

- **Sign-off:** founder for the 12-step list and the gating
  decisions; backend lead for the table layout.
- **On the hook:** backend platform.
- **Downstream consumers:** coach console; gated feature owners.

## WHAT

### Already exists

- `CoachProfile` fields described above.
- `CoachSubscription` (`prisma/schema.prisma:225`).
- The help center / setup checklist (`docs/help/`) — operator-
  facing doc.

### Net-new

- `CoachReadinessStepOverride` table (only carries dismissals).
- `src/coach-readiness/` module with one step-class per step.
- One feature flag, `READY_TO_SCALE_CHECKLIST_ENABLED`.
- One PostHog event family: `readiness.{viewed,step_completed,
  step_dismissed,fully_ready}`.

### Non-goals

- Not a *separate* onboarding UX. The checklist consumes the
  existing surface area; it does not replace the help center.
- No reminders / emails. The console renders it; emails are a
  separate surface (the existing onboarding sequence in
  `docs/emails/onboarding/`).
- Not configurable per-coach. The 12 steps are the same for every
  coach; the dismiss row is the only per-coach state.

## HOW

Smallest first PR (PR-1):

- Adds the `CoachReadinessStepOverride` model + migration.
- Adds the empty module shell.
- Adds the 12 step classes implementing
  `interface ReadinessStep { id; compute(coachId): Promise<{ done; reason? }>; }`.
- Adds unit tests against fixtures.

PR-2 wires the routes and the dismiss flow.
PR-3 has the public coach profile (#27) call
`isReadyFor("public_profile")` as a gate.
PR-4 turns on the flag.

## Steps (proposal — confirm with founder)

| # | Step id | Source of truth |
|---|---|---|
| 1 | `business_name_set` | `CoachProfile.business_name IS NOT NULL` |
| 2 | `bio_set` | `CoachProfile.bio.length > 50` |
| 3 | `logo_uploaded` | `CoachProfile.branding_logo_url IS NOT NULL` |
| 4 | `accent_color_set` | `CoachProfile.branding_accent_color IS NOT NULL` |
| 5 | `timezone_set` | `CoachProfile.timezone IS NOT NULL` |
| 6 | `billing_active` | `CoachSubscription.status IN ('active','trialing')` |
| 7 | `first_invite_sent` | `InviteCode WHERE coach_id = ... LIMIT 1` |
| 8 | `first_client_active` | `User WHERE coach_id = ... AND role = 'student'` |
| 9 | `first_program_published` | `MealPlan or WorkoutRoutine for any client` |
| 10 | `first_message_sent` | `CoachMessage WHERE sender_id = coach.user_id` |
| 11 | `outcome_template_configured` | `OutcomeCheckInTemplate.is_active = true` |
| 12 | `ai_voice_configured` | `CoachAIVoiceSetting present` |

The default optional-feature gates:

- `public_profile` — requires steps 1, 2, 4, 5.
- `weekly_recap` — requires steps 8, 12.
- `outcome_aggregations` — requires step 11.

## Data model sketch

```prisma
model CoachReadinessStepOverride {
  id          String   @id @default(uuid())
  coach_id    String
  coach       User     @relation("CoachReadinessOverride", fields: [coach_id], references: [id])
  step_id     String
  dismissed   Boolean  @default(true)
  reason      String?
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt

  @@unique([coach_id, step_id], name: "CoachReadinessStepOverride_unique")
  @@index([coach_id])
}
```

The override row exists only when a coach *deviates from the
default*. The "done" state of each step is recomputed on every
read; the override only flips a step from "incomplete" to
"dismissed" so the UI stops nudging.

## API sketch

```
GET /api/coach/readiness
→ 200 {
    steps: Array<{ id, label, done, dismissed, reason?, link?, order }>,
    completionPercent: number,
    gates: { public_profile: boolean, weekly_recap: boolean, ... }
  }
  COACH only. Computes every step in one shot; cache the result
  in-memory for 30s per coach to avoid refetch storms.

POST /api/coach/readiness/:stepId/dismiss
body { reason?: string }
→ 200 { step: { id, dismissed: true, reason } }

POST /api/coach/readiness/:stepId/undismiss
→ 200 { step: { id, dismissed: false } }
```

Throttle: `60 req/min`.

## Rollout / feature flags

- **Env var:** `READY_TO_SCALE_CHECKLIST_ENABLED=true|false` (default `false`).
- **Kill-switch behavior:** routes return `404` when off. The
  *gates* are enforced even when the flag is off if any consumer
  has wired them; the consumer's own flag is the kill-switch for
  its own gating.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Coach console renders the read-only snapshot.
  3. Dismiss flow lit up.
  4. First gated feature (#27 public profile) wires
     `isReadyFor("public_profile")`.
  5. Platform-wide.

## RBAC and privacy

- COACH role required.
- Per-row tenancy: a coach reads / edits only their own state.
- No client-side surface. No PII outside the coach themselves.
- OWNER metrics: `readiness.coaches_at_100pct`,
  `readiness.median_completion_pct`. Aggregates only.
- Audit log: `coach.readiness.dismiss` and
  `coach.readiness.undismiss`.

## Tests

- **Unit (per step in `test/coach-readiness-steps.spec.ts`):**
  Each step's `compute` against fixture rows. Boundary case for
  step 2 (bio at exactly 50 chars).
- **Unit (`test/coach-readiness-gates.spec.ts`):** `isReadyFor`
  returns the correct boolean given mixed step states.
- **Integration (`test/coach-readiness-routes.int-spec.ts`):**
  - `GET /readiness` returns all 12 steps for a fresh coach.
  - Dismiss persists; `done` does not flip; `dismissed` flips.
  - Cross-coach 403 on dismiss.
- **Smoke:** GET `/api/coach/readiness` returns 200 with 12 steps
  for the seeded coach.

## Risks

1. **Step drift.** A future feature adds a step but does not add
   the gating row. *Mitigation:* the step set lives in a single
   constants array; a CI test asserts the array length equals 12
   and that every step id is unique. Step #13 lands as a
   deliberate, reviewed PR.
2. **Stale cache.** A coach edits their bio; `GET /readiness`
   still says "incomplete" for 30s. *Mitigation:* the in-memory
   cache invalidates on every PUT to `CoachProfile` (a hook in
   the existing profile service).
3. **Misleading completion.** A coach has 12/12 but no real
   business. *Mitigation:* the OWNER metrics doc carries a clear
   note that "fully ready" is a *necessary, not sufficient*
   signal.

## Dependencies

- **#21 outcome check-ins:** step 11.
- **#24 coach AI voice:** step 12.
- **#27 public coach profile:** the first feature gated by the
  checklist.

## Acceptance criteria

- [ ] Migration applied.
- [ ] Twelve step classes implemented + tested.
- [ ] Three routes implemented + tested.
- [ ] First gated feature (#27) calls `isReadyFor`.
- [ ] OWNER metrics counters visible.
- [ ] PostHog events visible.
- [ ] Help center article links to the checklist.

## Operator handoff

- **Kill-switch:** `READY_TO_SCALE_CHECKLIST_ENABLED=false`.
- **Adding a step:** new step class under `steps/`, append to the
  constants array (PR-reviewed), CI test passes the new length.
- **Editing a step's source of truth:** edit the step class; no
  migration; the change is visible on next coach read.
- **Runbook entry:** added under "Coach-side surfaces."
