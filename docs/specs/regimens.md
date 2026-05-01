# Spec — Coach-created regimens / programs (multi-week orchestration)

**Roadmap row:** #34.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/34-regimens.md`](../architecture/handoff/34-regimens.md).
**Cross-references:** PR #121 spec
[`program-templates.md`](./program-templates.md) (#28 — single
template primitive); PR #117 RFC §3 (per-kind validators) and
§12 (transactional publish); merged
`WorkoutRoutine` / `MealPlan` / `Lesson` / `CoachGuideline`
families. Adjacent specs in this wave:
[`regimen-assignment.md`](./regimen-assignment.md) (#35 —
per-client assignment).

---

## 1. Status

Net-new feature. PR #121 spec #28 introduces the single-program
*template*; this spec introduces the multi-week *orchestration*
that sequences templates into a regimen. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #34."

## 2. WHY

A real-world coaching engagement is *multi-week*. A 12-week
hypertrophy program is not one workout routine repeated; it is
*a sequence* of weeks with progression, deload weeks, meal
adjustments, and reading material. Without a regimen primitive,
a coach has three bad options:

- Build one giant template (#28) and tell the client "follow
  this for week 5" (no progression model; cannot diff).
- Build twelve templates and clone them by hand each week (no
  sequence; no diff between weeks; no per-client cursor).
- Use the AI Program Builder (PR #117) to draft each week one
  at a time (works, but defeats the purpose of templated
  reuse).

The regimen primitive sits *between* templates and assignment
(#35). It says: "this is a 12-week sequence; week N is template
T_N; advancing happens automatically (or on coach approval)."

## 3. WHEN

Trigger conditions:

1. PR #121 spec #28 is reviewed and the `ProgramTemplate`
   schema is final. Regimens reference templates by id; the
   schema must stop moving before this spec's FKs land.
2. PR #117 RFC §12 (transactional publish) is reviewed
   against this spec's clone-on-assignment path; spec #35
   formalizes that path, but this spec's regimen-publish path
   reuses the same transactional shape.
3. Founder signs off on the per-tier regimen ceiling (#37).
4. Backend lead signs off on the regimen-version policy
   (publishing a new version creates a new row vs mutating
   the existing row; spec defaults to new-row, see §8).

## 4. WHERE

- **New module:** `src/regimens/` —
  `regimens.module.ts`,
  `regimens.controller.ts`,
  `regimens.service.ts`,
  `versions.service.ts`,
  `validate.service.ts`.
- **New tables:** `Regimen`, `RegimenVersion`, `RegimenWeek`,
  `RegimenBlock`.
- **New routes (paths under `/api/`):**
  - `GET /coach/regimens`
  - `GET /coach/regimens/:id`
  - `POST /coach/regimens`
  - `PATCH /coach/regimens/:id` (writes a new version)
  - `POST /coach/regimens/:id/versions/:version/publish`
  - `POST /coach/regimens/:id/archive`
  - `GET /coach/regimens/:id/versions/:version/preview`
  - `POST /coach/regimens/:id/duplicate`
  - OWNER:
    - `GET /admin/regimens`
    - `POST /admin/regimens` (platform-curated, visible
      read-only)
- **Reads:** `ProgramTemplate` (#28), `WorkoutRoutine`,
  `MealPlan`, `Lesson`, `CoachGuideline`, `ContentBoard`
  (#33).
- **No writes** to `WorkoutRoutine` / `MealPlan` / `Lesson` /
  `CoachGuideline` from this module — those writes happen at
  *assignment* (#35), not at regimen creation. A regimen is a
  recipe; the assignment is the bake.

## 5. WHO

- **Sign-off:** founder for the version policy and the
  per-tier ceiling; backend lead for the validator contract
  and the regimen→template→workout/meal/lesson lineage; product
  for the regimen-builder UX.
- **On the hook:** backend platform.
- **Downstream consumers:** spec #35 (assignment reads
  regimens), spec #36 (progress envelope reads
  per-assignment-week adherence), the coach-console BFF, the
  mobile API.

## 6. WHAT

**Already exists:**

- `ProgramTemplate` (PR #121 spec #28).
- The clone-into-`WorkoutRoutine` / `MealPlan` / `Lesson`
  transactional path (PR #117 §12 + spec #28 §"Clone").
- The per-kind validator pattern from PR #117.

**New surface:**

- The regimen as a versioned, multi-week recipe.
- The regimen-week as an ordered slot (1..N, N ≤ 52).
- The regimen-block as the unit attached to a week (one
  regimen-week may contain multiple blocks: a workout
  template, a meal template, a lesson template, a content
  board reference).
- The regimen-version policy (immutable on publish; PATCH
  writes a new draft version; published versions are
  append-only).
- A preview endpoint (resolve a version into the
  `WorkoutRoutine` / `MealPlan` / `Lesson` shape it would
  produce, *without* writing).

**Non-goals:**

- Per-client assignment — spec #35.
- Per-client adaptation (the "increase weight by 5lb if last
  week's RPE was X") — that is parking-lot row #04.
- Cohort / group regimens — parking-lot row #09.
- Real-time edits to a published version — by design, a
  published version is immutable; edits create a new version.

## 7. HOW

Smallest first PR: the migration + `GET /coach/regimens`
read-only against an empty table.

Rollout phases:

1. **Phase 1 — schema + read.** Migration, read endpoints,
   no writes.
2. **Phase 2 — coach create draft.** `POST /coach/regimens`
   creates a regimen + a draft version with zero weeks.
   `PATCH` adds weeks/blocks against the draft version.
3. **Phase 3 — publish + version policy.** `POST /publish`
   freezes the version; a subsequent edit creates a new
   draft version.
4. **Phase 4 — preview.** Preview endpoint resolves a
   version into the publish-target shape without writing.
5. **Phase 5 — duplicate.** `POST /duplicate` creates a new
   regimen seeded from an existing version (copies all blocks).
6. **Phase 6 — OWNER curated.** Platform-curated regimens
   visible read-only to all coaches.

Feature flag: `REGIMENS_ENABLED` (`off` | `coach_only` |
`on`). Default `off` until Phase 4.

## 8. Data model sketch

```prisma
enum RegimenState {
  draft
  published
  archived
}

enum RegimenBlockKind {
  workout_template       // FK to ProgramTemplate of type 'workout'
  meal_template          // FK to ProgramTemplate of type 'meal'
  lesson_template        // FK to ProgramTemplate of type 'lesson'
  guideline_template     // FK to ProgramTemplate of type 'guideline'
  content_board_ref      // FK to ContentBoard (#33)
  inline_note            // free-form text shown to the client at this week
}

model Regimen {
  id                          String                  @id @default(uuid())
  coach_user_id               String
  title                       String
  description                 String                  @db.Text
  state                       RegimenState            @default(draft)
  current_published_version   Int?
  acted_by_member_user_id     String?                 // PR #118 forward-compat
  created_at                  DateTime                @default(now())
  updated_at                  DateTime                @updatedAt

  coach                       User                    @relation(fields: [coach_user_id], references: [id])
  versions                    RegimenVersion[]

  @@index([coach_user_id, state])
}

model RegimenVersion {
  id                  String           @id @default(uuid())
  regimen_id          String
  version_number      Int              // monotonic per regimen, starts at 1
  state               RegimenState     @default(draft)
  total_weeks         Int              @default(0)
  notes_for_coach     String?           @db.Text
  notes_for_client    String?           @db.Text
  published_at        DateTime?

  regimen             Regimen          @relation(fields: [regimen_id], references: [id], onDelete: Cascade)
  weeks               RegimenWeek[]

  @@unique([regimen_id, version_number])
  @@index([regimen_id, state])
}

model RegimenWeek {
  id                  String           @id @default(uuid())
  version_id          String
  week_number         Int              // 1-indexed
  title               String?
  description         String?           @db.Text

  version             RegimenVersion   @relation(fields: [version_id], references: [id], onDelete: Cascade)
  blocks              RegimenBlock[]

  @@unique([version_id, week_number])
  @@index([version_id])
}

model RegimenBlock {
  id                  String              @id @default(uuid())
  week_id             String
  display_order       Int                 @default(0)
  kind                RegimenBlockKind
  template_id         String?              // FK ProgramTemplate (when kind ends in _template)
  content_board_id    String?              // FK ContentBoard (when kind=content_board_ref)
  inline_body         String?              @db.Text   // when kind=inline_note
  per_kind_config     Json                  // validator-specific

  week                RegimenWeek          @relation(fields: [week_id], references: [id], onDelete: Cascade)

  @@index([week_id, display_order])
}
```

**Version policy.**
- `POST /coach/regimens` creates a `Regimen` + a
  `RegimenVersion` with `version_number=1, state=draft`.
- `PATCH /coach/regimens/:id` mutates the *current draft*
  version. If no draft exists (only published versions), a new
  draft version is created from the latest published.
- `POST /coach/regimens/:id/versions/:version/publish` flips
  `state=published` on the version, sets
  `published_at=now()`, and updates
  `Regimen.current_published_version`. The version row is
  then **immutable** — every block in it is frozen.
- `POST /coach/regimens/:id/archive` flips
  `Regimen.state=archived`. Existing assignments (#35) referencing
  archived regimens continue to read; new assignments are
  rejected.

This policy means a single regimen can have an unbounded
version history — but only one published version at a time is
the "current." Assignments (#35) pin a version explicitly so an
assigned client never silently jumps to a new version.

## 9. API sketch

### Create + edit

`POST /api/coach/regimens`

Request:
```json
{
  "title": "12-week hypertrophy ramp",
  "description": "..."
}
```

Response (201): the regimen + the new draft `version_number=1`.

`PATCH /api/coach/regimens/:id`

Request: a JSON-merge patch. Operations supported:
- Add / remove / reorder weeks.
- Add / remove / reorder blocks within a week.
- Update block `template_id`, `inline_body`, `per_kind_config`.

The endpoint validates against the latest *draft* version;
published versions cannot be patched (returns 409).

`POST /api/coach/regimens/:id/versions/:version/publish`

Validation:
- All weeks have at least one block.
- Every `*_template` block resolves to an existing
  `ProgramTemplate` of the matching kind, owned by the coach
  *or* a platform-curated template.
- `total_weeks` matches the number of `RegimenWeek` rows.
- `version` is the latest draft (cannot publish an older
  draft over the head of a newer draft).

Effect: state flip, `published_at` set,
`Regimen.current_published_version` updated.

### Preview

`GET /api/coach/regimens/:id/versions/:version/preview?week=3`

Returns the *resolved* shape of week 3 — i.e., the
`WorkoutRoutine` / `MealPlan` / `Lesson` JSON the assignment
path (#35) would produce — *without writing*. Used by the
coach UI to render the week's content before assigning.

### Duplicate

`POST /api/coach/regimens/:id/duplicate`

Creates a new `Regimen` row owned by the same coach, seeded
from the source regimen's latest published version (or latest
draft if no published exists). Templates inside blocks are
referenced by id (not deep-copied), so editing a template in
the duplicate also affects the source regimen's blocks
*before publish*; after publish, blocks are frozen and the
template id reference is the only link.

## 10. Rollout / feature flags

- **Env var:** `REGIMENS_ENABLED` (`off` | `coach_only` |
  `on`). Default `off`.
- **Tier gate.** Per-tier max regimen count and per-regimen
  max `total_weeks` from #37. L1: 0 regimens. L2: 10
  regimens, ≤ 26 weeks each. L3: uncapped (subject to global
  hard cap of 500 per coach, 52 weeks each).
- **Fan-out order.** Backend → BFF → mobile read → mobile
  write (assignment ships in #35).

## 11. RBAC and privacy

- **Coach reads + writes** are scoped to
  `coach_user_id = req.user.id`.
- **Platform-curated regimens** (`coach_user_id` set to a
  platform service user) are **read-only** for non-OWNER
  coaches; the OWNER admin route is the only writer.
- **No client surface in this spec.** A client never reads a
  regimen directly; reads happen via assignment (#35).
- **Audit.** Every state transition writes an `AuditLog` row
  (`regimen_published`, `regimen_archived`,
  `regimen_version_created`).
- **GDPR.** Coach delete cascades the regimens (and via FK
  cascade, all versions and blocks). The cascade does **not**
  reach `WorkoutRoutine` / `MealPlan` / `Lesson` rows
  (those were created by the assignment path #35 and follow
  their own lifecycle).

## 12. Tests

- **Unit:**
  - Version-monotonicity: a publish on an older draft fails.
  - Block validator per kind.
  - Patch operations: add / remove / reorder weeks and
    blocks.
- **Integration:**
  - Create → patch → publish → preview round-trip on real
    Postgres.
  - Duplicate: edit template in original, observe published
    version of duplicate is unaffected.
  - Cascade delete on coach delete.
- **Smoke:**
  - `GET /coach/regimens` returns 200 (empty array).
- **Manual eval:**
  - Founder builds a real 12-week regimen on staging.

## 13. Risks

- **Version explosion.** A coach who PATCHes daily creates
  many draft versions. Mitigation: one *open* draft version
  at a time per regimen — PATCH writes against the open
  draft; a new draft is only opened when no draft exists.
- **Template drift in unpublished blocks.** A block points
  to a `ProgramTemplate` by id; if the template is edited
  before the regimen version is published, the block reflects
  the edit. This is by design (allows iterative authoring) but
  must be documented in the operator handoff.
- **Preview vs publish drift.** Preview must produce the
  *exact* shape publish would. Mitigation: the preview path
  delegates to the same `validate.service.ts` and resolution
  service the assignment path (#35) uses, with a "dry run"
  flag.
- **Archived regimen readable by assignment.** An assigned
  client must continue to read an archived regimen. The
  endpoint scoping for assignment (in #35) reads
  `Regimen.state` only at *assignment time*, not at every
  read. This must be tested in spec #35.

## 14. Dependencies

- **Roadmap rows.** #28 (templates), #33 (content boards),
  #35 (assignment — downstream), #37 (tier gate).
- **Existing modules.** `src/audit/`, `src/auth/`,
  `src/billing/` (`SubscriptionGuard`).
- **External services.** None.
- **Decisions that must close.**
  - Version policy (new-row default, confirmed).
  - Whether platform-curated regimens are visible to L1
    coaches as a read-only catalog (default yes; tiering may
    override).

## 15. Acceptance criteria

1. Migration adds the four tables idempotently with FKs.
2. Create → patch → publish → archive flow passes integration
   tests.
3. Duplicate flow preserves source-regimen integrity.
4. Preview produces the same shape as a hypothetical
   assignment.
5. Tier-gating verified for L1 / L2 / L3.
6. AuditLog rows written for every state transition.
7. Spec #35 integration plan signed off — the assignment
   path's clone-into-`WorkoutRoutine` is fed by the regimen
   shape defined here.
8. Handoff brief at
   [`../architecture/handoff/34-regimens.md`](../architecture/handoff/34-regimens.md)
   updated.

## 16. Operator handoff

- **Runbook entry**: flag flips, archive procedure, how to
  re-open a draft against a published version.
- **Dashboard tiles:**
  - "Regimens by state."
  - "Regimens published this week."
  - "Average regimen length (weeks)."
- **Alerts:**
  - Publish error rate > 2% (signals validator drift).
- **Kill switches:**
  - `REGIMENS_ENABLED=off` — disables routes.
