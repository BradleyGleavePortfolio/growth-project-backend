# account-deletion — GDPR right to erasure

## What this module does

This module implements the GDPR right-to-erasure (right to be forgotten) flow for The Growth Project backend. It lets users request permanent deletion of their account through a two-phase email-confirmation process, gives them a 14-day grace period to change their mind, and — when the deadline arrives — scrubs all personal data according to the per-model cascade strategy documented below. Admins with the `owner` role can bypass the grace period and force-delete a user immediately. Every significant lifecycle event is written to two audit trails: the module-specific `deletion_audit` table (for GDPR auditors) and the global `AuditLog` table (for the security console).

---

## Endpoints

| Method | Path | Auth | Request body | Response |
|--------|------|------|-------------|----------|
| `POST` | `/me/delete-account` | Bearer (any role) | — | `{ message, expires_at }` |
| `GET` | `/me/delete-account/confirm` | Bearer (any role) | `?token=<hex>` | `{ message, purge_after }` |
| `POST` | `/me/delete-account/cancel` | Bearer (any role) | — | `{ message }` |
| `GET` | `/me/delete-account/status` | Bearer (any role) | — | `DeletionStatus` |
| `POST` | `/admin/users/:id/delete` | Bearer, OWNER role | `{ reason? }` | `{ message }` |

`DeletionStatus` shape:

```typescript
{
  state: 'none' | 'requested' | 'confirmed' | 'deleted';
  requested_at?: string;       // ISO-8601 (REQUESTED state)
  confirmed_at?: string;       // ISO-8601 (CONFIRMED state)
  grace_days?: number;         // 14 (CONFIRMED state)
  purge_after?: string;        // ISO-8601 (CONFIRMED state)
  deleted_at?: string;         // ISO-8601 (DELETED state)
}
```

---

## State machine

```
NONE
 │
 │  POST /me/delete-account
 │  (token emailed, 24 h TTL)
 ▼
REQUESTED ──────────────────────────────────────┐
 │                                              │
 │  GET /me/delete-account/confirm?token=...    │  POST /me/delete-account/cancel
 │  (token consumed — single use)               │  (resets to NONE)
 ▼                                              │
CONFIRMED ◄─────────────────────────────────────┘
 │
 │  POST /me/delete-account/cancel      (within grace window)
 │  (resets to NONE)
 │
 │  Nightly cron AFTER grace period expires
 │  (PII scrubbed, user.deleted_at = now)
 ▼
DELETED

Admin shortcut:
  ANY STATE → DELETED  via  POST /admin/users/:id/delete  (OWNER only, immediate)
```

---

## Prisma models added / touched

### New columns on `User`

| Column | Type | Purpose |
|--------|------|---------|
| `deletion_requested_at` | `DateTime?` | Timestamp when user first requested deletion. |
| `deletion_confirmed_at` | `DateTime?` | Timestamp when user clicked the confirmation link. Grace period starts here. |
| `deletion_token_hash` | `String?` | SHA-256 hash of the one-time email token. Raw token is NEVER stored. |
| `deletion_token_expires_at` | `DateTime?` | Token TTL (default 24 h). Expired tokens are rejected even if hash matches. |

### New table: `deletion_audit`

Append-only audit trail for the GDPR deletion lifecycle. Separate from `AuditLog` so GDPR auditors get a focused, low-noise report.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `text (uuid)` | Primary key. |
| `user_id` | `text` | The user being acted on. |
| `event` | `text` | One of the `DeletionAuditEvent` values (see below). |
| `actor_id` | `text?` | The user/admin who triggered the event. Null for system/cron. |
| `actor_role` | `text?` | Role at time of action. |
| `metadata` | `jsonb?` | Email snapshot, reason, IP, etc. |
| `created_at` | `timestamp` | Event timestamp. |

Events: `deletion_requested`, `deletion_confirmed`, `deletion_cancelled`, `deletion_finalized`, `admin_force_delete`.

---

## Per-model cascade table

