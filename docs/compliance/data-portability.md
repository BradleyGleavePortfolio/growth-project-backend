# GDPR Article 20 — Data Portability

## What this is

GDPR Article 20 gives every data subject the right to receive their personal data "in a structured, commonly used and machine-readable format." This document records how The Growth Project implements that right.

---

## Implementation overview

| Step | Mechanism |
|------|-----------|
| User requests export | `POST /v1/me/data-export/request` (rate-limited: 1 per 24 h) |
| Data assembled | `DataExportService._buildArchive()` — all models, streamed in 500-row pages |
| File format | JSON, UTF-8, single file per export |
| Storage | S3-compatible object store (or local filesystem when `DATA_EXPORT_BUCKET` is unset). Server-side encryption at rest (`AES256`). |
| Delivery | 7-day signed download URL, emailed to the user. The user can also retrieve the token via `GET /v1/me/data-export/status`. |
| Expiry | File and URL expire after 7 days. Nightly cron marks rows `EXPIRED` and deletes the file from storage. |
| Scope | **Every model that holds user-identifiable data.** See the data map below. |

---

## Data map — what is included

Every top-level key in the export JSON maps to one Prisma model. The table below documents each model, whether all fields are included, and any redaction applied.

| Model | Included | Notes |
|-------|----------|-------|
| `User` | Partial | `id`, `email`, `name`, `phone`, `role`, `created_at`, `archived_at`, `deletion_scheduled_at`. Internal fields `supabase_id`, `deleted_at` excluded. |
| `UserProfile` | All | — |
| `UserPreferences` | All | — |
| `NotificationPreferences` | All | — |
| `WeightLog` | All | — |
| `LoggedFoodEntry` | All | — |
| `WorkoutSession` | All | — |
| `FastingWindow` | All | — |
| `WaterLog` | All | — |
| `Habit` | All | — |
| `LessonCompletion` | All | — |
| `CheckIn` | All | — |
| `SavedRecipe` | All | — |
| `ListItem` | All | — |
| `CoachMessage` | Partial | Messages sent BY the user: verbatim. Messages sent by other parties but visible to the user: `{ id, sent_at, redacted: true }`. Third-party content is redacted to protect the other party's rights under GDPR. |
| `CoachNudge` | All | Rows where `coach_id` or `client_id` matches. |
| `MessageDraft` | All | Rows where `coach_id` or `client_id` matches. |
| `MealPlan` | All | Rows where `coach_id` or `client_id` matches. |
| `CommunityWin` | All | Wins authored by the user only. |
| `CoachGuideline` | All | Rows where `coach_id` or `client_id` matches. |
| `BuildWeekEnrollment` | All | The user's single enrollment row. |
| `BuildWeekDayCompletion` | All | Via the user's enrollment. |
| `InviteCode` | All | Codes created by the user (coaches only). |
| `DiagnosticSubmission` | All | Submissions linked to the user's `user_id`. Anonymous leads (no `user_id`) are not linked and are not included. |
| `ClientSignal` (PTM) | All | All PTM signals for the user. |
| `PtmPrediction` | All | All PTM prediction rows for the user. |
| `AuditLog` | Partial | Only rows where `target_id` = user (what was logged **about** them). Actor-perspective rows are excluded to protect others' privacy. |
| `DataExportRequest` | All | Full history of the user's own export requests. |

---

## Portability vs access

Article 20 applies to data the user **actively provided** (personal data processed on the basis of consent or a contract). The Growth Project exports all user-held data rather than drawing a fine distinction, in line with the spirit of the regulation and best practice for consumer apps.

---

## Dependency: data export before account deletion

The GDPR delete module (`src/gdpr/`) checks for a READY export within the last 7 days when a user requests account deletion. If none exists, the delete flow surfaces a prompt encouraging the user to download their data first. This is not a hard block — users can choose to skip the export and delete immediately.

---

## Timelines

| Obligation | Deadline | How met |
|-----------|---------|---------|
| Respond to a portability request | Without undue delay, at most 1 month (Art. 12) | Export typically completes in under 60 seconds. Email sent immediately on completion. |
| File retention | Not specified; 7 days chosen as a balance between convenience and storage cost. | Nightly cleanup cron + S3 lifecycle rule (recommended). |

---

## Technical controls

- **Rate limit:** 1 request per user per 24 hours. Prevents abuse / runaway storage costs.
- **Signed URL:** 7-day expiry. Single-process redirect (never piped through the API server).
- **User binding:** Download token is a HS256 JWT with `sub: userId`. One user cannot redeem another user's token.
- **Encryption at rest:** S3 `AES256` server-side encryption on all export objects.
- **Audit logging:** `data_export_requested`, `data_export_completed`, `data_export_downloaded` events written to `AuditLog` (best-effort; never blocks the export itself).

---

## Future work

- **CSV option:** Structured data is easier to use in spreadsheet tools. A `format=csv` parameter is the planned extension.
- **Partial exports:** Users with large datasets may only need a subset. A `models=` filter is the planned extension.
- **S3 lifecycle rule:** Add an S3 bucket lifecycle rule deleting objects under `exports/` after 8 days as a belt-and-braces measure.
