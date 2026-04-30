# Spec — Intake questionnaire templates + invite/onboarding wiring (B3)

**Roadmap row:** #26.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/26-intake-questionnaire.md`](../architecture/handoff/26-intake-questionnaire.md).
**Cross-references:** PR #119 (roadmap row #26), the existing
invite-landing surface (`docs/invite-landing.md`), the existing
invite-codes module (`src/invite-codes/`), the existing onboarding
email sequence (`docs/emails/onboarding/`), spec
[`outcome-check-ins.md`](./outcome-check-ins.md) (#21 — same niche
field-types vocabulary).

---

## WHY

The strategy memo describes B3 as: "DM script + welcome video slot
+ questionnaire + auto-generated first-week plan from answers."
The questionnaire is the **bridge between invite and onboarding**:
today, a client redeeming an invite code goes from
`InviteCode.redeemed_at` to a generic mobile onboarding flow, with
no per-coach customization. Coaches in the design-partner cohort
collect intake answers manually (Google Forms, Typeform, Notion,
DMs). Those answers are not visible to the platform, do not flow
into program drafting (PR #117), and do not feed the at-risk
detector (#22).

This spec defines a **coach-owned intake questionnaire** that the
client fills in immediately after redeeming an invite, before
the first session, with answers stored on the platform and
exposed to downstream features.

## WHEN

Trigger conditions:

1. Outcome check-ins (#21) are in flight; the field-types
   vocabulary is reused and must be stable.
2. The coach console design has space for an "Intake" tab.
3. A migration plan exists for the small population of clients
   who redeemed an invite *before* the intake feature ships:
   their state is "no intake completed," not "blocked."

## WHERE

- New module: `src/intake/` —
  `intake.module.ts`, `intake.service.ts`,
  `intake-templates.controller.ts`,
  `client-intake.controller.ts`.
- New tables: `IntakeTemplate`, `IntakeResponse`.
- New routes (paths under `/api/`):
  - `GET /coach/intake-templates`
  - `POST /coach/intake-templates`
  - `PATCH /coach/intake-templates/:id`
  - `POST /coach/intake-templates/:id/archive`
  - `GET /coach/clients/:clientId/intake`
  - `GET /me/intake/active`
  - `POST /me/intake`
- Hooks into:
  - `src/invite-codes/invite-codes.service.ts` — on redeem,
    snapshot the coach's active intake template into the new
    pending response row.
  - `src/auth/` signup-with-code path — same hook point.
  - `docs/emails/onboarding/` — first email links to the intake
    if the active template exists.

## WHO

- **Sign-off:** founder for the default starter templates;
  backend lead for the table layout; design-partner cohort for
  field iteration.
- **On the hook:** backend platform.
- **Downstream consumers:** AI Program Builder (PR #117 — first-
  week plan generation), at-risk detector (#22 — uses intake to
  set per-client thresholds), the coach console.

## WHAT

### Already exists

- `InviteCode` (`prisma/schema.prisma:329`).
- `User.coach_id` self-relation.
- The signup-with-code endpoint and the invite-landing surface
  (`docs/invite-landing.md`).
- Onboarding email sequence (`docs/emails/onboarding/`).

### Net-new

- Two tables (sketch below).
- One module.
- One feature flag, `INTAKE_ENABLED`.
- One PostHog event family: `intake.{template_published,
  response_started,response_submitted,response_skipped}`.

### Non-goals

- Not a full form builder. The field types are the same allow-list
  as the outcome check-in (#21) — the two surfaces share the
  vocabulary deliberately.
- No conditional logic ("if you said X, show Y") in v1. The form
  is flat. Conditional logic is a v2 feature.
- No file uploads in v1. The asset surface from PR #117 is the
  natural place for that, not the intake.
- No client-side persistence (offline). The form is short; an
  online-only submit is the v1 contract.

## HOW

Smallest first PR (PR-1):

- Adds the two models + migration.
- Adds the empty module shell.
- Ships two seeded starter templates (one fitness, one business),
  loaded by a guarded backfill script (not migration data).

PR-2 wires the templates routes.
PR-3 wires the client-side submission routes.
PR-4 wires the invite-redeem hook so the response row is
pre-created with the snapshotted template.
PR-5 wires the onboarding email link.
PR-6 turns the flag on.

## Data model sketch

```prisma
model IntakeTemplate {
  id               String   @id @default(uuid())
  coach_id         String
  coach            User     @relation("IntakeTemplateCoach", fields: [coach_id], references: [id])
  niche            String   // shares the niche vocabulary with OutcomeCheckInTemplate
  title            String
  fields           Json     // shares the field-types vocabulary with OutcomeCheckIn
  template_version Int      @default(1)
  is_active        Boolean  @default(true)
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt
  archived_at      DateTime?

  @@unique([coach_id, niche, is_active], name: "IntakeTemplate_active_per_niche") // partial unique enforced in app code
  @@index([coach_id, is_active])
}

model IntakeResponse {
  id                        String   @id @default(uuid())
  client_id                 String
  client                    User     @relation("IntakeResponseClient", fields: [client_id], references: [id])
  coach_id                  String
  coach                     User     @relation("IntakeResponseCoach", fields: [coach_id], references: [id])
  template_id               String
  template                  IntakeTemplate @relation(fields: [template_id], references: [id])
  template_version_snapshot Json     // inline snapshot of template.fields at redeem time
  invite_code_id            String?  // nullable for pre-feature clients
  state                     String   @default("pending") // pending | submitted | skipped
  values                    Json?    // null until submitted
  notes                     String?
  started_at                DateTime?
  submitted_at              DateTime?
  created_at                DateTime @default(now())

  @@unique([client_id, template_id], name: "IntakeResponse_unique_per_client_template")
  @@index([coach_id, state])
  @@index([client_id, state])
}
```

`template_version_snapshot` follows the same posture as
`OutcomeCheckIn` (#21) — a template edit does not retroactively
mutate a submitted response.

## API sketch

```
GET /api/coach/intake-templates
→ 200 { templates: IntakeTemplate[] }

POST /api/coach/intake-templates
body { niche, title, fields }
→ 201 { template }
  Validates against the niche allow-list (same one as
  OutcomeCheckInTemplate). On publish, this becomes the active
  template for the (coach, niche). Any prior active template is
  flipped to is_active=false in the same transaction.

PATCH /api/coach/intake-templates/:id
body { title?, fields?, is_active? }
→ 200 { template }
  Bumps template_version when fields change.

POST /api/coach/intake-templates/:id/archive
→ 200 { template }
  Sets is_active=false and archived_at. Pending IntakeResponse
  rows for clients are preserved (snapshot is inline).

GET /api/coach/clients/:clientId/intake
→ 200 { response: IntakeResponse | null }
  Returns the pending or submitted response for this client.

GET /api/me/intake/active
→ 200 { response: IntakeResponse | null }
  STUDENT-side: returns the pending response, with the snapshotted
  template fields. Returns null if the client redeemed before the
  intake feature shipped (operator backfill is optional).

POST /api/me/intake
body { responseId, values, notes? }
→ 200 { response: IntakeResponse }
  Idempotent on responseId; second POST returns the already-
  submitted row.
```

Throttle: `60 req/min` reads, `5 req/min` POST/PATCH writes.

## Invite-redeem hook

When `InviteCode.redeemed_at` is set (today, in
`src/invite-codes/invite-codes.service.ts`), the new module:

1. Resolves the active `IntakeTemplate` for the redeeming coach's
   niche (or the default niche if the coach has not specified
   one).
2. Creates an `IntakeResponse` row with `state="pending"` and
   `template_version_snapshot` set inline.
3. Emits `intake.response_started` to PostHog.

If the coach has no active template, the redeem path is
unchanged. The hook is idempotent (uniqueness on
`(client_id, template_id)`).

## Onboarding email wiring

The first onboarding email (`docs/emails/onboarding/01-welcome.md`)
adds a conditional link block: if a pending intake exists, the
CTA links to the in-app intake screen; otherwise the existing
copy is used. The email module reads
`/api/me/intake/active` server-side at send-time (same posture
as the existing email-personalization helpers).

## Rollout / feature flags

- **Env var:** `INTAKE_ENABLED=true|false` (default `false`).
- **Kill-switch behavior:** routes return 404; the redeem hook
  no-ops; the email block falls back to the default copy.
- **Backfill posture:** existing clients who redeemed before the
  feature shipped get **no** auto-created response. They can be
  prompted to fill in via a one-time email if the coach asks.
- **Fan-out:**
  1. Migration + module + flag (off).
  2. Templates routes lit; design-partner coaches publish
     templates.
  3. Redeem hook lit; new clients get pending responses.
  4. Email block lit.
  5. Platform-wide.

## RBAC and privacy

- COACH for `/coach/*`.
- STUDENT for `/me/*`.
- Tenancy: a coach reads only their own templates and only
  responses where `coach_id` matches.
- The intake response is **PII** — it carries the client's
  self-described goals, history, sometimes medical context.
  Treated identically to `CheckIn` notes for GDPR (export +
  scrub).
- OWNER never reads intake response `values`. OWNER metrics
  expose only counts.
- Audit log: template publish / archive / edit; coach reads of
  individual responses are not audit-logged (volume too high; the
  RBAC guard is the privacy boundary).

## Tests

- **Unit:**
  - Field-type allow-list reject (shared module with #21).
  - Template version increments only on field change.
  - Active-per-niche invariant enforced in app code (one row per
    `(coach_id, niche, is_active=true)`).
- **Integration:**
  - 403 cross-coach on template edit and on response read.
  - Idempotent invite-redeem hook (re-redeem path).
  - Idempotent submit (second POST is a no-op).
  - Snapshot preserves verbatim across template edits.
- **End-to-end smoke:**
  - Seeded coach + invite code → redeem creates the pending
    response → student GET returns the form → student POST
    submits → coach GET returns the submitted response.

## Risks

1. **Field-vocabulary drift between outcome check-ins (#21) and
   intake.** *Mitigation:* both modules import the same field-type
   constants from `src/common/structured-fields/`; a CI test
   asserts the union is a single source of truth.
2. **Lost responses on client churn.** A client deletes their
   account before submitting. *Mitigation:* GDPR scrub cascades;
   the `archived_at` column on the template lets the coach see
   "intake template was active when this client redeemed."
3. **Sensitive medical data.** Coaches in fitness niches will
   collect injury and medication history. *Mitigation:* the
   response is treated as PII identical to `CheckIn.notes`; the
   help center article must call out what coaches should and
   should not collect; the field-type set does not include
   special "medical" types in v1 (avoids implying a HIPAA
   posture we do not have).
4. **Email-block failure mode.** If the email service times out
   reading the intake state, the email is delayed. *Mitigation:*
   the read has a 1s timeout; on timeout, fall back to the
   default copy.

## Dependencies

- **#21 outcome check-ins:** shared field-type vocabulary.
- **#28 program templates:** the first-week plan AI Program
  Builder PR #117 will generate from intake answers reads
  program templates.
- **PR #117 AI Program Builder:** consumes intake answers as
  prompt input.
- **#22 at-risk detector:** can read intake answers as
  per-client threshold modifiers (e.g. lower threshold for a
  client who said in intake "I've quit before").

## Acceptance criteria

- [ ] Migration applied.
- [ ] Templates + responses routes shipped + tested.
- [ ] Invite-redeem hook tested for idempotency and the no-active-
      template path.
- [ ] Onboarding email block conditional verified.
- [ ] OWNER metrics + PostHog events visible.
- [ ] GDPR scrub coverage updated in `audit-and-gdpr.md`.

## Operator handoff

- **Kill-switch:** `INTAKE_ENABLED=false`. Redeem path is
  unchanged when off.
- **Per-coach allow-list:** none — the coach simply publishes a
  template (or doesn't); no operator step required.
- **Backfill request:** if a coach asks "can existing clients
  fill this in?" — operator runs the documented one-shot script
  to create pending responses for that coach's roster. Spec'd in
  the runbook entry below.
- **Runbook entry:** added under "Onboarding flows."
