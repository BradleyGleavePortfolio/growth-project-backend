# Bloodwork v1 — Handoff Doc

Backend rails for the client-entered bloodwork feature shipped on the
mobile side as PR #103. Treats lab values as PHI-grade health data:
explicit consent, tenant-scoped review queue, immutable audit, and a
KMS handoff that is not yet wired.

## What is real vs stubbed

| Area | Status | Notes |
| --- | --- | --- |
| Manual client entry of panels + biomarker results | **Real** | DTO, validation, draft → submit, edit-while-draft, delete-while-draft. |
| Consent gate (storage and AI) | **Real** | New scopes `health.bloodwork` and `health.bloodwork_ai`. Storage scope is required to write/read panels; AI scope is captured at submit time AND re-checked live by the AI gateway. |
| Coach review queue, review/flag/hide/needs_info | **Real** | Tenant-scoped, transitions enforced server-side, AI cannot mutate authoritative state. |
| Attachment metadata + scan state machine | **Contract only** | Tables, states, and the OWNER-only scan callback are in. Real upload/storage and the actual scanner are out of v1 scope. Coach approval is gated on `scan_status in ('clean', 'unavailable')`. |
| Stale sweep | **Real, off in test** | Daily cron at 03:00 marks panels older than `BLOODWORK_STALE_AFTER_DAYS` (default 365) as stale. Reviewed panels never silently regress. |
| Audit log | **Real** | Every create/update/submit/review/flag/hide/visibility/scan/stale event goes to the existing `AuditLog` table via `AuditService`. |
| At-rest encryption | **Stubbed** | Plaintext columns in v1. `encryption_key_ref` and `kms_key_version` columns exist as metadata pointers; production deploys MUST set `BLOODWORK_KMS_KEY_REF` and migrate sensitive columns to KMS-backed encryption before real labs are stored at scale. |
| EHR/OCR import | **Out of scope** | Not in v1. Source field is open for future ingestion paths. |
| AI insights generation | **Disabled / draft-only** | Backend exposes `ai_processing_allowed` per panel. Integration with backend AI gateway PR #140 lands separately; this PR avoids depending on the unmerged branch. |

## Mobile PR #103 contract alignment

The following endpoints land for the mobile app to call. Field shapes
mirror the Prisma models exactly so the OpenAPI export is the source of
truth — re-run `npm run openapi:export` to refresh.

Client surface (every route requires a Supabase JWT):
- `POST /bloodwork/panels` — create draft panel + nested results.
- `GET /bloodwork/panels` — list own panels.
- `GET /bloodwork/panels/:id` — read one.
- `PUT /bloodwork/panels/:id` — edit a draft only.
- `POST /bloodwork/panels/:id/submit` — promote draft → submitted.
- `DELETE /bloodwork/panels/:id` — delete a draft only.
- `POST /bloodwork/panels/:id/attachments` — register attachment metadata. Storage ref is opaque; v1 does not upload bytes here.

Coach surface (requires `coach` or `owner`):
- `GET /coach/bloodwork/queue` — review queue, scoped to coach's tenant.
- `GET /coach/bloodwork/panels/:id` — read one panel.
- `PUT /coach/bloodwork/panels/:id/review` — transition state with optional note.

Owner-only:
- `POST /coach/bloodwork/attachments/:id/scan` — scanner callback. Service-layer guard rejects non-owner calls.

## Security posture

- **Consent is mandatory.** A coach cannot read a panel without `health.bloodwork` granted by the client. The AI gateway must additionally re-check `health.bloodwork_ai` at every prompt — `ai_processing_allowed` on the panel is a snapshot taken at submit time, not a live grant.
- **Tenant boundary.** A coach can only see panels where `coach_id = req.user.id`; owners bypass. Cross-coach read returns 404 (not 403) so foreign-tenant ids are not enumerable.
- **AI cannot approve.** `ai` actor role is rejected by `assertActorIsCoachLike`. Only `coach` and `owner` can transition review state.
- **Mass-assignment protection.** Global `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true`, so DTOs cannot be hijacked to set `coach_id`, `review_state`, `validation_status`, etc.
- **Audit trail.** Every state transition writes a row to `AuditLog` with action `bloodwork.*` and `tenant_coach_id` set so the existing OWNER audit-log surface can filter by tenant.
- **Disclaimer level.** Every panel ships with `disclaimer_level: educational_only`. The mobile UI must render the educational-only banner — labs are coaching context, not diagnosis or treatment.

## Compliance behavior

- **Revocation.** When a client revokes `health.bloodwork`, existing panels remain in the database but coach-side reads start returning empty arrays (consent is checked live). The mobile app may also call `DELETE /bloodwork/panels/:id` to remove drafts. Submitted panels must currently go through coach `hidden` to drop from the queue; a client-initiated soft-delete is a future hardening item.
- **GDPR delete.** `BloodworkPanel.client_id` cascades on `User` delete, so the existing GDPR scrub sweeps panels and results automatically. Attachments cascade on panel.
- **Export.** A future change to `data-export-requests` should append the user's panels to the exported payload. Out of v1 scope.

## Environment variables

| Var | Purpose | Default |
| --- | --- | --- |
| `BLOODWORK_STALE_AFTER_DAYS` | Age (days) at which a panel becomes stale. | `365` |
| `BLOODWORK_STALE_DISABLED` | If `"true"`, the daily stale cron is skipped. | unset |
| `BLOODWORK_KMS_KEY_REF` | Production-only. Pointer/alias for the KMS key envelope used to encrypt sensitive columns. **Required before real PHI lands.** | unset |
| `BLOODWORK_KMS_KEY_VERSION` | Optional version label written into `kms_key_version` on new panels. | unset |

No secret values are committed to the repo. Add the KMS vars to Fly
secrets via the existing operator workflow.

## Cron seam

`BloodworkStaleScheduler` runs at `EVERY_DAY_AT_3AM` via `@nestjs/schedule`. To run on demand:

```ts
// scripts/mark-stale-bloodwork.ts (future)
const out = await app.get(BloodworkService).markStalePanels();
console.log(`Marked ${out.marked} panels stale`);
```

The scheduler is disabled when `NODE_ENV === 'test'`.

## Testing

- Unit/contract coverage in `test/bloodwork.service.spec.ts` exercises:
  consent gating (storage and AI), tenant boundary, draft → submitted →
  reviewed transitions, AI-cannot-approve, scan-not-clean blocks
  approval, stale sweep, attachments authorship.
- Existing `test/consent.service.spec.ts` updated for the new scopes.
- Run with `npm test`.