| Model | Strategy | Rationale |
|-------|----------|-----------|
| `User` (row itself) | Tombstone — PII zeroed, `deleted_at` set | Hard-deleting the row would break FK references from coach-side tables (CoachMessage, Invoice, AuditLog). Tombstone keeps FK integrity while removing all PII. Email becomes `deleted-{id}@tombstone.invalid` (RFC 2606 reserved TLD). |
| `UserProfile` | Hard delete | Pure biometric/personal data. No value to any other party once the user is gone. |
| `NotificationPreferences` | Hard delete | No cross-user dependency. |
| `UserPreferences` | Hard delete | Local personalization only. |
| `LoggedFoodEntry` | Hard delete | Client-owned calorie data. |
| `WorkoutSession` + `ExerciseSet` | Hard delete (cascade) | Client training records. |
| `FastingWindow` | Hard delete | Client health log. |
| `WeightLog` | Hard delete | Biometric PII. |
| `WaterLog` | Hard delete | Client health log. |
| `CheckIn` | Hard delete | Daily diary — personal. |
| `Habit` + `HabitLog` | Hard delete (cascade) | Client habit tracking. |
| `LessonCompletion` | Hard delete | Client progress. |
| `CommunityWin` | Hard delete | The user's own posts. |
| `SavedRecipe` | Hard delete | Client bookmark. |
| `ListItem` | Hard delete | Client grocery/prep list. |
| `ClientSignal` | Hard delete | PTM raw signals. Aggregates already captured in `PtmPrediction`. |
| `ClientOutcome` | Hard delete | PTM teaching label. `labelled_by_id` set to NULL via schema `SetNull`. |
| `PtmPrediction` | Hard delete | Contains `user_id` and risk scores. |
| `CoachEffectivenessScore` | Hard delete (if user is coach) | Coach-owned metric. |
| `CoachAlert` | Hard delete (both parties) | Contains the client's ID as the subject. |
| `CoachOnboardingProgress` | Hard delete (if user is coach) | Coach setup state. |
| `CoachProfile` | Hard delete (if user is coach) | Coach business metadata including Stripe IDs. |
| `CoachSubscription` | Hard delete (if user is coach) | Subscription mirror. |
| `Invoice` | Nullify `coach_id` (keep row) | **UK / EU financial records retention: 6 years (Companies Act)**. Row is de-linked rather than deleted. |
| `PaymentFailure` | Hard delete | Diagnostic log, no retention obligation. |
| `InviteCode` | Hard delete (if user is coach) | Coach-issued codes. |
| `BuildWeekEnrollment` + `BuildWeekDayCompletion` | Hard delete (cascade) | Client program progress. |
| `DataExportRequest` | Hard delete | Export payloads contain user's own data. |
| `ClientCoachConsent` | Hard delete | Consent to use data. No data = consent moot. |
| `ActivityEvent` | Hard delete (all parties) | Operational events tied to user. |
| `MessageDraft` | Hard delete | Coach-authored draft linked to client. |
| `CoachMessage` | Anonymize — sender_id / client_id references replaced; body cleared on sent messages | The OTHER party (coach) still owns their side of the thread. Deleting the row would break the coach's inbox. Body text is cleared so the deleted user's words are removed. |
| `AuditLog` | Anonymize — `actor_id` set to null; `target_user_id` stays (set null by schema) | Compliance record must survive. Actor attribution removed. Event integrity kept. |
| `MealPlan` | Nullify `client_id` or `coach_id` as appropriate | Meal plan content was authored by the coach; the plan stays for the coach. |
| `CoachGuideline` | Delete if user is CLIENT; nullify `coach_id` if user is COACH | Guidelines authored by the coach stay attached to the coach record. |
| `CoachNudge` | Clear body text; nullify affected party IDs | Nudge content may contain user-addressing language. |
| `DiagnosticSubmission` | Nullify `user_id` (keep row) | Lead funnel analytics. Per schema comment: no FK cascade by design. |
| `Recipe` | Nullify `creator_id` | Recipes are shared platform content. |
| `Lesson` | Nullify `coach_id` | Lessons are shared content. |
| `WorkoutRoutine` | Nullify `creator_id` | Coach-authored routines are shared content. |

---

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `DELETION_GRACE_DAYS` | `14` | Calendar days between `deletion_confirmed_at` and PII scrub. GDPR requires "without undue delay" — 14 days gives users a genuine cancel window while satisfying that obligation. |
| `DELETION_FINALIZE_CRON` | `0 3 * * *` | Cron expression for the nightly finalize job (3:00 AM UTC by default). |
| `DELETION_TOKEN_TTL_HOURS` | `24` | How long the email confirmation link is valid. Expired links are rejected — the user must re-request. |
| `APP_BASE_URL` | `https://app.thegrowthproject.io` | Base URL for the confirmation link in the email. |

---

## Cron job

`AccountDeletionService.runFinalizeCron()` is decorated with `@Cron(process.env.DELETION_FINALIZE_CRON ?? '0 3 * * *')`. It:

1. Queries `User` where `deletion_confirmed_at <= NOW() - DELETION_GRACE_DAYS` AND `deleted_at IS NULL`.
2. Processes each candidate through `finalizeUserDeletion()` (the PII scrub transaction).
3. Writes a `deletion_audit` row + `AuditLog` row per finalized user.
4. **Idempotent:** the `deleted_at IS NULL` predicate means re-running on an already-finalized user is a safe no-op.
5. Processes at most 500 users per run (safety cap).

---

## Tests

| File | What it tests |
|------|---------------|
| `account-deletion.service.spec.ts` | Full lifecycle (request → confirm → cancel), 14-day finalize, admin force-delete is audited, token hashing is one-way (SHA-256), expired tokens are rejected, deletion is idempotent (already-deleted user = no-op), cron does nothing when no candidates, cron finalizes past-grace users |

---

## Security notes

- Confirmation tokens are generated with `crypto.randomBytes(32)` (256 bits of entropy).
- Only the SHA-256 hash of the token is stored (`deletion_token_hash`). The raw token is never persisted.
- Tokens are single-use: the hash is cleared when the user confirms.
- The confirm endpoint returns `401 Unauthorized` for any token mismatch (valid-looking but wrong, or expired) so callers cannot distinguish "never existed" from "expired" — both are indistinguishable oracle-wise.
- The admin force-delete endpoint is gated by `@Roles('owner')` + `RolesGuard` — only `role=owner` users can call it.

---

## Future work / dependencies

- **Data export MUST ship before this module is enabled in production.** GDPR Article 20 (right to data portability) requires that users can download their data before it is deleted. The data-export track (Phase 10, Wave C) must be merged and verified first. See `src/users/account.service.ts` for the existing export stub.
- **Email delivery:** `sendConfirmationEmail()` currently logs the confirmation URL. Wire it to the Phase 9 digest mail infra (or your transactional mailer) before going live.
- **Supabase Auth cleanup:** After `finalizeUserDeletion`, the corresponding Supabase Auth user should be deleted out-of-band so the email address is truly freed. Add a call to `SupabaseAdminService.deleteUser(supabase_id)` once that service is wired.
- **Invoice retention:** Invoice rows are nullified rather than deleted because UK Companies Act requires financial records for 6 years. Consider archiving them to cold storage after the retention window.
