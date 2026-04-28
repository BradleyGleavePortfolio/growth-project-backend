# consent

Consent layer v1 — client → coach data access toggles.

`ClientCoachConsent` holds one row per `(client_id, coach_id, scope)`.
Effective state is derived: *granted* iff `granted_at IS NOT NULL` and
(`revoked_at IS NULL` or `revoked_at < granted_at`). Audit history is
in `AuditLog` under `consent.granted` / `consent.revoked`.

See:
- Schema/migration: `prisma/migrations/20260428000000_add_client_coach_consent/`
- Routes: `/api/consent/*` (client) and `/api/admin/clients/:id/consent` (owner)
- Coach gating: `ConsentService.coachCanAccess` (used by `CoachService`)
- Operator runbook: [`docs/audit-and-gdpr.md`](../../docs/audit-and-gdpr.md)
