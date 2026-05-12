# Data Export — `src/data-export/`

GDPR Article 20 right to data portability. Lets every user (coach or client) request a complete JSON archive of all their personal data. The archive is generated asynchronously, uploaded to S3-compatible storage, and a 7-day signed download link is emailed to the user.

> **GDPR dependency note:** This module is a hard dependency for the GDPR delete module (`src/gdpr/`). Bradley's platform should always encourage users to download their data **before** they request account deletion. The delete-account module checks for a READY export within the last 7 days and surfaces a warning if none exists.

---

## Endpoints

| Method | Path | Auth | Request body | Response |
|--------|------|------|-------------|---------|
| `POST` | `/v1/me/data-export/request` | JWT (any role) | none | `{ id, status: "PENDING", created_at, message }` — 202 Accepted |
| `GET` | `/v1/me/data-export/status` | JWT (any role) | none | `{ id, status, created_at, completed_at, expires_at, file_size_bytes, download_token }` — 200 OK; 404 if never requested |
| `GET` | `/v1/me/data-export/download?token=<jwt>` | Download token in query | none | 302 redirect to S3 presigned URL; 401 invalid token; 410 expired |

The `/download` endpoint is **not** protected by the main JWT guard — the download token in the query string carries its own user binding. This is intentional: the download link in the email must work in a browser without the app running.

---

## Prisma model touched

| Model | Fields | Notes |
|-------|--------|-------|
| `DataExportRequest` | `id`, `user_id`, `status`, `file_url`, `created_at`, `completed_at`, `expires_at`, `file_size_bytes`, `sha256` | One row per export request. |
| `User` | `id`, `email`, `name` | Read-only — used to look up email + name for the notification. |

---

## Export shape (per-model key table)

Every export is a single JSON file. The top-level object has the following keys:

| Key | Source model(s) | Redaction notes |
|-----|----------------|-----------------|
| `manifest` | synthetic | `export_id`, `user_id`, `schema_version`, `requested_at`, `completed_at`, `sha256` |
| `user` | `User` | `id`, `email`, `name`, `phone`, `role`, `created_at`, `archived_at`, `deletion_scheduled_at`. Fields excluded: `supabase_id`, `coach_id`, `deleted_at` (internal). |
| `profile` | `UserProfile` | All fields. |
| `preferences` | `UserPreferences` | All fields. |
| `notification_preferences` | `NotificationPreferences` | All fields. |
| `weight_logs` | `WeightLog` | All fields. |
| `food_entries` | `LoggedFoodEntry` | All fields. |
| `workout_sessions` | `WorkoutSession` | All fields. |
| `fasting_windows` | `FastingWindow` | All fields. |
| `water_logs` | `WaterLog` | All fields. |
| `habits` | `Habit` | All fields. |
| `lesson_completions` | `LessonCompletion` | All fields. |
| `check_ins` | `CheckIn` | All fields. |
| `saved_recipes` | `SavedRecipe` | All fields. |
| `list_items` | `ListItem` | All fields. |
| `coach_messages` | `CoachMessage` | Messages **sent by the user** are included verbatim. Messages sent by other parties that are visible to the user (as coach or client) appear as `{ id, sent_at, redacted: true, note: "..." }`. This protects third-party privacy while preserving the user's own message history. |
| `coach_nudges` | `CoachNudge` | All rows where `coach_id` or `client_id` equals the user. |
| `message_drafts` | `MessageDraft` | All rows where `coach_id` or `client_id` equals the user. |
| `meal_plans` | `MealPlan` | All rows where `coach_id` or `client_id` equals the user. |
| `community_wins` | `CommunityWin` | Only wins authored by the user. |
| `coach_guidelines` | `CoachGuideline` | All rows where `coach_id` or `client_id` equals the user. |
| `build_week_enrollment` | `BuildWeekEnrollment` | The user's single enrollment row (or null). |
| `build_week_completions` | `BuildWeekDayCompletion` | All completions via the user's enrollment. |
| `invite_codes` | `InviteCode` | Invite codes created by the user (coaches only; clients return `[]`). |
| `diagnostic_submissions` | `DiagnosticSubmission` | Submissions with `user_id` matching the user. Anonymous submissions are not included (they have no `user_id`). |
| `ptm_signals` | `ClientSignal` | All PTM signals for the user. |
| `ptm_predictions` | `PtmPrediction` | All PTM prediction rows for the user. |
| `audit_log_entries_about_user` | `AuditLog` | Only entries where `target_id` equals the user (what was logged **about** them). Actor entries are excluded to protect others' privacy. |
| `data_export_requests` | `DataExportRequest` | Full history of this user's export requests. |

