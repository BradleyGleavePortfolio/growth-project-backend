# `src/audit/` — Audit Logging

Append-only audit trail for every sensitive action on the platform: authentication events, role changes, data access by coaches, account deletions, data exports, notification preference changes, and more. Every row is written once and never updated or deleted. Rows survive the user's PII scrub (FKs are set to NULL via ON DELETE SET NULL; the row itself and the `actor_email_snapshot` column are preserved for forensic review).

---

## Endpoints

| Method | Path | Auth / Role | Request | Response |
|--------|------|-------------|---------|----------|
| `GET` | `/admin/audit/log` | JWT + OWNER only | Query params (see below) | Array of `AuditLog` rows |
| `GET` | `/admin/audit-log` | JWT + OWNER only | Same as above (legacy path, delegates to `AuditService.list`) | Array of `AuditLog` rows |

### Query Parameters for `GET /admin/audit/log`

| Param | Type | Description |
|-------|------|-------------|
| `action` | `string` | Exact action string match (e.g. `auth.login`) |
| `target_user_id` | `string` | Scope to a single target user |
| `tenant_coach_id` | `string` | Scope to a single coach's tenant |
| `before` | `ISO 8601` | Cursor: return rows with `created_at < before` |
| `limit` | `number` | Page size; server clamps to [1, 200], defaults to 50 |

Pagination pattern: use the `created_at` of the last row returned as the `before` value for the next page.

---

