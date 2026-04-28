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

- `user.role_changed` — `AdminService.promoteUser` and the gated
  `AuthService.becomeCoach` self-service path (with
  `metadata.via='self_service_become_coach'`).
- `user.data_export_requested` / `_fulfilled` / `_failed` —
  `AccountService.requestDataExport`.
- `user.account_deletion_scheduled` / `_canceled` —
  `AccountService.scheduleDeletion` / `cancelDeletion`.
- `user.account_deleted` — `GdprScrubService.run` (cron + admin trigger).
- `coach.client_archived` / `coach.client_unarchived` —
  `CoachService.archiveClient` / `unarchiveClient`. Idempotent: a re-tap
  on an already-archived client writes no row.
- `billing.subscription_updated` / `billing.subscription_canceled` /
  `billing.invoice_paid` / `billing.invoice_payment_failed` —
  `BillingService.handleEvent`. Each row carries
  `metadata.stripe_event_id` so an operator can correlate a row back to
  the originating Stripe event in the dashboard.

Future wiring (intentional follow-up): owner-impersonation events,
message deletion, lesson deletion.

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

**Auth-guard lockout.** Once `deletion_scheduled_at` is set, `JwtAuthGuard`
rejects every request from that user with `403` _except_ the two recovery
routes (`cancel-deletion`, `deletion-status`), which opt in via the
`@AllowDeletionScheduled()` decorator. Once `deleted_at` is set by the
post-grace scrub, every route — including the recovery routes — returns
`403`; the account is terminal. This prevents a logged-in client from
continuing to mutate data during the grace window and from re-activating
a scrubbed account by spamming requests with a still-valid token.

The scrub worker — `GdprScrubService` (`src/users/gdpr-scrub.service.ts`)
— ships in this repo. After `deletion_scheduled_at + 30d` it:

- Sets `User.deleted_at` and `User.archived_at` to `now()`.
- Tombstones identifying columns on the User row: `email` →
  `deleted-{id}@scrub.invalid` (RFC 2606 reserved TLD; collides with
  nothing real), `name` → `Deleted user`, `phone` → `null`, `supabase_id`
  → `deleted-{id}` so the @unique constraint holds.
- Zeros out PII on `UserProfile`: `avatar_url`, `bio`, `date_of_birth`,
  `preferred_snacks`, `current_weight_lbs`, `target_weight_lbs`, `height_cm`.
- Writes one immutable `user.account_deleted` audit row per scrubbed
  user with `metadata.scope='gdpr_scrub_worker'` and the original email
  captured in `metadata.original_email_snapshot` for forensic
  traceability. The audit row's `actor_email_snapshot` is set when an
  operator triggers a manual run via the admin endpoint; cron-driven
  runs leave actor null and `actor_role='system'`.
- Skips users whose `deletion_scheduled_at` is still inside the grace
  window or whose `deleted_at` is already set (idempotent).

#### Why this shape, not a hard delete?

A hard `DELETE FROM "User"` would either cascade through ~25 FK
relations (losing coach-side message history, billing invoices, audit
log actor refs, etc.) or fail on `ON DELETE RESTRICT`. The tombstone
approach keeps the DB referentially intact while satisfying GDPR
because the User row no longer carries identifying data and the unique
indexes (`email`, `supabase_id`) cannot be re-keyed back to the
original person.

#### How to run it

Three invocation paths, same code:

1. **Cron job (canonical)** — wire `npx ts-node scripts/gdpr-scrub.ts`
   to a Fly cron / Kubernetes CronJob. Reads `GDPR_SCRUB_DRY_RUN` and
   `GDPR_SCRUB_BATCH_LIMIT` from env. Exit code 0 even when individual
   users error (so cron does not flap); exit code 1 only on a fatal
   failure (DB unreachable, etc.).

2. **Owner-only HTTP** — `POST /api/admin/gdpr/scrub?dry_run=true&limit=10`.
   Same code path, attributed to the calling OWNER on the audit row.
   Use `dry_run=true` to inspect candidate ids before flipping the cron
   on for the first time.

3. **Test harness** — pass `now` and `limit` to `GdprScrubService.run()`
   in unit tests. See `test/gdpr-scrub.service.spec.ts`.

#### Safe-rerun semantics

The worker is fully idempotent. A second invocation in the same minute
finds no candidates (the rows it just scrubbed have `deleted_at != null`
so they fall out of the predicate). Per-user transaction failures are
recorded in the report but never poison the rest of the batch — re-run
on the next tick resumes at the failed user.

#### Feature flag for staging

`GDPR_SCRUB_DRY_RUN=true` keeps the worker observable but inert. Land
the cron schedule in staging with the flag on, watch a few cron runs
report candidates correctly, then flip the flag off.

The audit action `user.account_deleted` is the contract. Operators
querying `/api/admin/audit-log?action=user.account_deleted` get the
canonical history of every scrub.

### Why no destructive delete today?

Deleting a `User` row would either cascade through ~25 FK relations
(losing coach-side message history, billing invoices, etc.) or fail on
`ON DELETE RESTRICT`. The soft-delete path keeps the DB referentially
intact while still locking the user out via the `JwtAuthGuard` check
described above.

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

## Operator runbook

### Applying the migration

The migration is forward-only and additive. Apply it via Prisma's
deploy path — never via `migrate dev` or `db push` in production:

```bash
npx prisma migrate deploy
```

Verify it landed:

```sql
\d "User"               -- expect deletion_scheduled_at, deleted_at
\d "AuditLog"           -- new table
\d "DataExportRequest"  -- new table
```

No backfill is required. Existing rows have `deletion_scheduled_at = NULL`
and `deleted_at = NULL`, which is the healthy state.

### Reading the audit log

```bash
# All role changes in the last 24 h
curl -H "Authorization: Bearer $OWNER_JWT" \
  "$API/api/admin/audit-log?action=user.role_changed&limit=100"

# Everything that happened to a single user
curl -H "Authorization: Bearer $OWNER_JWT" \
  "$API/api/admin/audit-log?target_user_id=u-123"

# All sensitive actions inside one coach's tenant
curl -H "Authorization: Bearer $OWNER_JWT" \
  "$API/api/admin/audit-log?tenant_coach_id=c-42"
```

### Honoring a manual GDPR delete request

If a user emails support asking to be deleted, the operator path is:

1. Confirm identity out-of-band.
2. As that user (or via support tooling that issues a token for them),
   call `DELETE /api/users/me/account`. This is the same path the in-app
   button uses; it sets `deletion_scheduled_at` and writes the audit
   row, so the request is attributable.
3. The PII scrub worker (follow-up below) will pick the row up after
   `deletion_scheduled_at + 30d`.

Do **not** edit `User.deleted_at` directly via SQL — that would skip
the audit trail and bypass the FK semantics.

## Follow-up

1. **PII scrub worker** — cron-driven, behind a feature flag, runs
   `account_deletion_scrub` for rows past the 30-day mark.
2. **Object-storage payload** — move `DataExportRequest.payload` from
   inline JSONB to a signed S3 URL.
3. **More audit call sites** — coach archive/unarchive, billing
   cancellations, message deletions, owner impersonation.
4. **Per-tenant audit-log read** — let a coach read their own tenant's
   audit log (read-only), gated by `RolesGuard('coach')` +
   `tenant_coach_id = req.user.id`.
