# 04 — Data lifecycle, privacy, export, delete

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

The platform stores per-client coaching artefacts (check-ins,
meal plans, messages, audit entries, AI context) plus per-coach
business state (subscription mirror, invoices, payment failures,
audit). GDPR + state privacy laws + every prospective enterprise
customer demands two things from us:

1. **Export.** A client (or coach) can request a complete export
   of their data within 30 days.
2. **Delete.** A client (or coach) can request hard-delete or
   anonymization within 30 days. Stripe-mirror rows have a
   different rule (financial-records retention).

Today the codebase has the foundations:

- `DataExportRequest` row + endpoint (`docs/audit-and-gdpr.md`).
- Soft-delete on `User` plus a periodic scrub
  (`cecaeb76 ops(gdpr): schedule periodic deletion scrub`).
- An audit-log convention (`AuditLog`, append-only).

What is missing is a **per-table retention matrix** that says,
for every model in `prisma/schema.prisma`, exactly: who owns the
row, what the retention rule is, what export includes, and what
delete does. Without that matrix, every new model is an open
question — the engineer adding `CoachAsset` (PR #117) does not
know whether `CoachAssetChunk` is exported, scrubbed, or deleted
when the coach is deleted.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | A team's data outlives any one staff member. Delete-the-staff-user must not delete the team's clients. |
| AI Program Builder | New tables (`CoachAsset`, `CoachAssetChunk`, `ProgramDraft`, …). Each needs an explicit retention rule. |
| Check-ins v2 | New columns inherit the existing check-in row's lifecycle. New attachment table introduces a media-blob lifecycle decision. |
| Public profiles | The **export** must not include public-profile content (it's already public). The **delete** must remove the profile. |
| Templates marketplace | Owner-coach delete should not orphan published templates other coaches depend on. |
| Revenue dashboards | Stripe-mirror is special — financial records have a regulatory retention floor. |

## WHEN

Settle this brief **before** AI Program Builder ships its first
table. The Builder schema introduces six new tables; each needs
a row in the matrix on the same PR that adds the table.

For check-ins v2, settle this brief before any column is added
to `CheckIn`. (Adding a column inherits the table's existing
rule, but the operator should re-confirm.)

## WHERE

- `docs/audit-and-gdpr.md` — extend with the per-table matrix.
- `prisma/schema.prisma` — every model gets a comment header
  pointing at its row in the matrix. (Already partially done for
  audit-log; extend.)
- `src/users/` — the soft-delete + scrub job lives near user
  lifecycle.
- `src/billing/` — Stripe-mirror retention rule lives near the
  billing module README.
- `src/admin/reports/` — exports are surfaced via the OWNER
  reports endpoint family.

## WHO

- **Owner:** backend lead.
- **Reviewers:** founder (for retention duration on
  business-critical tables), legal advisor when one is engaged.
- **On the hook in production:** OWNER. Honoring a manual
  deletion request is documented in
  `docs/audit-and-gdpr.md`.

## WHAT

### What already exists

- `DataExportRequest` model + endpoint.
- Soft-delete on `User` with a periodic scrub (PR #91).
- `AuditLog` append-only convention.
- The "honor a manual deletion request" operator path in
  `docs/audit-and-gdpr.md`.

### What is missing

- A **per-table retention matrix**. One row per model. Columns:
  | Column | Meaning |
  |---|---|
  | Model | Prisma model name |
  | Owner of the row | `User` (client/coach), `Coach` (coach), `OWNER` (platform), `Stripe` (mirror) |
  | Retention | Indefinite / N days after deletion / regulatory-floor |
  | Export | Yes / No / Redacted |
  | On hard-delete | Hard-delete / Anonymize / Retain (regulatory) |
  | On soft-delete | (during 30-day grace) Frozen / Suspended / Read-only |
  | Notes | Any nuance — e.g., "audit log retains user_id but no PII body" |
- A documented **export envelope shape**. One JSON structure,
  per-user, with one section per row of the matrix. Versioned;
  changing the shape is a Phase-A→Phase-C migration like
  lane #02.
- A documented **delete pipeline**. Today it's a single scrub job;
  Team Mode introduces a second pipeline (deleting a staff user
  must not delete the team's clients) that needs to compose with
  the first.
- A **residency posture** doc — proposed: we operate in a single
  region (Fly's primary), and we do not commit to per-region
  data residency. If a customer demands EU residency, that is a
  separate deployment.

### Per-table matrix (proposed initial entries)

This is a *draft* — the runtime PR fills it in completely. Today's
known rows:

| Model | Owner | Retention | Export | Hard-delete | Soft-delete |
|---|---|---|---|---|---|
| `User` | self | 30d after request | Yes | Anonymize | Frozen |
| `CoachProfile` | coach | tied to User | Yes | Hard-delete | Read-only |
| `CoachSubscription` | Stripe | 7y (financial) | Redacted | Retain | n/a |
| `Invoice` | Stripe | 7y (financial) | Redacted | Retain | n/a |
| `PaymentFailure` | Stripe | 7y (financial) | Redacted | Retain | n/a |
| `MessageDraft` | coach | 30d post-delete | Yes | Hard-delete | Read-only |
| `CheckIn` | client | 30d post-delete | Yes | Hard-delete | Read-only |
| `MealPlan` | client | 30d post-delete | Yes | Hard-delete | Read-only |
| `CoachGuideline` | coach | 30d post-delete | Yes | Hard-delete | Read-only |
| `ActivityEvent` | client | 30d post-delete | Yes | Hard-delete | Read-only |
| `AuditLog` | OWNER | 1y rolling | Redacted (no body) | Retain (anonymized) | n/a |
| `DataExportRequest` | self | 90d | n/a (this *is* the export) | Hard-delete | n/a |

Future rows (from PR #117 / #118):

| Model | Owner | Retention | Export | Hard-delete | Soft-delete |
|---|---|---|---|---|---|
| `CoachAsset` | coach | 30d post-delete | Yes | Hard-delete | Read-only |
| `CoachAssetChunk` | coach | 30d post-delete | Excluded (raw chunks; redundant w/ asset) | Cascade with asset | n/a |
| `ProgramDraft` | coach | 30d post-delete | Yes | Hard-delete | Read-only |
| `ProgramPublication` | coach | tied to published program | Yes | Hard-delete | Read-only |
| `Team` | OWNER (Team Mode) | 30d post-delete | Yes (team-owner side) | Anonymize | Frozen |
| `TeamMembership` | team | 30d post-staff-delete | Yes | Hard-delete | Read-only |
| `ClientAssignment` | team | tied to client | Yes | Hard-delete | n/a |

## HOW

### Operator handoff

- A manual delete request follows the steps in
  `docs/audit-and-gdpr.md` (existing). The matrix update adds
  one column to that runbook: "what the matrix says for this
  table."
- A manual export request: today it's a `DataExportRequest`
  insert + the endpoint. The matrix change adds the
  envelope shape so the exported JSON is self-describing.
- Quarterly: OWNER walks the matrix, confirms every model has a
  row, and signs off in the doc.

### Export envelope (proposed)

```json
{
  "schema_version": "2026-04-export-v1",
  "subject": { "user_id": "...", "role": "client", "exported_at": "..." },
  "sections": {
    "user": { ... },
    "coach_profile": null,
    "messages_outbound": [ ... ],
    "messages_inbound": [ ... ],
    "checkins": [ ... ],
    "meal_plans": [ ... ],
    "guidelines_received": [ ... ],
    "activity_events": [ ... ],
    "billing": { "redacted": true, "note": "Financial records retained per regulatory floor" },
    "audit_redacted": [ { "at": "...", "action": "..." } ]
  }
}
```

The shape is versioned. Phase-A → Phase-C deprecation rules
(lane #02) apply if it changes.

### Delete pipeline (proposed)

Two phases:

1. **Soft-delete (immediate).** User row is marked deleted.
   Reads from non-OWNER actors return 404. Existing scrub job
   continues to run on a schedule.
2. **Hard-delete (30 days later).** Scrub job hard-deletes all
   rows per the matrix (`Hard-delete` column). Anonymizes the
   rest (`Anonymize`). Leaves regulatory rows
   (`Retain`) with a foreign-key fix-up to a synthetic
   "deleted-user" row so referential integrity holds.

Team Mode adds a constraint: deleting a staff user does not
trigger this pipeline against the team's clients. The
pipeline keys on `User.role = 'CLIENT'` (or, in Team Mode,
`TeamMembership.role = null`) — staff deletes are a
separate, lighter-weight pipeline that only removes the
membership row.

## Risks

- **Stripe-mirror retention conflict.** Some jurisdictions
  require shorter retention than the 7-year financial floor.
  Mitigation: document that we apply the floor as the *minimum*;
  longer retention is allowed. Per-customer carve-outs are
  out-of-scope for this brief.
- **Backfill of existing rows on delete-pipeline change.**
  Mitigation: lane #07 (migration safety) covers backfill
  idempotency. The pipeline change goes through that gate.
- **AuditLog retention drift.** Mitigation: the matrix lists 1y
  rolling. The scrub job already exists for AuditLog
  (extend it; do not invent a new one).
- **Export envelope leaks PII via a new field.** Mitigation: the
  envelope is allow-list; new fields default to excluded.

## Dependencies

- Lane #03 (security posture) — the redaction rule for export
  composes with the public-profile redaction rule.
- Lane #07 (migration safety) — every matrix change that adds a
  scrub or a retention transformation is a migration-safety
  question.

## Acceptance criteria

1. ✅ `docs/audit-and-gdpr.md` is extended with the per-table
   matrix above. Every model in `prisma/schema.prisma` has a
   row.
2. ✅ The export envelope shape is documented in
   `docs/audit-and-gdpr.md`, versioned, and the version is
   asserted in the exporter's tests.
3. ✅ The delete pipeline composes with Team Mode (staff
   delete vs client delete is split). Documented in the same
   doc.
4. ✅ The residency posture is documented in
   `docs/security-posture.md` (lane #03).
5. ✅ `prisma/README.md` adds a one-line "see matrix" note next
   to each model list it carries.

## Test strategy

- **Unit:** export envelope has unit tests asserting (a)
  schema_version, (b) absence of disallowed fields per the
  matrix, (c) presence of every required section.
- **Integration:** the scrub job has tests that verify each
  matrix row is honored (hard-delete, anonymize, retain).
- **Manual:** OWNER runs the export, downloads the JSON,
  inspects against the matrix.

## Rollout & kill-switch

- Matrix is a doc — no rollout.
- Pipeline changes ship per lane #07 (migration safety). Each
  change is reversible via the lane #07 three-phase shape
  policy.
- Kill switch for the scrub job: an env-var
  `GDPR_SCRUB_ENABLED=false` (proposed). Defaults to on. Flip
  off if a regression is detected; OWNER triages.