## Prisma Model

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String` (UUID) | Primary key |
| `action` | `String` | Audit action string (e.g. `auth.login`) |
| `actor_id` | `String?` | FK to `User.id`; SET NULL on user delete |
| `actor_role` | `String?` | Role at time of action |
| `actor_email_snapshot` | `String?` | Email captured at write time; survives PII scrub |
| `target_user_id` | `String?` | FK to `User.id`; SET NULL on user delete |
| `target_type` | `String?` | Type of target resource (e.g. `"user"`) |
| `target_id` | `String?` | ID of the target resource |
| `tenant_coach_id` | `String?` | Coach whose tenant the action affected |
| `ip` | `String?` | Client IP address |
| `user_agent` | `String?` | Client user-agent string |
| `metadata` | `Json?` | Action-specific payload (redacted — see policy below) |
| `created_at` | `DateTime` | Row creation timestamp (default: now) |

**Indexes:** `(action, created_at)`, `(actor_id, created_at)`, `(target_user_id, created_at)`, `(tenant_coach_id, created_at)`.

**No `@updatedAt` field.** The model is append-only by design.

---

## Action Enum

Every action string follows the naming convention `<domain>.<event_past_tense>`.

| Action constant | String value | What triggers it | Metadata fields |
|-----------------|-------------|------------------|-----------------|
| `AUTH_LOGIN` | `auth.login` | Successful email/password login | `{ via: "email_password" }` |
| `AUTH_LOGIN_FAILED` | `auth.login_failed` | Failed login attempt | `{ reason: "invalid_credentials" }` |
| `AUTH_APPLE_SIGNIN` | `auth.apple_signin` | Successful Apple Sign-In | `{ is_new_user: boolean, invite_attached: boolean }` |
| `AUTH_PASSWORD_CHANGE` | `auth.password_change` | User changes their password | `{}` (no values — only timestamp) |
| `AUTH_BIOMETRIC_UNLOCK_SETUP` | `auth.biometric_unlock_setup` | User enables biometric unlock | `{ device_hint: string? }` |
| `USER_ROLE_CHANGED` | `user.role_changed` | Admin promotes or demotes a user | `{ from: string, to: string, via: string }` |
| `USER_ACCOUNT_DELETION_SCHEDULED` | `user.account_deletion_scheduled` | User schedules account deletion | `{ scheduled_at: string }` |
| `USER_ACCOUNT_DELETION_CANCELED` | `user.account_deletion_canceled` | User cancels scheduled deletion | `{}` |
| `USER_ACCOUNT_DELETED` | `user.account_deleted` | Account hard-deleted by scrub job | `{}` |
| `USER_DATA_EXPORT_REQUESTED` | `user.data_export_requested` | User requests a GDPR data export | `{}` |
| `USER_DATA_EXPORT_FULFILLED` | `user.data_export_fulfilled` | Export job completes | `{}` |
| `USER_DATA_EXPORT_FAILED` | `user.data_export_failed` | Export job fails | `{ error_hint: string }` |
| `COACH_PROFILE_CREATED` | `coach.profile_created` | New coach profile is created | `{}` |
| `COACH_CLIENT_ARCHIVED` | `coach.client_archived` | Coach archives a client | `{}` |
| `COACH_CLIENT_UNARCHIVED` | `coach.client_unarchived` | Coach restores a client | `{}` |
| `COACH_ASSIGNED_CLIENT_CHANGE` | `coach.assigned_client_change` | Client added to or removed from a coach's roster | `{ change: "added" \| "removed" }` |
| `COACH_VIEWED_CLIENT_DATA` | `coach.viewed_client_data` | Coach opens a client's timeline or summary | `{ view: "timeline" \| "summary", days?: number }` |
| `PTM_OUTCOME_LABELLED` | `ptm.outcome_labelled` | Owner labels a client outcome | `{ outcome_type, prior_outcome_type, notes_present }` |
| `PTM_RISK_BOARD_VIEW` | `ptm.risk_board_view` | Owner views the risk board | `{ bucket: string?, cursor: string? }` |
| `NOTIFICATION_PREF_CHANGE` | `notification.pref_change` | User updates notification preferences | `{ changed_keys: string[], is_create: boolean }` |
| `BILLING_SUBSCRIPTION_UPDATED` | `billing.subscription_updated` | Stripe webhook: subscription updated | `{ stripe_subscription_id }` |
| `BILLING_SUBSCRIPTION_CANCELED` | `billing.subscription_canceled` | Stripe webhook: subscription canceled | `{ stripe_subscription_id }` |
| `BILLING_INVOICE_PAID` | `billing.invoice_paid` | Stripe webhook: invoice paid | `{ stripe_invoice_id }` |
| `BILLING_INVOICE_PAYMENT_FAILED` | `billing.invoice_payment_failed` | Stripe webhook: payment failed | `{ stripe_invoice_id }` |
| `BLOODWORK_VIEW` | `bloodwork.view` | Coach or owner views a bloodwork panel | `{ panel_id: string }` |
| `BLOODWORK_DISCLAIMER_ACKED` | `bloodwork.disclaimer_acked` | Client acknowledges the bloodwork disclaimer | `{ panel_id: string }` |
| `BLOODWORK_ENTRY_CREATED` | `bloodwork.entry_created` | Client creates a bloodwork panel | `{ panel_id: string }` |
| `BLOODWORK_ENTRY_UPDATED` | `bloodwork.entry_updated` | Client or coach updates a bloodwork panel | `{ panel_id: string }` |
| `LEADERBOARD_OPTIN_CHANGED` | `leaderboard.optin_changed` | User opts in or out of the leaderboard | `{ opted_in: boolean }` |
| `CONSENT_GRANTED` | `consent.granted` | Client grants a coach a data scope | `{ scope: string }` |
| `CONSENT_REVOKED` | `consent.revoked` | Client revokes a coach's data scope | `{ scope: string }` |

### Redaction Policy

The following are **never** stored in `metadata`:
- Plaintext passwords or password hashes
- Raw lab result values (only panel IDs are logged)
- Full payment card numbers or CVVs
- Complete session tokens

Violating this policy is a security incident. Redaction is enforced via code review; the service has no runtime enforcement (which would cost too much at write-path latency).

---

## Files

| File | Purpose |
|------|---------|
| `audit.service.ts` | `write()` (append-only insert) and `list()` (owner-scoped read). `AuditAction` constant table exported here. |
| `audit.controller.ts` | `GET /admin/audit/log` — owner-only read surface. |
| `audit.module.ts` | `@Global()` NestJS module so any service can inject `AuditService` without listing `AuditModule` in its own imports. |

---

## Environment Variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUDIT_LOGGING_ENABLED` | `on` | Kill switch. Set to `off` to suppress all audit writes without removing call sites. Reads via `list()` are unaffected. Use only for short-lived debugging windows. |

