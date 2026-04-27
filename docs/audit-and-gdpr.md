# Audit log & GDPR account lifecycle

This doc covers two pieces of enterprise-hardening foundation:

1. **AuditLog** — append-only record of sensitive actions, used for
   compliance, incident review, and tenant-isolation audits.
2. **Account lifecycle** — real implementations of `POST
   /users/me/data-export` and `DELETE /users/me/account`, replacing the
   prior stubs.

Both ship as additive schema + new code paths. No existing rows are
mutated; no destructive prod execution is required to deploy this PR.

## Audit log

### Schema

`AuditLog` (see `prisma/schema.prisma`):

| Column                 | Purpose                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `action`               | Canonical event name, e.g. `user.role_changed`. See `AuditAction` constants.      |
| `actor_id`             | The acting user (FK to `User.id`, `ON DELETE SET NULL` for forensic survival).    |
| `actor_role`           | The actor's role at the moment of the action.                                     |
| `actor_email_snapshot` | Email captured at write time. Survives PII scrub of the underlying user.          |
| `target_user_id`       | The user the action affected, if any.                                             |
| `target_type`          | Free-form discriminator (`user`, `coach_profile`, `data_export_request`, …).      |
| `target_id`            | Resource id of the target.                                                        |
| `tenant_coach_id`      | Coach whose tenant the action touched. Lets owners scope queries to one tenant.   |
| `ip` / `user_agent`    | Best-effort transport context. `x-forwarded-for[0]` from Fly.io's edge.           |
| `metadata`             | JSONB bag for action-specific structured data (e.g. `{from, to}` on role change). |
| `created_at`           | Set by Postgres at insert time. Indexed for cursor pagination.                    |

Append-only by convention: `AuditService.write` only calls `create`,
never `update`/`delete`. There is no DELETE endpoint and no scrub job.

### Indexes

- `(action, created_at)` — list "all role changes" or "all account
  deletions" without scanning the full table.
- `(actor_id, created_at)` — "what has this owner done in the last 30
  days?"
- `(target_user_id, created_at)` — "what has been done to this user?"
- `(tenant_coach_id, created_at)` — owner-scoped tenant audit.

### Writing audit entries

```ts
import { AuditAction, AuditService } from '../audit/audit.service';

await audit.write({
  action: AuditAction.USER_ROLE_CHANGED,
  actorId: req.user.id,
  actorRole: req.user.role,
  actorEmail: req.user.email,
  targetUserId: target.id,
  metadata: { from: previous, to: next },
  ip,
  userAgent,
});
```

`AuditService.write` swallows DB errors and logs them — a transient
failure on the audit table must never 500 a privileged endpoint, but
the failure is still observable in app logs.

### Reading audit entries

`GET /api/admin/audit-log` (OWNER-only). Query params:

- `action` — exact match on action string.
- `target_user_id` — filter by target user.
- `tenant_coach_id` — filter by tenant coach.
- `before` — ISO timestamp; returns rows older than this (cursor).
- `limit` — clamped to `[1, 200]`, default 50.

Tenant isolation: there is no per-coach audit-log read surface yet. A
coach reading "audit entries for actions in my tenant" is a follow-up
feature. Today the route is owner-only, which is the safe default.

### Currently wired sensitive actions

- `user.role_changed` — `AdminService.promoteUser`
- `user.data_export_requested` / `_fulfilled` / `_failed` —
  `AccountService.requestDataExport`
- `user.account_deletion_scheduled` / `_canceled` —
  `AccountService.scheduleDeletion` / `cancelDeletion`

Future wiring (intentional follow-up): coach-side `archive_client` /
`unarchive_client`, billing `subscription_canceled`, owner-impersonation
events, message-deletion, lesson-deletion.

## Account lifecycle

### Data export — `POST /users/me/data-export`

Synchronously assembles a JSON snapshot of the caller's personal data
and persists it on `DataExportRequest`. Returns:

```json
{
  "id": "exp-…",
  "status": "ready",
  "requested_at": "2026-04-27T…",
  "fulfilled_at": "2026-04-27T…"
}
```

The payload is fetched via `GET /users/me/data-export/:id`. The export
is scoped strictly to `user_id = req.user.id`. Coach-tenant rows
(messages and nudges _sent_ by the user as a coach) are deliberately
excluded — exporting them would leak other clients' data.

**Tenant isolation pinned in tests** — `account.service.spec.ts`
verifies a different user fetching the same export id gets a 404, not
a redaction.

**Why inline JSON, not S3?** This PR satisfies the legal request today
without a new infra dependency. Object-storage hand-off is the next
hardening step (see "Follow-up").

### Soft-delete — `DELETE /users/me/account`

Two-phase deletion with a 30-day grace period:

1. `DELETE /users/me/account` sets `User.deletion_scheduled_at = now()`.
   Idempotent: a second call within the grace window does not extend the
   deadline.
2. `POST /users/me/account/cancel-deletion` clears the flag.
3. `GET /users/me/account/deletion-status` returns the current state.

A separate scrub worker (out of scope for this PR) will, after
`deletion_scheduled_at + 30d`:

- Set `User.deleted_at`.
- Zero out PII columns (`email` → `deleted-{id}@scrub.invalid`, `name`
  → `Deleted user`, `phone` → `null`, `UserProfile.*` → null,
  `NotificationPreferences.*` → defaults).
- Anonymize `CoachMessage.sender_id` references where the user was
  the sender.
- Preserve aggregate analytics (counts, leaderboard ranks) but strip
  identifying detail.

The scrub worker is **not in this PR** because:

- It is irreversible and must be reviewed independently.
- It needs a runbook for re-running safely on partial failures.
- It needs a feature flag so QA can land it dark in staging first.

The DB schema is ready (`User.deleted_at`); the audit action
`user.account_deleted` is reserved for the worker to write.

### Why no destructive delete today?

Deleting a `User` row would either cascade through ~25 FK relations
(losing coach-side message history, billing invoices, etc.) or fail on
`ON DELETE RESTRICT`. The soft-delete path keeps the DB referentially
intact while still locking the user out — the auth guard can be
extended in a follow-up to reject tokens for users with
`deletion_scheduled_at IS NOT NULL`.

## Tenant isolation

- `AuditLog.tenant_coach_id` is set by every wired call site so owner
  queries can be scoped to a single tenant.
- Data export is scoped to `req.user.id`. Cross-user reads return 404.
- Soft-delete only mutates the caller's own user row.

## Migration

`prisma/migrations/20260427120000_add_audit_log_and_gdpr_lifecycle` is
**fully additive**:

- Adds `User.deletion_scheduled_at`, `User.deleted_at` (both nullable).
- Creates `AuditLog`, `DataExportRequest`.
- Adds indexes; no existing index touched.

Safe to apply via `prisma migrate deploy` at boot. No backfill, no
table rewrites, no destructive DDL.

## Follow-up

1. **PII scrub worker** — cron-driven, behind a feature flag, runs
   `account_deletion_scrub` for rows past the 30-day mark.
2. **Auth lockout** — extend `JwtAuthGuard` to reject tokens for
   `deletion_scheduled_at IS NOT NULL` so a logged-in client cannot
   undo the schedule by spamming requests after the grace expires.
3. **Object-storage payload** — move `DataExportRequest.payload` from
   inline JSONB to a signed S3 URL.
4. **More audit call sites** — coach archive/unarchive, billing
   cancellations, message deletions, owner impersonation.
5. **Per-tenant audit-log read** — let a coach read their own tenant's
   audit log (read-only), gated by `RolesGuard('coach')` +
   `tenant_coach_id = req.user.id`.
