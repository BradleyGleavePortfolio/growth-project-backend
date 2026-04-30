# Spec — Program-template models (B6)

**Roadmap row:** #28.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/28-program-templates.md`](../architecture/handoff/28-program-templates.md).
**Cross-references:** PR #117 (AI Program Builder RFC — these
templates are training-data and the UX pattern the Builder
generalizes), PR #119 (roadmap row #28), spec
[`intake-questionnaire.md`](./intake-questionnaire.md) (#26 — the
intake feeds the auto-generated first-week plan, which uses
templates).

---

## WHY

The strategy memo describes B6 as: "6 hand-built starter programs
across 2 niches, 1-click clone-to-workspace, edit-in-place."
Today, every coach assembles `WorkoutRoutine`, `MealPlan`, and
`Lesson` content from scratch per client — there is no notion of a
**template** in the schema. The blueprint explicitly notes that
B6 is *training data and a UX pattern* for the AI Program Builder
(PR #117): the Builder learns from, and outputs, the same
template shape the human library uses.

This spec defines the program-template family — a coach-private
(or platform-curated) library of reusable programs that can be
cloned into a client's workspace as live `WorkoutRoutine` /
`MealPlan` / `Lesson` rows in a single transaction.

## WHEN

Trigger conditions:

1. The AI Program Builder RFC (PR #117) §3 (data model proposal)
   is reviewed against this spec to confirm the template family
   and the Builder's `ProgramDraft` family are *additive* and
   non-overlapping.
2. The first six hand-built programs have copy approved by the
   founder.
3. The clone transaction shape is reviewed by the backend lead
   (the existing `WorkoutRoutine` / `RoutineExercise` /
   `MealPlan` / `Lesson` insert paths are touched in one
   transaction).

## WHERE

- New module: `src/program-templates/` —
  `program-templates.module.ts`,
  `program-templates.service.ts`,
  `program-templates.controller.ts`,
  `clone.service.ts`.
- New tables: `ProgramTemplate`, `ProgramTemplateSection`,
  `ProgramTemplateClone`.
- New routes (paths under `/api/`):
  - `GET /coach/program-templates` (own + platform)
  - `GET /coach/program-templates/:id`
  - `POST /coach/program-templates`
  - `PATCH /coach/program-templates/:id`
  - `POST /coach/program-templates/:id/archive`
  - `POST /coach/program-templates/:id/clone`
  - OWNER: `POST /admin/program-templates` (curated platform
    templates, visible to all coaches read-only).
- Reads / writes (during clone):
  - `WorkoutRoutine`, `RoutineExercise`,
  - `MealPlan`,
  - `Lesson` (`prisma/schema.prisma:554`),
  - `CoachGuideline` (`prisma/schema.prisma:732`).

## WHO

- **Sign-off:** founder for the six starter programs and the
  curation policy; backend lead for the clone-transaction
  contract.
- **On the hook:** backend platform.
- **Downstream consumers:** AI Program Builder (PR #117 — reads
  the template family for the publish-target shape and as
  fixture / few-shot input).

## WHAT

### Already exists

- `WorkoutRoutine` (`prisma/schema.prisma:463`) +
  `RoutineExercise` (`prisma/schema.prisma:477`).
- `MealPlan` (`prisma/schema.prisma:624`).
- `Lesson` (`prisma/schema.prisma:554`).
- `CoachGuideline` (`prisma/schema.prisma:732`).

### Net-new

- Three tables (sketch below).
- One module.
- One feature flag, `PROGRAM_TEMPLATES_ENABLED`.
- One PostHog event family:
  `program_template.{created,cloned,archived,visited}`.
- OWNER-only seed loader for the six starter programs (a guarded
  backfill script, not migration data).

### Non-goals

- Not a marketplace. Templates are private to the coach who
  created them (or platform-owned for the curated set). v2 may
  add coach-to-coach sharing.
- Not parameterized templates. v1 clones produce a literal copy
  the coach then edits. The "smart" template is PR #117.
- Not multi-niche cross-cloning. A "fitness" template clones
  into the same niche workspace; the niche field is metadata,
  not a transformation.
- Not a prompt cache for the AI Program Builder. The Builder
  reads the template family as fixture data; that posture is in
  PR #117, not here.

## HOW

Smallest first PR (PR-1):

- Adds the three models + migration.
- Adds the empty module shell.
- Adds the seeded six starter programs as a guarded backfill
  script (`scripts/seed-program-templates.ts`), not auto-run.

PR-2 wires the read routes (own + platform) and the clone
endpoint, with a single-transaction insert into the live tables.

PR-3 wires the OWNER curation surface.

PR-4 turns the flag on for design partners; turns it on
platform-wide once the curated set is finalized.

## Data model sketch

```prisma
model ProgramTemplate {
  id                  String   @id @default(uuid())
  // Owner: a coach (private) OR null for platform-curated.
  // owner_user_id is null when scope = "platform".
  owner_user_id       String?
  owner_user          User?    @relation("ProgramTemplateOwner", fields: [owner_user_id], references: [id])
  scope               String   @default("coach") // "coach" | "platform"
  niche               String   // "fitness" | "business" | "wellness" | "custom"
  title               String
  description         String?
  duration_weeks      Int
  // High-level metadata for filtering / search.
  tags                String[]
  hero_image_url      String?
  is_active           Boolean  @default(true)
  template_version    Int      @default(1)
  created_at          DateTime @default(now())
  updated_at          DateTime @updatedAt
  archived_at         DateTime?

  @@index([owner_user_id, is_active])
  @@index([scope, niche, is_active])
}

model ProgramTemplateSection {
  id                String   @id @default(uuid())
  template_id       String
  template          ProgramTemplate @relation(fields: [template_id], references: [id])
  // The discriminator + payload describe what concrete row(s) the
  // clone produces. Validated by the clone service against the
  // payload schema for each kind.
  kind              String   // "workout_routine" | "meal_plan" | "lesson" | "guideline"
  ordinal           Int      @default(0)
  // Free-form JSON payload, validated per kind. Contains all the
  // fields needed to materialize the live row (e.g. for
  // workout_routine: name + exercises[]).
  payload           Json
  notes             String?

  @@index([template_id, ordinal])
}

model ProgramTemplateClone {
  id              String   @id @default(uuid())
  template_id     String
  template        ProgramTemplate @relation(fields: [template_id], references: [id])
  template_version_snapshot Int  // freeze the version at clone time
  cloned_by_user_id  String  // the coach who triggered the clone
  cloned_into_client_id String? // the client whose workspace the clone targets; null if "to library"
  produced_workout_routine_ids String[]
  produced_meal_plan_ids        String[]
  produced_lesson_ids           String[]
  produced_guideline_ids        String[]
  created_at      DateTime @default(now())

  @@index([cloned_by_user_id, created_at])
  @@index([template_id, created_at])
}
```

`ProgramTemplateClone` is the audit row — it does not own the
materialized rows, but it links them so a coach can later say
"undo this clone" or so the Builder can read "what programs were
cloned how often."

## API sketch

```
GET /api/coach/program-templates?scope=coach|platform&niche=fitness
→ 200 { templates: ProgramTemplate[] }
  COACH only. Returns own coach-owned plus platform-curated.

GET /api/coach/program-templates/:id
→ 200 { template, sections: ProgramTemplateSection[] }

POST /api/coach/program-templates
body { title, niche, duration_weeks, description?, tags?, sections: [...] }
→ 201 { template, sections }
  COACH only. Validates section payloads per kind.

PATCH /api/coach/program-templates/:id
body { title?, description?, tags?, sections? }
→ 200 { template, sections }
  Bumps template_version when sections changes.

POST /api/coach/program-templates/:id/archive
→ 200 { template }

POST /api/coach/program-templates/:id/clone
body { clientId?: string }     // null = clone to coach's library only
→ 201 {
    clone: ProgramTemplateClone,
    produced: { workoutRoutineIds, mealPlanIds, lessonIds, guidelineIds }
  }
  Single transaction. Idempotency-key header recommended.

POST /api/admin/program-templates                   // OWNER only
body { ... } → 201 { template }                      // scope="platform"
```

Throttle: `30 req/min` reads, `10 req/min` clone (transaction
cost gate).

## Clone-transaction contract

- Wrapped in `prisma.$transaction([...])`.
- Order of inserts: parents first
  (`WorkoutRoutine`/`MealPlan`/`Lesson`/`CoachGuideline`), then
  children (`RoutineExercise`).
- Failure: full rollback; clone row is not written.
- Per-section payload validators are pure functions that produce
  the parameterized inserts. The validator surface is symmetrical
  to the AI Program Builder publish path (PR #117) so the two
  features share validators.
- Idempotency: an `Idempotency-Key` header is honored — same key
  inside a 24h window returns the existing clone row.

## Rollout / feature flags

- **Env var:** `PROGRAM_TEMPLATES_ENABLED=true|false` (default `false`).
- **Kill-switch:** routes return 404 when off.
- **Curated set:** `PROGRAM_TEMPLATES_PLATFORM_CURATED_ENABLED`
  is a separate sub-flag for the OWNER curation surface (so we
  can turn off curation while leaving coach-owned templates on,
  or vice versa).
- **Fan-out:**
  1. Migration + module + flag (off).
  2. OWNER curation seeds the six starter programs.
  3. Read routes lit for the cohort.
  4. Clone endpoint lit.
  5. Platform-wide.

## RBAC and privacy

- COACH for `/coach/*`. OWNER for `/admin/*`.
- Tenancy: a coach reads only their own templates plus platform
  templates. They cannot read another coach's templates.
- Clone target: the cloned-into client must be on the calling
  coach's roster (existing tenancy guard).
- OWNER never reads coach-owned templates' content for metrics;
  metrics are aggregate counts only.
- Audit log: `program_template.{created,cloned,archived}` and
  `admin.program_template.published`.
- GDPR scrub: a coach's account deletion archives their
  templates; clone audit rows persist with the coach's id but
  no template content (the template is archived but not deleted,
  so future audit queries resolve).

## Tests

- **Unit (`test/program-templates-validation.spec.ts`):**
  Per-kind payload validators (workout_routine, meal_plan,
  lesson, guideline). Reject unknown kinds.
- **Integration (`test/program-templates-routes.int-spec.ts`):**
  - Cross-coach 403.
  - PATCH bumps version only on sections change.
  - Archive hides from default list, included with `?archived=1`.
- **Integration (`test/program-templates-clone.int-spec.ts`):**
  - Clone produces all child rows in one transaction.
  - Idempotency-key returns the same clone row.
  - Cross-coach clone-to-client 403.
  - Failure rolls back all child rows (assert no
    `WorkoutRoutine` orphans).
- **Smoke:** OWNER seed loader runs on a fresh DB without
  errors and produces the six starter rows.

## Risks

1. **Cross-niche payload mismatches.** A "business" template
   carries a `workout_routine` section. *Mitigation:* the
   validator allows the cross, with a warning surfaced in the
   coach console; the niche is metadata, not a constraint, but
   the warning prompts a clean mismatch.
2. **Drift from `WorkoutRoutine` / `MealPlan` schema.** A future
   migration adds a required column; the template payload
   doesn't carry it. *Mitigation:* the per-kind validator imports
   the live insert DTOs and asserts compatibility at boot
   (existing pattern for the OWNER seed validator).
3. **Cost of the transaction at scale.** A 12-week template with
   80 exercises per week × 50 clients × concurrent clones.
   *Mitigation:* per-coach `10 req/min` clone throttle; the
   transaction is bounded; cost tested in load fixtures.
4. **Platform-curated content rot.** The six starter programs
   become stale and inaccurate. *Mitigation:* OWNER has an
   "archive + supersede" path; a `superseded_by` column may be
   added in a follow-up if ownership of curation grows.

## Dependencies

- **PR #117 AI Program Builder:** consumes templates as fixtures;
  shares per-kind validators.
- **#26 intake questionnaire:** the auto-generated first-week
  plan reads templates.

## Acceptance criteria

- [ ] Migration applied.
- [ ] Three tables exist with documented indexes.
- [ ] Per-kind validators reject malformed payloads with the
      documented error envelope.
- [ ] Clone is transactional; failure rolls back.
- [ ] Six starter programs seeded by the OWNER loader.
- [ ] OWNER metrics counter `program_template.clones_last_30d`
      visible.
- [ ] Help center article: "Using the program library."

## Operator handoff

- **Kill-switch:** `PROGRAM_TEMPLATES_ENABLED=false`.
- **Curation kill-switch:** `PROGRAM_TEMPLATES_PLATFORM_CURATED_ENABLED=false`
  removes the platform set from coach reads without affecting
  coach-owned templates.
- **Adding to the curated set:** OWNER loader script + a one-line
  PR; deploy.
- **Runbook entry:** added under "Coach-side surfaces."
