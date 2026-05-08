# Change Management Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Verify that CI gate names in Section 5 match the actual GitHub Actions job names.
- [ ] Confirm branch protection rules are enabled on `main` (Section 4).
- [ ] Store signed copy in company Google Drive.
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

This policy defines how code changes are made, reviewed, tested, and deployed to the Growth Project production environment. A consistent, auditable change process reduces the risk that a security vulnerability, data loss bug, or breaking change makes it to production undetected.

**Plain English:** Every change to the app goes through a defined process — write code, test it, have a teammate review it, pass automated checks, then deploy. No one person can bypass this process.

---

## 2. Scope

This policy covers all changes to:

- The backend application (`BradleyGleavePortfolio/growth-project-backend`)
- The mobile application (`BradleyGleavePortfolio/growth-project-mobile`)
- Infrastructure configuration (Fly.io, Supabase, Cloudflare)
- Security-sensitive configuration (secrets, role definitions, authentication settings)
- Database schema (Prisma migrations)

---

## 3. Principles

- **No direct pushes to `main`.** All changes go through a Pull Request.
- **No self-merges.** The person who wrote the code cannot merge their own PR unless they are the sole engineer (see Section 3.1 below).
- **CI must pass.** The automated test suite and linter must pass before any PR can be merged.
- **Least-privilege deploys.** Only the automated CI/CD pipeline deploys to production. No one deploys manually by running commands from their laptop except in a declared incident.

### 3.1 Small-team exception

`<<COMPANY_NAME>>` is an early-stage company. Where the team is too small for a second reviewer to be available on every PR, the following applies:

- Changes that touch security-sensitive code (authentication, authorization, encryption, secrets) require a second reviewer, even if that means scheduling async review with a contractor or advisor.
- Changes that are purely additive (new documentation, new non-security features) may be self-merged by the sole engineer, but must still pass CI.
- This exception is reviewed at least annually and narrowed as the team grows.

---

## 4. Branch Protection Rules

The following branch protection rules must be enabled on `main` in both repositories:

| Rule | Setting |
|---|---|
| Require pull request before merging | Yes |
| Required approving reviews | `<<REQUIRED_APPROVERS>>` (recommended: 1) |
| Dismiss stale reviews when new commits are pushed | Yes |
| Require status checks to pass before merging | Yes |
| Required status checks | See Section 5 |
| Include administrators | Yes (no bypass for owners) |
| Restrict who can push to matching branches | Only CI bot + admins |

To verify current branch protection: GitHub → Repository → Settings → Branches → `main`.

---

## 5. CI Gates

Every PR against `main` in the backend must pass:

| Job name | What it runs |
|---|---|
| `build-and-test` | `npx eslint . --ext .ts` → `npx tsc --noEmit` → `npm test` |

Every PR against `main` in the mobile app must pass:

| Job name | What it runs |
|---|---|
| `Typecheck, lint, test` | `tsc --noEmit` → `eslint` → `jest` |

**No exceptions.** If CI is failing, fix it — do not merge with a bypass.

---

## 6. Pull Request Requirements

Every PR must include:

1. **A plain-English description** of what the change does and why.
2. **A list of files changed**, grouped by type (source, test, migration, docs).
3. **Endpoints or screens added** (if any).
4. **New environment variables** (if any) — must also be added to `.env.example` and `src/common/env-validation.ts`.
5. **How CI was driven green** — what was fixed or added to make tests pass.
6. **Out-of-scope items** — what this PR intentionally does NOT address.

The PR body template is in `SHARED_FINISHING_BRIEF.md`.

---

## 7. Database Migrations

Prisma migrations are forward-only (no down migrations). Additional rules:

- Migrations are never edited after they are committed. If a mistake is made, a new migration corrects it.
- Migrations are applied automatically at deploy time via `release_command: npx prisma migrate deploy` in `fly.toml`.
- Destructive migrations (dropping a column, changing a type) require:
  - A comment in the migration file explaining why the change is safe.
  - A data migration step (if existing rows need transformation).
  - Testing against a copy of the production schema before merging.

---

## 8. Emergency Changes (Break-Glass)

In a P1 incident, the normal PR process may be bypassed with these safeguards:

1. The Incident Commander verbally approves the change.
2. The change is deployed.
3. Within 24 hours of the incident closing, a clean-up PR is opened that:
   - Documents what was changed and why.
   - Adds or updates tests to cover the scenario.
   - Passes CI.
4. The bypass is logged in the incident record.

---

## 9. Infrastructure Changes

Changes to Fly.io configuration, Supabase settings, or DNS that affect production must:

1. Be proposed in writing (Slack, email, or GitHub issue) before being made.
2. Be approved by `<<POLICY_OWNER_NAME>>` (or Incident Commander in an emergency).
3. Be logged in `<<INFRA_CHANGE_LOG_LOCATION>>` with date, who made the change, and what changed.

Secret rotation (API keys, database passwords) follows the Secrets Rotation Runbook (`docs/secrets-rotation-runbook.md` — Phase 10 secrets rotation track).

---

## 10. Security-Sensitive Changes

Changes to the following require a security-focused review checklist before merging:

- Authentication logic (`src/auth/`)
- Authorization / role guards (`src/auth/roles.guard.ts`, `@Roles()` decorator)
- Encryption or key handling
- Any endpoint that handles Highly Confidential data (health, biometric)
- `prisma/schema.prisma` changes that add or remove columns on Highly Confidential tables

Security review checklist (include in PR description):
- [ ] Does this change weaken any existing authentication or authorization control?
- [ ] Does this change expose any Highly Confidential data to a lower-privilege role?
- [ ] Does this change log or transmit any Highly Confidential data in plaintext?
- [ ] Are all new endpoints protected with `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)`?
- [ ] Are all new secrets added to `.env.example` and `src/common/env-validation.ts` (not hardcoded)?

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This policy template is original to The Growth Project. Structure informed by AICPA TSC CC8.1 (change management) and NIST SP 800-53 CM (Configuration Management) family (https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final). GitHub branch protection documentation: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches.*