---

## Signed URL contract

- URL is generated at upload time using AWS S3 `GetObject` presigning (`expiresIn: 7 days`).
- The URL is stored in `data_export_request.file_url`. It is **never returned directly** by the API — clients receive a short-lived download JWT via the `/status` endpoint and redirect through `/download?token=`.
- The download token is a HS256 JWT signed with `DATA_EXPORT_TOKEN_SECRET`, payload: `{ sub: userId, eid: exportId, type: "data_export_download" }`, expiry: 7 days.
- The `/download` endpoint validates the token, confirms `sub` matches `record.user_id`, and issues a 302 redirect to the stored presigned URL.
- **Files are never piped through the API process.** The redirect is direct to S3.

---

## Rate limits

- 1 export request per user per 24 hours (configurable via `DATA_EXPORT_RATE_LIMIT_HRS`).
- The window applies only to `PENDING` or `READY` requests. A `FAILED` request does not block a retry.
- Exceeding the limit returns `409 Conflict` with a plain-English message.

---

## Env vars

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATA_EXPORT_TOKEN_SECRET` | Yes (prod) | `change-me-in-production-min32chars!` | Signs the download JWT. Must be ≥ 32 chars in production. |
| `DATA_EXPORT_BUCKET` | No | — | S3 bucket name. When unset, exports are stored on the local filesystem (dev/staging only). |
| `DATA_EXPORT_S3_ENDPOINT` | No | AWS default | Custom S3 endpoint for Fly/MinIO. |
| `AWS_ACCESS_KEY_ID` | When S3 used | — | S3 credentials. |
| `AWS_SECRET_ACCESS_KEY` | When S3 used | — | S3 credentials. |
| `AWS_REGION` | No | `us-east-1` | S3 region. |
| `DATA_EXPORT_FS_DIR` | No | `/tmp/exports` | Local filesystem dir when S3 is not configured. |
| `DATA_EXPORT_EXPIRY_DAYS` | No | `7` | Days after completion that the file and download link remain valid. |
| `DATA_EXPORT_RATE_LIMIT_HRS` | No | `24` | Hours between export requests per user. |
| `SMTP_HOST` | No | — | SMTP server host for the ready-notification email. When unset, the URL is logged instead (dev mode). |
| `SMTP_PORT` | No | `587` | SMTP port. |
| `SMTP_SECURE` | No | `false` | Set `true` for port 465 TLS. |
| `SMTP_USER` | No | — | SMTP auth username. |
| `SMTP_PASS` | No | — | SMTP auth password. |
| `SMTP_FROM` | No | `"The Growth Project" <no-reply@thegrowthproject.app>` | From address. |

---

## Test coverage

| File | What it asserts |
|------|----------------|
| `src/data-export/data-export.spec.ts` | Full lifecycle: request → rate-limit guard → status poll → download token validation → expired 410 → user-bound check → nightly cleanup. |

Specific test cases:
- New PENDING record created and async export fires
- `ConflictException` when PENDING export exists within 24 h
- `ConflictException` when READY export exists within 24 h
- Retry allowed after FAILED export (FAILED excluded from rate-limit window)
- `NotFoundException` when no export has been requested
- READY status includes `download_token`, excludes raw `file_url`
- PENDING status returns `download_token: null`
- Valid token + READY export returns file URL
- `UnauthorizedException` for invalid JWT
- `UnauthorizedException` when token `sub` != record `user_id` (cross-user attempt blocked)
- `GoneException` (410) for EXPIRED status
- `GoneException` (410) when wall-clock expiry passes; row marked EXPIRED lazily
- Nightly cleanup marks all past-expiry READY rows EXPIRED
- Cleanup handles empty result set without error
- Cleanup cron does not throw when `expireOldExports` rejects

---

## Future work / Known limits

- **CSV format option:** Structured data (weight logs, food entries) would be more useful to many users in CSV format. A `format=json|csv` query param on `/request` is the natural extension.
- **Partial exports:** Users who only want their nutrition data or only their workout data would benefit from a `models=weight_logs,food_entries` filter param.
- **S3 lifecycle rule:** Add an S3 lifecycle rule that deletes objects under the `exports/` prefix after 8 days as a belt-and-braces safety net alongside the nightly cron.
- **BullMQ / queue-backed export:** For very large accounts the async fire-and-forget pattern could be upgraded to a proper BullMQ queue so the export job survives a process restart.
- **Single-use download token:** The current token is user-bound but not single-use. A Redis-backed nonce store could enforce single-use to prevent forwarded link reuse.
