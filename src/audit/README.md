# `src/audit/`

Append-only audit log for sensitive actions (role changes, account
deletions, data exports, etc.). See [`docs/audit-and-gdpr.md`](../../docs/audit-and-gdpr.md)
for the full story — this README is a quick orientation only.

## Files

- `audit.module.ts` — `@Global()` Nest module exporting `AuditService`.
- `audit.service.ts` — write + read API. Exports the `AuditAction`
  string-constants table that call sites should use instead of free-form
  strings.

## Usage

```ts
import { AuditAction, AuditService } from '../audit/audit.service';

constructor(private audit: AuditService) {}

async demote(actorId: string, targetId: string) {
  // … do the thing …
  await this.audit.write({
    action: AuditAction.USER_ROLE_CHANGED,
    actorId,
    targetUserId: targetId,
    metadata: { from: 'owner', to: 'coach' },
  });
}
```

## Design notes

- **Append-only.** The service exposes `write` and `list` only — no
  update or delete. The DB schema enforces this by convention; there is
  no UI or endpoint to mutate rows.
- **Best-effort writes.** A DB failure on `auditLog.create` is logged
  but not thrown — a transient outage on the audit table must not 500
  every privileged endpoint. Callers can treat `write` as
  fire-and-forget.
- **Tenant scoping** via `tenant_coach_id`. Owner queries can scope to
  a single coach's tenant without joining the actor/target users.
- **PII survival.** `actor_id` / `target_user_id` are
  `ON DELETE SET NULL`, but `actor_email_snapshot` is captured at write
  time so forensic review survives the user's PII scrub.
