# audit_log substrate

The `audit_log` table is the structured before/after-state capture substrate
for every PII-touching mutation in the platform. It is the flight recorder:
who did what, to which resource, when, and what the state looked like on either
side of the change. It is distinct from the legacy `AuditLog` event log
(`src/audit/audit.service.ts`), which records forensic action strings; the new
snake_case `audit_log` table captures the structured state snapshot.

This substrate was shipped under operator decisions D-H6-1, D-H6-3, D-H6-4, and
D-H6-5 (see `OPERATOR_DECISIONS_LOG.md`, 2026-06-26). The 13-column shape is
contractual: BL-DATA-CAPTURE PR1 must reuse it, not redesign it.

## What gets logged

Every write that runs through `AuditLogService.withAuditLog()` produces one row
with these 13 columns (D-H6-1):

| Column          | Type          | Notes |
| --------------- | ------------- | ----- |
| `id`            | `uuid`        | Primary key, `gen_random_uuid()` default. |
| `tenant_id`     | `uuid`        | Required. RLS isolation key (R125 tier 1). |
| `actor_id`      | `uuid` null   | The principal that acted; null for system/cron. |
| `actor_type`    | `text`        | `user` / `coach` / `system` / `admin`. |
| `action`        | `text`        | `create` / `update` / `delete` / `read` / custom. |
| `resource_type` | `text`        | `User` / `Coach` / `Message` / ... |
| `resource_id`   | `text` null   | String because the resource is polymorphic. |
| `before_state`  | `jsonb` null  | Redacted state before the change (R98). |
| `after_state`   | `jsonb` null  | Redacted state after the change (R98). |
| `reason`        | `text` null   | Free-text reason. Ships nullable per D-H6-1. |
| `request_id`    | `text` null   | Correlation id for tracing. |
| `ip_address`    | `inet` null   | Caller IP; redactable for GDPR Art. 17. |
| `created_at`    | `timestamptz` | `now()` default. |

The writes are wrapped on the PII-touching service methods: users, auth,
coach, coach-brief, messaging, check-ins, packages, and account-deletion.
The custom ESLint rule `@tgp/audit-log-required` (D-H6-3) fails CI on any new
unwrapped Prisma write in an enforced service file.

### Same-transaction synchronous writes (D-H6-5)

The audit row is written in the SAME database transaction as the PII mutation
it records. The contract:

> "Audit writes are SAME-TRANSACTION synchronous, with a process-level safety
> valve" (D-H6-5, LOCKED 2026-06-26)

If the audit insert fails and the break-glass valve is OFF (default), the whole
transaction rolls back: the PII mutation does not commit without its audit row.
This is double-entry bookkeeping for state changes.

```ts
await this.audit.withAuditLog(
  {
    tenantId,
    actorId: userId,
    actorType: 'user',
    action: 'update',
    resourceType: 'User',
    resourceId: userId,
    afterState: { display_name: newName },
  },
  (tx) => tx.user.update({ where: { id: userId }, data: { display_name: newName } }),
);
```

Pass the `tx` client straight through to your Prisma write so the mutation and
the audit row commit or roll back together.

## How to read it

Reads are tenant-isolated by RLS (R125 tier 1, D-H6-1):

- A normal principal sees only rows for its current tenant, enforced by the
  `audit_log_tenant_isolation` policy keyed on the `app.tenant_id` GUC.
- `admin_role` reads across tenants for compliance/forensic review via the
  `audit_log_admin_read` policy.
- `anon` is denied by a RESTRICTIVE deny-all policy regardless of any
  permissive policy.

The table is append-only at the database level. `REVOKE UPDATE, DELETE ON
audit_log FROM PUBLIC, app_runtime` means no runtime principal can ever mutate
or delete a row (D-H6-1). There is deliberately no UPDATE or DELETE policy.

## Retention and rotation (D-H6-4)

Retention is 7 years flat for every row. Rotation is archive, never delete:

