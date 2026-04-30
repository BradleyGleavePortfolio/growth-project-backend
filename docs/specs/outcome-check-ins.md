# Spec — Outcome check-ins (B7)

**Roadmap row:** #21.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/21-outcome-check-ins.md`](../architecture/handoff/21-outcome-check-ins.md).
**Cross-references:** PR #117 (AI Program Builder RFC §22 — the
Outcome Graph this feature feeds), PR #118 (Team Mode ADR — the
tenancy axis these tables must respect), PR #119 (expansion
roadmap row #21).

> **Do not implement from this spec without confirming the
> niche-field schema in §"Data model sketch" with the design-partner
> cohort first.** Per-niche fields are the schema decision the
> founder explicitly called out for a day-long modeling session.

---

## WHY

The existing `CheckIn` model in `prisma/schema.prisma:596` is a
**daily** wellness ping (mood, energy, soreness, sleep, weight). It
is essential for the day-to-day mobile UX, but it is the wrong
unit of analysis for **outcomes**. The Outcome Graph (the data
moat called out in the strategy memo) requires a **weekly**,
per-niche, structured artefact that can be aggregated across
clients, coaches, and time. A coach in the fitness niche needs to
record body composition, lift PRs, and adherence. A coach in the
business niche needs to record revenue, hours worked, and pipeline.
A daily wellness ping cannot do that work.