---

## Services Wired (Phase 10)

| Service | Actions logged | Notes |
|---------|---------------|-------|
| `auth.service.ts` | `auth.login`, `auth.login_failed`, `auth.apple_signin` | Fire-and-forget via `void`. `login_failed` does a best-effort user lookup to attach actor ID. |
| `coach.service.ts` | `coach.viewed_client_data` | Logged on `getClientTimeline()` and `getClientSummary()` after the client ownership check passes. |
| `admin/ptm/admin-ptm.service.ts` | `ptm.risk_board_view`, `ptm.outcome_labelled` | Risk board view logged only when `actor` param is supplied by the controller. |
| `notifications/notifications.service.ts` | `notification.pref_change` | Metadata includes only the key names that changed, not their new values. |
| `bloodwork.service.ts` (PR #103) | `bloodwork.view`, `bloodwork.disclaimer_acked`, `bloodwork.entry_created`, `bloodwork.entry_updated` | Already wired in `feat-bloodwork-rails`. Constants are defined here so both branches share the same string values. |
| `leaderboard.service.ts` (PR #148) | `leaderboard.optin_changed` | Wired in `feat/phase-7c-peer-leaderboard`. Constants defined here. |
| `admin.service.ts` | `user.role_changed`, `user.account_deletion_*`, `user.data_export_*` | Pre-existing wiring. |
| `billing` (Stripe webhook) | `billing.subscription_*`, `billing.invoice_*` | Pre-existing wiring. |

---

## Test Coverage

| Test file | What it asserts |
|-----------|----------------|
| `test/audit-phase10.spec.ts` | Kill switch (`AUDIT_LOGGING_ENABLED=off`), kill switch off (default on), append-only contract (no update/delete methods), `AuditController` role guard + params, `auth.login` audit payload shape, `auth.login_failed` never contains password, `auth.apple_signin` never contains token, `coach.viewed_client_data` on timeline + summary, `ptm.risk_board_view` with/without actor, `notification.pref_change` payload shape + no raw values |
| `test/audit.service.spec.ts` | Core `write()` and `list()` happy path + error swallowing (pre-existing) |
| `test/admin-audit.spec.ts` | Owner-only access gate on admin audit endpoint (pre-existing) |
| `test/billing-audit.spec.ts` | Billing event audit writes (pre-existing) |
| `test/coach-archive-audit.spec.ts` | Coach archive/unarchive audit writes (pre-existing) |

---

## Retention Policy

Rows are retained indefinitely by default. There is no automatic archival, expiry, or deletion in this track.

The platform's GDPR scrub job sets `actor_id` and `target_user_id` to NULL (via `ON DELETE SET NULL`) when a user is deleted, but the row itself is preserved with `actor_email_snapshot` intact for forensic review.

Future work: add a configurable retention window (e.g. 7 years for GDPR Article 5 compliance) with an archival job that streams rows older than the window to cold storage (S3 / GCS Nearline) and deletes them from Postgres.

---

## Future Work

| Item | Notes |
|------|-------|
| **Log shipping** | Stream `audit_log` rows to a SIEM (e.g. Datadog, Splunk, AWS CloudWatch Logs). Single-writer INSERT + indexed reads make Kinesis Firehose or Logstash JDBC polling straightforward. |
| **Anomaly detection** | Alert when `auth.login_failed` > N/minute per IP or per email — brute-force signal. |
| **Archival** | Move rows older than retention threshold to cold storage. See Retention Policy section. |
| **Auth.password_change wiring** | A future PR that adds a self-service password-change endpoint should call `audit.write({ action: AuditAction.AUTH_PASSWORD_CHANGE, ... })`. The constant is defined and ready. |
| **Biometric unlock wiring** | Wire `AUTH_BIOMETRIC_UNLOCK_SETUP` once the mobile biometric enrollment endpoint is built. |
| **CSV export** | `GET /admin/audit/log?format=csv` — streams all filtered results without the 200-row pagination cap. |

---

*See also: [`docs/audit-and-gdpr.md`](../../docs/audit-and-gdpr.md) for the compliance narrative.*
