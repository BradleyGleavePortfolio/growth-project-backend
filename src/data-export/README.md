# Data Export — `src/data-export/`

GDPR Article 20 right to data portability. Lets every user (coach or client) request a complete JSON archive of all their personal data. The archive is generated asynchronously and stored in the PRIVATE Supabase Storage bucket `data-exports` for 7 days. The app downloads it through a 5-minute link minted for the signed-in owner; the bytes stream through the API, and no Storage URL ever leaves the server.

> **GDPR dependency note:** This module is a hard dependency for the GDPR delete module (`src/gdpr/`). Bradley's platform should always encourage users to download their data **before** they request account deletion. The delete-account module checks for a READY export within the last 7 days and surfaces a warning if none exists.

---

## Endpoints

| Method | Path | Auth | Request body | Response |
|--------|------|------|-------------|---------|
| `POST` | `/v1/me/data-export/request` | JWT (any role) | none | `{ id, status: "PENDING", created_at, message }` — 202. 409 `DATA_EXPORT_IN_PROGRESS` (one is being built) or `DATA_EXPORT_RATE_LIMITED` (a downloadable export from the last 24 h exists). 503 `DATA_EXPORT_STORAGE_UNAVAILABLE` when the previous archive could not be retired. |
| `GET` | `/v1/me/data-export/status` | JWT (any role) | none | `{ id, status, created_at, completed_at, expires_at, file_size_bytes, download_available, download_token, next_request_at }` — 200; 404 `DATA_EXPORT_NOT_FOUND` if never requested. A run stuck past 30 min is reported `FAILED`. |
| `POST` | `/v1/me/data-export/download-link` | JWT (any role) | none | `{ download_path, token, expires_at, file_name, file_size_bytes }` — 200, for the caller's latest export only. 404 `DATA_EXPORT_NOT_FOUND`, 409 `DATA_EXPORT_NOT_READY`, 410 `DATA_EXPORT_EXPIRED` / `DATA_EXPORT_FILE_MISSING`. |
| `GET` | `/v1/me/data-export/download?token=<jwt>` | Link token in query | none | 200, archive streamed as `attachment; filename="tgp-data-export-<date>.json"`, `Cache-Control: no-store`. 401 `DATA_EXPORT_LINK_INVALID` / `DATA_EXPORT_LINK_EXPIRED`, 409, 410, 503 as above. Browsers (`Accept: text/html`) get a plain page with the next step and the request reference. |

The `/download` endpoint is **not** protected by the main JWT guard: the app opens it in the phone's browser, which has no Bearer token. The link token is the credential (see below).

---

## Prisma model touched

| Model | Fields | Notes |
|-------|--------|-------|
| `DataExportRequest` | `id`, `user_id`, `status`, `file_url`, `created_at`, `completed_at`, `expires_at`, `file_size_bytes`, `sha256` | One row per export request. |
| `User` | `id`, `email`, `name` | Read-only — used to look up email + name for the notification. |
| `DataExportArchiveCleanup` (`data_export_archive_cleanup`) | `export_id`, `machine`, `reason`, `attempts`, `last_error_code`, `created_at`, `last_attempt_at` | B-608-11. One row per archive that must still be removed after its request row is gone (`request_removed`) or a run failed (`failed_run`). `machine` is the store authority that can drain it: `supabase-storage:data-exports` in production (any machine), the Fly machine id for local disk. Holds no user id. Service-role only (RLS). |

### Archive cleanup guarantees (B-608-11)

- Deleting an archive treats only "already gone" (`ENOENT` locally; Storage `remove()` reports only what it deleted) as success. `EACCES`, `EIO`, any Storage error after retries, or a URL this server cannot map to the export's own archive is an error.
- When an export finishes after its request row was erased, or a run fails after writing its archive, the worker deletes the archive itself. If that fails it writes a cleanup record for this machine (`os.hostname()`, the Fly machine id), reports to Sentry (`data export archive cleanup failed`, errno code only), and the runner rejects. "archive deleted" is logged only after the archive is confirmed gone.
- The nightly cleanup (03:30 UTC, every machine) first drains its own machine's records: the path is always `<DATA_EXPORT_FS_DIR>/<export_id>.json` derived from the id (never stored), the record is deleted only when the unlink succeeds or reports `ENOENT`, and a persisting error bumps `attempts` and stays queued. A record whose archive a READY row owns is dropped without touching the file. Records from other machines older than 48 hours are reported for the operator.
- Expiry deletes the file first; only then is the row marked `EXPIRED` with `file_url` cleared (rows already marked `EXPIRED` by a download attempt are included). A failed delete leaves the row as it is for the next run.
- The orphan sweep (files older than an hour with no request row) stays as a second safety net.

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

