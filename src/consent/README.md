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

## `onboarding.agreement` (clinic C01)

The one quick in-app "I agree" box shown at onboarding (owner ruling): covers the
personal-training waiver and letting the coach / platform see the client's
in-app data. Granted per (client, coach) through `POST /consent/grant` like any
other scope. With `FEATURE_CONTRACTS_ENABLED` on, this record — not an external
e-sign waiver — activates invite / free package grants: `ConsentService.onGranted`
notifies `InviteGrantService`, which activates the client's `pending_consent`
grants for that coach (see `src/invite-grant/README.md`). Listener errors are
logged and never fail the consent write.
