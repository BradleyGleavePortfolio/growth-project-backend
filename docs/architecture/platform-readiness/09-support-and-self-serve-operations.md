# 09 — Support & self-serve operations

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Today's operator workflow is OWNER-driven and surprisingly
mature for the team's size:

- A public coach-help surface at `/help/*` (PR #103).
- Onboarding email sequence (PR #101).
- Coach setup checklist, FAQ, contact-support intake spec
  (`docs/help/`).
- OWNER-only admin surface (`src/admin/`) with promotion,
  inventory, lazy `CoachProfile` provisioning, metrics counter,
  and audit-log read.
- OWNER-only reports (`src/admin/reports/`) with CSV+JSON
  exports.
- Cross-product federation (`src/admin/federation/`) for the
  Healthie-style admin console.

The next wave will stretch this:

- Team Mode adds **per-staff support**: an OWNER may need to
  troubleshoot one staff member without affecting the
  team's billing.
- AI Program Builder adds **per-coach overrides** (cost-cap,
  prompt template fallback) the OWNER may need to grant.
- Templates marketplace adds **moderation** (an OWNER may need
  to suspend a template, refund a sale, ban a creator).
- Public profiles add **takedown** (an OWNER may need to remove
  a profile if abuse is reported).
- Revenue dashboards add **per-coach drill-in** for support
  triage.

Without an explicit support brief, every new feature gets either
no admin surface (and the OWNER ends up running raw SQL) or a
feature-specific surface that doesn't compose.

**Cross-feature impact:**

| Feature | Why this lane carries it |
|---|---|
| Team Mode | Per-staff override + per-team takeover ("treat me as a member of this team for this debug session"). |
| AI Program Builder | Per-coach budget override; per-coach prompt template fallback; per-draft moderation. |
| Check-ins v2 | Per-client check-in repair (e.g., backfill missed a row). |
| Public profiles | Takedown surface. |
| Templates marketplace | Moderation, refund, creator suspension. |
| Revenue dashboards | Per-coach drill-in is the support recipe. |

## WHEN

Settle this brief **before** Templates marketplace ships any
moderation surface. For Builder, settle before the first paid
add-on launches (operators will need to grant overrides
immediately). For Team Mode, settle before the first
staff-management surface ships.

## WHERE

- `src/admin/` — OWNER-only admin module.
- `src/admin/reports/` — OWNER reports.
- `src/admin/federation/` — cross-product federation.
- `src/admin/console/` — admin-console alias routes (PR #80
  draft).
- `docs/admin-reports.md` — reports doc.
- `docs/help/` — coach-help surface; this lane references but
  does not duplicate.
- `docs/support-runbook.md` — new doc; the OWNER's
  support-action handbook.

## WHO

- **Owner:** OWNER (operator) + backend lead.
- **Reviewers:** founder (for moderation policy + takedown
  authority).
- **On the hook in production:** OWNER. Every override is
  audited.

## WHAT

### What already exists

- OWNER admin surface (`src/admin/`).
- OWNER reports (`src/admin/reports/`).
- Federation (`src/admin/federation/`).
- Console aliases (`src/admin/console/`, PR #80 draft).
- Audit log on OWNER actions.
- Coach-facing help surface and onboarding emails.
- Contact-support intake spec.

### What is missing

1. **A self-serve recipe library.** A small set of "how do I"
   recipes the OWNER follows. Each recipe is one short page,
   stored in `docs/support-recipes/*.md`, with the same shape:
   problem, signal, fix, audit footprint, follow-up.
   Examples to author first:
   - Coach in `past_due` past grace can't write — verify Stripe
     mirror, run `backfill:coach-subscriptions`, flip
     enforcement to `observe`.
   - Coach asks for an AI Program Builder budget bump — grant
     a one-month override; audit; reset on month roll.
   - Client asks to delete account — per
     `docs/audit-and-gdpr.md` operator path.
   - Coach asks to be suspended (off-platform) — flip the
     `CoachProfile.disabled` flag.
   - Public profile takedown — soft-delete the profile row;
     audit.
2. **An explicit override audit posture.** Every OWNER override
   writes an `AuditLog` row with a `reason` field (free text,
   required). The audit log read endpoint (already exists)
   becomes the canonical source for "why did the OWNER do
   that" questions.
3. **An "act as" / impersonation policy.** Today there is no
   impersonation (OWNER reads via federation, not by
   acquiring a coach token). Documented as such — we explicitly
   do not support OWNER acting as a coach. If a future feature
   needs that, this brief is updated first. Rationale: legal
   simplicity + audit clarity.
4. **A moderation surface (templates, public profiles).**
   When templates and public profiles land, they each get an
   admin route to suspend / unpublish / takedown. Same shape:
   `POST /admin/<surface>/<id>/<action>` with a `reason`. Audit
   logged.
5. **A support-runbook doc.** Single index of recipes, override
   procedures, and the audit-trail expectation.
6. **Coach-facing self-serve.** Today's `/help/*` surface (PR
   #103) is the coach's first line. Lane #09 declares which
   coach actions are self-serve (e.g., "update your billing
   info via the customer portal") and which require OWNER
   intervention (e.g., "transfer ownership of a team", once
   Team Mode lands).

### Override taxonomy (proposed)

| Override | Who triggers | Audit shape | Auto-reset |
|---|---|---|---|
| Builder budget bump | OWNER | `admin.builder.budget_override` | Yes — month rollover |
| Bypass enforcement (per coach) | OWNER | `admin.billing.enforcement_bypass` | Yes — 30 days |
| Suspend coach | OWNER | `admin.coach.suspend` | No — manual undo |
| Suspend template | OWNER | `admin.template.suspend` | No — manual undo |
| Takedown public profile | OWNER | `admin.profile.takedown` | No — manual undo |
| Re-run failed Builder draft | OWNER | `admin.builder.draft.replay` | n/a |
| Force-resync Stripe mirror | OWNER | `admin.billing.resync` | n/a |

## HOW

### Operator handoff

- A new `docs/support-runbook.md` lists the override taxonomy
  and links each row to its recipe in
  `docs/support-recipes/`.
- Each recipe is short. Five sections, one paragraph each:
  problem, signal, fix, audit footprint, follow-up.
- The OWNER reads the recipe, takes the action, and the
  AuditLog records it. No manual side-channel.

### "Act as" non-policy

We document, in `docs/support-runbook.md` and
`docs/security-posture.md` (lane #03):

> The platform does not support OWNER impersonation of a coach.
> All OWNER reads happen via the federation/admin surface.
> Mutations on a coach's behalf require either a
> per-coach override (audited) or contacting the coach.

If a future feature needs impersonation, this is rewritten
first.

### Moderation routes (proposed shape)

```
POST /admin/templates/:id/suspend     { reason: string }
POST /admin/templates/:id/unsuspend   { reason: string }
POST /admin/profiles/:coachId/takedown { reason: string }
POST /admin/profiles/:coachId/restore  { reason: string }
POST /admin/coaches/:coachId/suspend   { reason: string }
POST /admin/coaches/:coachId/unsuspend { reason: string }
POST /admin/builder/coaches/:coachId/budget-override { reason: string, addUsd: number }
POST /admin/billing/coaches/:coachId/enforcement-bypass { reason: string, days: number }
```

OWNER-only. Each writes one `AuditLog` row before returning
success. Integration test asserts the audit row shape.

## Risks

- **Override sprawl.** Mitigation: the override taxonomy is a
  closed list. Adding one is a brief update.
- **OWNER mistakes (suspended wrong coach).** Mitigation:
  every suspend has an unsuspend; reason field is required;
  the audit log shows who/when/why.
- **Recipe rot.** Mitigation: every recipe lists the last-run
  date; a quarterly review walks the list and re-runs (or
  marks deprecated).
- **OWNER acting as coach (slippery slope to impersonation).**
  Mitigation: explicit non-policy in this lane and lane #03.

## Dependencies

- Lane #03 (security) — the "no impersonation" stance lives in
  both lanes.
- Lane #04 (data lifecycle) — manual delete recipes link to
  the GDPR operator path.
- Lane #05 (billing) — enforcement-bypass override is
  documented in the dunning posture.
- Lane #08 (AI governance) — Builder budget override is the
  canonical example.
- Lane #06 (observability) — every override writes an
  `AuditLog` row; OWNER metrics surface counts overrides.

## Acceptance criteria

1. ✅ `docs/support-runbook.md` exists with the override
   taxonomy and links to recipes.
2. ✅ At least five recipes exist in `docs/support-recipes/`
   (the five listed in WHAT above).
3. ✅ The "no impersonation" policy is documented in both
   lane #03 and lane #09.
4. ✅ Every override admin route writes an `AuditLog` row with
   a `reason` field (required). Integration tests assert this
   for the canonical surfaces (billing, builder).
5. ✅ The recipes link to the matching coach-facing help page
   when one exists.

## Test strategy

- **Unit:** none — this lane is procedural + admin-route shape.
- **Integration:** every override admin route has a test that
  verifies (a) OWNER-only access, (b) reason required, (c)
  AuditLog row written.
- **Manual:** quarterly review of recipes — OWNER walks each
  one against staging to confirm it still works.

## Rollout & kill-switch

- Recipes ship as docs only — no rollout.
- Override admin routes ship behind `RolesGuard`; turning the
  guard off would be a security incident, not a kill switch.
  The actual kill switch for an override route is to disable
  the route in the controller (operator deploy).
- For per-feature overrides (Builder budget, billing
  enforcement bypass), the underlying feature flag (lane #01)
  is the kill switch.