> "7 years flat for everything in audit_log, archive (never delete) on
> rotation" (D-H6-4, LOCKED 2026-06-26)

`scripts/audit-log-retention-rotate.ts` (run by ops cron, NOT scheduled inside
Nest) selects rows older than 7 years, streams them to S3 Object Lock with
Glue-catalog-compatible partitioning, and verifies the PUT. It **never deletes
a row** — the table is the durable forensic record and the S3 archive is a
second, immutable copy, not a tombstone. The script enforces this at import
time: a module-load guard throws if any SQL statement it issues against
`audit_log` would `UPDATE`, `DELETE`, or `TRUNCATE`, so a future edit that adds
a destructive statement cannot even boot. The S3 key is deterministic per row
id, so a re-run over the same window overwrites the identical object instead of
double-archiving. A `--dry-run` mode prints the S3 paths without acting.

## GDPR Art. 17 erasure (D-H6-4)

Right-to-be-forgotten is NOT handled by deleting audit rows. Instead,
`AuditLogService.redactPii(userId)` performs an in-place UPDATE of every
`audit_log` row whose `actor_id` is exactly `userId`, rewriting the PII leaves
of `before_state` / `after_state` with a deterministic erasure token while
leaving the audit fact intact: the row's existence, `action`, `resource_type`,
`resource_id`, `request_id`, and timestamps survive so the compliance trail
(that something happened, when) is preserved. The scope is the passed `userId`
ONLY, never a caller-supplied filter, so an erasure request for one user can
never reach another user's rows.

The token is produced by `erasureToken(plaintext)` in
`src/audit-log/erasure-token.ts`: `tok_` followed by the first 16 hex chars of
`HMAC-SHA256(AUDIT_LOG_ERASURE_HMAC_SECRET, plaintext)` — matching
`/^tok_[a-f0-9]{16}$/`. It is deterministic (the same plaintext erases to the
same token, so erased rows stay correlatable) and one-way (the token never
reverses to the plaintext). The HMAC secret is REQUIRED: `erasure-token.ts`
fails fast at import if `AUDIT_LOG_ERASURE_HMAC_SECRET` is missing, so a
misconfigured deploy never produces unkeyed (guessable) tokens. Re-running
`redactPii` is idempotent — already-tokenized leaves rewrite to the same value.

Because the table REVOKEs UPDATE from the runtime role, the in-place erasure
UPDATE is applied by the privileged service-role path, not the normal runtime
role.

R98 redaction is also enforced on the write path: every `before_state` /
`after_state` passes through `redactPii()`, which strips well-known raw-PII keys
(email, phone, password, tokens, card data, ...) before the row reaches the
database, so the table never durably stores forbidden plaintext.

## Break-glass: AUDIT_LOG_FAIL_OPEN (D-H6-5)

The process-level env var `AUDIT_LOG_FAIL_OPEN` is the operator break-glass.
Default is `0` (or unset): audit-insert failure rolls back the PII mutation.
Set it to the exact string `1` to downgrade an audit-write failure from
"rollback the mutation" to "log the failure and continue committing the
mutation":

```
AUDIT_LOG_FAIL_OPEN=1
```

The valve is read per call, so an operator can flip it during an incident
window without a redeploy. Only the exact string `1` enables it; any other
value (`0`, `true`, empty) leaves the safe default in force. Use it only as an
emergency safety valve when an audit-side outage is blocking critical
mutations, and turn it back off as soon as the incident is resolved.

## Sources

- Operator decisions D-H6-1, D-H6-3, D-H6-4, D-H6-5 — `OPERATOR_DECISIONS_LOG.md`, 2026-06-26.
- Stripe payment-mutation RFC (same-transaction synchronous audit writes): https://hackmd.io/xHyDSe73TjOj4x3V3BIyHg
- AWS CloudTrail append-only / S3 Object Lock precedent: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html
- GDPR Art. 17 (right to erasure): https://gdpr-info.eu/art-17-gdpr/
