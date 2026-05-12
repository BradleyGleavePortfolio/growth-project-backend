# Access Control Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Verify that the role matrix in Section 5 reflects the actual system roles in production.
- [ ] Complete the initial access review (Section 7) and file the result.
- [ ] Ensure the role-gating hardening track is merged (referenced in Section 5).
- [ ] Store signed copy in the company Google Drive.
- [ ] Set annual review reminder.

---

## Policy Details

| Field | Value |
|---|---|
| **Company name** | `<<COMPANY_NAME>>` |
| **Effective date** | `<<EFFECTIVE_DATE>>` |
| **Policy owner** | `<<POLICY_OWNER_NAME>>`, `<<POLICY_OWNER_TITLE>>` |
| **Next review date** | `<<NEXT_REVIEW_DATE>>` |
| **Version** | 1.0 |

---

## 1. Purpose

This policy defines how access to `<<COMPANY_NAME>>` systems and data is requested, granted, maintained, and revoked. Strong access control is the single most effective security control we have — it limits the damage any one compromised account or bad actor can do.

**Plain English:** This document answers "who can see what, and how do they get that access or lose it."

---

## 2. Guiding Principle: Least Privilege

Every person and system gets the minimum access needed to do their job — nothing more. This is called the "principle of least privilege." When in doubt, grant less access and expand it if needed, rather than granting broad access and restricting it later.

---

## 3. Scope

This policy covers all systems operated by `<<COMPANY_NAME>>`:

- **Application** — The Growth Project backend API (NestJS + Supabase Postgres on Fly.io)
- **Infrastructure** — Fly.io org, Supabase project, Cloudflare
- **Source control** — GitHub organization `BradleyGleavePortfolio`
- **Third-party services** — Stripe, Sentry, PostHog, Google Workspace, and any tool listed in the Vendor Management Policy

---

## 4. Identity and Authentication

- All production access requires a unique, personal account. Shared accounts are prohibited.
- MFA is **required** for every service that supports it. MFA method must be an authenticator app or hardware key — SMS-only MFA is not permitted for production systems.
- Session tokens must expire. The application uses Supabase JWTs with a `<<JWT_EXPIRY>>` expiry (default: 1 hour) verified locally via JWKS.
- Password requirements and device requirements are in the [Acceptable Use Policy](acceptable-use-policy.md).

---

## 5. Application Role Matrix

The Growth Project backend enforces three application-level roles. This is implemented via `JwtAuthGuard` + `RolesGuard` + `@Roles()` decorator in `src/auth/` (see Phase 10 role-gating track).

| Role | Who has it | What they can access |
|---|---|---|
| `owner` | Platform operator (Bradley, and any future ops staff) | All routes, including `/admin/*`, user management, billing controls, audit logs, SOC 2 evidence snapshot |
| `coach` | Paying coaches with an active subscription | Their own clients, their own profile, coach-specific analytics. Cannot access other coaches' data. |
| `student` | End-users (athletes) | Their own health and fitness data only. Cannot access any other user's data. |

**Technical implementation:** `RolesGuard` in `src/auth/roles.guard.ts` reads the `@Roles()` metadata and enforces the `owner > coach > student` hierarchy. A route decorated `@Roles('coach')` is also accessible by `owner`. Every privileged route is decorated with `@Roles(...)` — a "no decorator" route is open to any authenticated user.

The Phase 10 role-gating hardening track (`feat/phase-10-role-gating`) adds a meta-test (`src/auth/__tests__/RolesEnforced.meta.spec.ts`) that asserts every controller route is explicitly decorated, closing the "forgotten decorator" attack surface.

---

## 6. Infrastructure Access

| System | Who has access | Access method | MFA required |
|---|---|---|---|
| Fly.io | `<<FLYIO_ADMINS>>` | Fly.io dashboard + `flyctl` CLI | Yes |
| Supabase | `<<SUPABASE_ADMINS>>` | Supabase dashboard | Yes |
| GitHub org | `<<GITHUB_ADMINS>>` | GitHub.com | Yes |
| Stripe | `<<STRIPE_ADMINS>>` | Stripe dashboard | Yes |
| Sentry | `<<SENTRY_ADMINS>>` | Sentry.io | Yes |
| Production DB (direct) | No one in normal operations | Supabase SQL editor, break-glass only | Yes |

**Break-glass production DB access:** Direct database access is reserved for incident recovery. Each use must be logged in the audit log within 24 hours, with the reason, what was queried or changed, and who authorized it.

---

## 7. Access Lifecycle

### 7.1 Granting Access (Onboarding)
1. New staff / contractor submits an access request to `<<POLICY_OWNER_NAME>>`.
2. Request specifies which systems are needed and justifies why.
3. `<<POLICY_OWNER_NAME>>` approves or denies within 2 business days.
4. Access is granted to the minimum required level.
5. Completion is logged in `<<ACCESS_LOG_LOCATION>>`.

### 7.2 Changing Access (Role Change)
1. Any role change (e.g. contractor becomes full-time, engineer becomes tech lead) triggers an access review.
2. Old access is revoked before new access is granted where possible.
3. The change is logged in the application audit log (`AuditAction.USER_ROLE_CHANGED`) and the infrastructure access log.

### 7.3 Revoking Access (Offboarding)
1. When employment / contract ends, access must be revoked **within 4 hours** of the end date.
2. Steps:
   - Remove from GitHub org
   - Remove from Fly.io org
   - Remove from Supabase project
   - Remove from Stripe restricted-key list
   - Remove from Sentry org
   - Remove from Google Workspace
   - Change any shared secrets that the person knew (see Secrets Rotation Runbook)
3. Revocation is logged in `<<ACCESS_LOG_LOCATION>>`.

---

## 8. Quarterly Access Review

Every quarter, `<<POLICY_OWNER_NAME>>` performs an access review:

1. Pull the current user list from each system.
2. Verify every person still needs the access they have.
3. Revoke stale or over-privileged access immediately.
4. File the review result in `<<ACCESS_LOG_LOCATION>>`.

The Quarterly Review Runbook (`docs/soc2/runbook-quarterly-review.md`) has step-by-step instructions.

---

## 9. Service Accounts and API Keys

- Every API key is associated with a named service or person — no anonymous keys.
- API keys are stored as Fly.io secrets or in the approved secrets manager. Never in code.
- API keys are rotated at least annually or immediately after any suspected compromise.
- The Secrets Rotation Runbook (`docs/secrets-rotation-runbook.md` — see Phase 10 secrets rotation track) documents each key's rotation procedure.

---

## 10. Audit Logging

Every significant access event — including role promotions, login failures, admin actions, and data exports — is written to the `AuditLog` table by `AuditService` (`src/audit/audit.service.ts`). Logs are immutable: no delete or update is permitted on `AuditLog` rows. The audit log is queryable by owners at `GET /admin/audit-log`.

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This policy template is original to The Growth Project. Structure informed by AICPA TSC CC6.1–CC6.3 (logical access) and NIST SP 800-53 AC family (https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final).*