This spec defines a second check-in surface — `OutcomeCheckIn` —
that sits alongside the daily `CheckIn` and accrues the
proprietary, niche-specific outcome data the AI Program Builder
(PR #117) and the at-risk detector (roadmap #22) read.

## WHEN

Trigger conditions for opening the first runtime PR:

1. The design-partner cohort (B10) is signed and the schema-design
   session for B7 has concluded with niche-field definitions for at
   least two niches (fitness, business).
2. The AI Program Builder RFC (PR #117) has resolved §17 open
   question on whether the Builder reads the daily `CheckIn`, the
   weekly `OutcomeCheckIn`, or both. (Default per this spec: both.)
3. The Team Mode ADR (PR #118) has answered §10 on whether
   per-staff attribution is required at the outcome-check-in level
   (default: yes, via `acted_by_member_user_id` once Team Mode
   ships).

## WHERE

- New module: `src/outcome-check-ins/` — controllers, service,
  module, DTOs.
- New table family: `OutcomeCheckInTemplate`, `OutcomeCheckIn`.
  Adjacent to `CheckIn` (`prisma/schema.prisma:596`).
- New routes (paths under `/api/`):
  - `GET /coach/outcome-templates`
  - `POST /coach/outcome-templates`
  - `PATCH /coach/outcome-templates/:id`
  - `GET /coach/clients/:clientId/outcome-check-ins`
  - `POST /coach/clients/:clientId/outcome-check-ins`
  - `GET /me/outcome-check-ins/weekly`
  - `POST /me/outcome-check-ins`
- Federation: emits a new analytics event family
  (`outcome_check_in.submitted`, `outcome_check_in.skipped`).
- Reads: the at-risk detector (#22), the weekly recap (#23), the
  AI Program Builder (PR #117), the OWNER metrics endpoint
  (`src/admin/metrics.service.ts`).

## WHO

- **Sign-off:** founder (Bradley) for the niche-field shapes;
  backend lead for the table layout; design-partner cohort for the
  weekly cadence.
- **On the hook:** backend platform.
- **Downstream consumers:** coach console (template editor + per
  client weekly view), mobile (client-facing weekly form), the AI
  Program Builder.
- **Not on the hook:** the `new-website` repository — this is a
  hard boundary per `coach_os_strategy_memo.md` and `CLAUDE.md`.

## WHAT

### Already exists

- `CheckIn` model — daily wellness ping. Stays exactly as it is.
- `CheckInType` enum (`prisma/schema.prisma:99`) — currently
  `morning | midday | evening`. **This spec does not extend that
  enum**; the new model uses its own type discriminator.
- `client-check-ins.controller.ts` and `coach-check-ins.controller.ts`
  — HTTP surface for the daily check-in.

### Net-new

- Two new Prisma models (data sketch below).
- One new module (`src/outcome-check-ins/`).
- One new feature flag, `OUTCOME_CHECKINS_ENABLED`.
- A seeded set of two starter templates (one fitness, one business)
  loaded by a guarded backfill script — not a migration.

### Non-goals

- This spec does **not** replace the daily `CheckIn`. The daily
  check-in stays the mobile-side primary input.
- This spec does **not** define the AI summarization of an outcome
  check-in. That is the weekly recap (#23).
- This spec does **not** define the at-risk thresholds. That is
  the at-risk detector (#22).
- This spec does **not** add a UI. The runtime PRs add API surface
  first; UI is a separate, smaller PR per consumer.

## HOW

Smallest first PR (PR-1):

- `prisma/schema.prisma`: add the two new models.
- `prisma/migrations/<ts>_outcome_check_ins/`: forward-only DDL.
  Creates two tables, three indexes, no FK to mobile-visible
  tables.
- `src/outcome-check-ins/outcome-check-ins.module.ts`: empty
  shell; not registered in `app.module.ts`.
- Feature flag `OUTCOME_CHECKINS_ENABLED` declared in
  `src/common/env-validation.ts` with a default of `false`.

PR-2 wires the module, exposes the templates API, and adds unit
tests against the empty schema. PR-3 adds the per-client weekly
endpoints and the analytics events. PR-4 ships the OWNER metrics
counters. PR-5 turns the flag on for the design-partner cohort.

## Data model sketch

The two models below are **proposals**. They are not present in
the schema today and this PR does not commit them. They are
written in Prisma syntax to make the review concrete.

```prisma
// One row per (coach, niche) — the coach's customized outcome
// check-in template. `fields` is JSON because per-niche field
// shape is intentionally loose, and validated at the DTO boundary
// against the niche's allow-list. Versioned (template_version):
// editing a template increments the version so historical
// OutcomeCheckIn rows still resolve their original schema.
model OutcomeCheckInTemplate {
  id               String   @id @default(uuid())
  coach_id         String
  coach            User     @relation("OutcomeTemplateCoach", fields: [coach_id], references: [id])
  niche            String   // "fitness" | "business" | "wellness" | "custom"
  title            String
  cadence          String   @default("weekly") // weekly | biweekly | monthly
  fields           Json     // [{ key, label, type, required, validation }]
  template_version Int      @default(1)
  is_active        Boolean  @default(true)
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt
  archived_at      DateTime?

  @@index([coach_id, niche])
  @@index([coach_id, is_active])
}

// One row per (client, template_version, period). The client
// submits one row per cadence period. `values` is the JSON payload
// validated against the snapshot of the template referenced by
// `template_version_snapshot`. `template_version_snapshot` is an
// inline copy (not a FK) so that editing a template does not
// retroactively invalidate historical submissions.
model OutcomeCheckIn {
  id                        String   @id @default(uuid())
  client_id                 String
  client                    User     @relation("OutcomeCheckInClient", fields: [client_id], references: [id])
  coach_id                  String
  coach                     User     @relation("OutcomeCheckInCoach", fields: [coach_id], references: [id])
  template_id               String
  template                  OutcomeCheckInTemplate @relation(fields: [template_id], references: [id])
  template_version_snapshot Json     // snapshot of the template `fields` at submission time
  period_start              DateTime @db.Date
  period_end                DateTime @db.Date
  values                    Json
  notes                     String?
  submitted_at              DateTime @default(now())
  acted_by_member_user_id   String?  // future Team Mode hook; nullable
  archived_at               DateTime?

  @@unique([client_id, template_id, period_start], name: "OutcomeCheckIn_client_template_period_key")
  @@index([coach_id, period_start])
  @@index([client_id, submitted_at])
}
```

Index choices:

- `(client_id, template_id, period_start)` unique index prevents
  duplicate submissions for the same period.
- `(coach_id, period_start)` supports the at-risk detector's
  weekly sweep across the coach's roster.
- `(client_id, submitted_at)` supports the per-client outcome
  history view.

## API sketch

All routes return the standard envelope (see
`docs/api-conventions.md`). Throttling: per-coach `30 req/min` on
template edit endpoints, per-client `5 req/min` on submission
endpoints (matches existing daily-check-in throttles).

```
GET /api/coach/outcome-templates
→ 200 { templates: OutcomeCheckInTemplate[] }
  COACH only; returns templates owned by the calling coach.

POST /api/coach/outcome-templates
body { niche, title, cadence?, fields: FieldDef[] }
→ 201 { template: OutcomeCheckInTemplate }
  COACH only. Validates `fields` against the niche's allow-list
  (see Validation rules below). Increments template_version on
  edit (PATCH) but the POST creates v=1.

PATCH /api/coach/outcome-templates/:id
body { title?, cadence?, fields?, is_active? }
→ 200 { template: OutcomeCheckInTemplate }
  Bumps template_version when `fields` changes; otherwise leaves
  it alone. Cannot change niche after creation (delete + recreate).

GET /api/coach/clients/:clientId/outcome-check-ins?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
→ 200 { rows: OutcomeCheckIn[] }
  COACH only. 403 if the client is not on the calling coach's
  roster (mirrors existing CheckIn coach guards).

POST /api/coach/clients/:clientId/outcome-check-ins
body { templateId, periodStart, periodEnd, values, notes? }
→ 201 { row: OutcomeCheckIn }
  Coach-side submission on behalf of a client (e.g. during a 1:1
  call). Audit-logged.

GET /api/me/outcome-check-ins/weekly
→ 200 { template: OutcomeCheckInTemplate, lastSubmitted: OutcomeCheckIn|null }
  STUDENT-side: returns the active template the client should
  fill in, plus the most recent submission so the client can
  see what changed.

POST /api/me/outcome-check-ins
body { templateId, periodStart, periodEnd, values, notes? }
→ 201 { row: OutcomeCheckIn }
  STUDENT-side: submission. Idempotent on
  (client_id, template_id, period_start) — re-POST replaces.
```

Field-validation rules:

- Each `fields[i]` carries `{ key, label, type, required, validation? }`.
- `type ∈ { number, text, scale_1_5, percent, currency_minor_units, boolean, date }`.
- `currency_minor_units` is the canonical money type — never floats.
- `validation` shape mirrors `class-validator` decorators (`min`,
  `max`, `regex`, `oneOf`).
- Per-niche allow-lists are enforced server-side; clients cannot
  smuggle arbitrary types in.

## Rollout / feature flags

- **Env var:** `OUTCOME_CHECKINS_ENABLED=true|false` (default `false`).
- **Kill-switch behavior:** when off, all routes return `404`
  (route-not-mounted, not `403`); the migration is harmless because
  the tables are unreferenced.
- **Fan-out order:**
  1. Backend ships migration + module + flag (off).
  2. Coach console reads templates behind a flag-gate.
  3. Mobile reads `/me/outcome-check-ins/weekly` behind a flag-gate.
  4. Flag enabled for design partners only (allow-list inside the
     env file: `OUTCOME_CHECKINS_ALLOW_COACH_IDS=...`).
  5. Flag enabled platform-wide once the threshold review (#22)
     has tuned its rules against the first month of data.

## RBAC and privacy

- COACH role required for all `/coach/*` routes.
- STUDENT role required for `/me/*` routes.
- Per-row tenancy: a coach may only read templates and submissions
  belonging to their own roster (`client.coach_id ===
  callingCoach.id`). Re-uses the existing `coach_id` self-relation
  on `User`.
- OWNER never reads `OutcomeCheckIn.values` directly; OWNER metrics
  read aggregated counts only.
- GDPR scrub coverage: when a client's account is hard-deleted,
  `OutcomeCheckIn` rows are cascaded via the existing
  `DataExportRequest` / GDPR pipeline (see
  `docs/audit-and-gdpr.md`). The template (owned by the coach)
  survives.
- Audit-logged actions: template create / edit / archive,
  coach-side POST on behalf of a client.

## Tests

- **Unit (`test/outcome-check-ins-template-validation.spec.ts`):**
  - Allow-list rejects unknown field types.
  - `template_version` increments only when `fields` changes.
  - Niche cannot be mutated by PATCH.
  - Currency fields are integers (minor units), not floats.
- **Integration (`test/outcome-check-ins-routes.int-spec.ts`):**
  - 403 when COACH reads another coach's templates.
  - 403 when STUDENT POSTs against a template that does not belong
    to their assigned coach.
  - Idempotent re-POST replaces the period row.
  - `template_version_snapshot` is preserved verbatim across
    template edits.
- **Smoke:** GET `/api/me/outcome-check-ins/weekly` returns the
  default template for a seeded design-partner client.
- **Eval:** none (no LLM in this spec).

## Risks

1. **Schema-by-committee drift.** If each coach designs their own
   fields, the cross-coach data moat collapses. *Mitigation:* per
   niche allow-list of field types and a small set of *canonical*
   field keys (e.g. `weight_kg`, `body_fat_pct`, `mrr_minor_units`)
   that the at-risk detector and the AI Program Builder can rely on.
2. **Daily / weekly confusion.** Coaches will assume the new
   weekly check-in replaces the daily one. *Mitigation:* the
   handoff brief, the help center article (#14), and the in-app
   copy must clarify the split.
3. **Template versioning bugs.** A coach edits a template after a
   client has submitted; the historical submission must still
   render. *Mitigation:* `template_version_snapshot` is an inline
   JSON copy, not a FK to a versioned row.
4. **Cross-tenant leakage.** A bug in the route guard could
   surface another coach's submissions. *Mitigation:* re-use the
   existing `coach_id` self-relation guard from
   `coach-check-ins.controller.ts`; cover with integration tests.
5. **GDPR scrub miss.** A new table family is the canonical source
   of GDPR scrub bugs. *Mitigation:* the GDPR scrub test in
   `audit-and-gdpr.md` must add `OutcomeCheckIn` to its coverage
   on the same PR that ships the migration.

## Dependencies

- **Roadmap #03 (Outcome Graph):** this is the data substrate.
- **Roadmap #22 (at-risk detector):** consumes the `(coach_id,
  period_start)` index on `OutcomeCheckIn`.
- **Roadmap #23 (weekly recap):** reads the latest
  `OutcomeCheckIn` per client.
- **PR #117 (AI Program Builder):** §22 of the RFC explicitly
  reserves the right to read both `CheckIn` and `OutcomeCheckIn`.
- **PR #118 (Team Mode):** `acted_by_member_user_id` is a
  forward-compatibility hook; until the Team Mode wiring PR ships,
  the column is always null.

## Acceptance criteria

The runtime PR series is "done" when:

- [ ] Migration applied in staging without downtime.
- [ ] `prisma/schema.prisma` includes the two models verbatim
      from this spec.
- [ ] All routes return the standard envelope and respect the
      throttle / RBAC posture above.
- [ ] Integration tests for cross-coach 403 paths pass.
- [ ] OWNER metrics endpoint exposes
      `outcome_check_in.submissions_last_30d` (count) and
      `outcome_check_in.coverage_last_30d` (distinct clients with
      ≥1 submission).
- [ ] PostHog events `outcome_check_in.submitted` and
      `outcome_check_in.skipped` fire and are visible in the
      taxonomy doc (`docs/metrics.md`).
- [ ] GDPR scrub covers the new tables (added to
      `docs/audit-and-gdpr.md`).
- [ ] Help center article exists explaining the daily-vs-weekly
      split.
- [ ] Operator handoff section below is moved into a deploy-runbook
      entry.

## Operator handoff

When this feature ships, the operator gets:

- **Kill-switch:** `OUTCOME_CHECKINS_ENABLED=false` in Fly secrets;
  re-deploy.
- **Allow-list:** `OUTCOME_CHECKINS_ALLOW_COACH_IDS=<comma-list>` to
  pin the rollout to design partners.
- **Dashboards:** OWNER metrics endpoint exposes weekly-coverage
  per niche; PostHog dashboard "Outcome check-ins" tracks
  submission rate and skip rate.
- **Alerts:** none on day one. Once #22 is wired, an alert fires
  when weekly coverage drops below the threshold for any single
  coach for two weeks running.
- **Runbook entry:** added to `docs/deploy-runbook.md` §"Outcome
  check-ins" — staged rollout, kill-switch, the schema-edit
  procedure (template_version bump), and the GDPR scrub coverage
  note.