## Storage and download contract (B-608-12)

- **Store.** Production: private Supabase Storage bucket `data-exports`, object `<export id>.json` at the bucket root (`file_url` = `supabase-storage://data-exports/<id>.json`). The bucket is created and forced private by migration `20270221000000_data_export_storage_bucket`; its `verify.sql` runs in every release (`scripts/release.sh` step 4, listed in `scripts/release-required-verifiers.txt`) and fails the release if the bucket is missing, public, or reachable by an anon/authenticated storage.objects policy. The service also refuses to write while `getBucket` reports the bucket public. Development/tests: `DATA_EXPORT_FS_DIR` (`DATA_EXPORT_STORAGE=local`, the default outside production; refused in production).
- **Keys are derived, never trusted.** Every read and delete derives the object from the export id. A `file_url` is only compared for equality with the derived URL.
- **READY means retrievable.** The worker uploads (upsert), then checks the object's size with `info()`; only then is the row marked READY. A failed or timed-out upload is treated as possibly written and removed (B-608-11 cleanup record on failure).
- **Retries.** Every Storage call retries transient failures (network, 408, 429, 5xx) three times with 250 ms / 1 s backoff. Permanent failures (403, 404, 413, size mismatch) fail at once.
- **Link token.** HS256 JWT signed with `DATA_EXPORT_TOKEN_SECRET`: `{ sub: userId, eid: exportId, type: "data_export_download", aud: "tgp:data-export-download", jti, iat, exp }`, lifetime `DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS` (default 300, clamped to 60..900; a token claiming a longer life is refused). Minted only for the authenticated owner (`POST /download-link`, or the status response for older app builds).
- **Redemption.** `/download` verifies the token (algorithm, audience, type, expiry), loads the export by `eid`, requires `user_id === sub` and a live (not deleted) account (same 401 for unknown export and foreign export), requires READY, unexpired, stored in the active store, then streams the bytes from Storage through a 60-second signed URL used only server-side.
- **Lifecycle.** A new request supersedes an older READY export (archive deleted first, then the row is marked EXPIRED). Crashed runs (PENDING/RUNNING older than `DATA_EXPORT_STALE_RUN_MINUTES`, default 30) are failed and their archive removed, lazily on status/request and nightly. The nightly cleanup (03:30 UTC): drain cleanup records for this store (the bucket, so any machine), fail stale runs, sweep orphan archives (no row, or a row that does not own it, older than an hour), then delete expired archives and mark their rows EXPIRED (file first).
- **Account deletion** removes the planned archive of every export of the person (the bucket object in production) inside the finalization transaction; a Storage failure rolls back and the nightly finalization retries. An archive written after the erasure is removed by the worker itself, with the B-608-11 cleanup record as the durable retry.

## Rate limits

- 1 export request per user per 24 hours (configurable via `DATA_EXPORT_RATE_LIMIT_HRS`).
- The window applies only to `PENDING` or `READY` requests. A `FAILED` request does not block a retry.
- Exceeding the limit returns `409 Conflict` with a plain-English message.

---

## Env vars

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATA_EXPORT_TOKEN_SECRET` | Yes (prod) | `change-me-in-production-min32chars!` | Signs the download link token. Must be ≥ 32 chars in production. |
| `DATA_EXPORT_STORAGE` | No | `supabase` in production, `local` elsewhere | `local` is refused in production. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Yes (hard tier) | — | The service-role client reads and writes the private `data-exports` bucket. |
| `DATA_EXPORT_FS_DIR` | No | `/tmp/exports` | Local directory for development and tests only. |
| `DATA_EXPORT_EXPIRY_DAYS` | No | `7` | Days after completion that the archive is kept. |
| `DATA_EXPORT_RATE_LIMIT_HRS` | No | `24` | Hours between export requests per user. |
| `DATA_EXPORT_DOWNLOAD_LINK_TTL_SECONDS` | No | `300` | Download link lifetime, clamped to 60..900. |
| `DATA_EXPORT_STALE_RUN_MINUTES` | No | `30` | A PENDING/RUNNING export older than this is a crashed run (minimum 5). |
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
- **BullMQ / queue-backed export:** For very large accounts the async fire-and-forget pattern could be upgraded to a proper BullMQ queue so the export job survives a process restart.
- **Single-use download token:** The link token is user- and export-bound and lives 5 minutes, but is not single-use. A shared nonce store could enforce single use.
