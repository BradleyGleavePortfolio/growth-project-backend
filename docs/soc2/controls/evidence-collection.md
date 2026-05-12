# Evidence Collection Guide

This document explains how to gather the audit evidence an auditor will ask for. It is a practical, step-by-step guide — not a policy. Run through it before any audit, and repeat the evidence snapshot steps quarterly.

**Who runs this:** Bradley (or whoever acts as the compliance contact). You don't need to be an engineer for most of these steps.

---

## Overview

SOC 2 auditors ask for evidence in three categories:

1. **Policies** — written documents proving you said you would do something.
2. **Configuration** — screenshots or exports proving the system is set up the way the policy says.
3. **Operation** — logs and records proving controls have been working over time.

This guide covers categories 2 and 3 (policies are already covered in `docs/soc2/policies/`).

---

## Automated Evidence Snapshot

The fastest way to start an evidence collection session is to call the evidence snapshot endpoint:

```
GET /api/admin/soc2/evidence-snapshot
Authorization: Bearer <owner-JWT>
```

This returns a JSON bundle with:
- `flyConfig` — current Fly.io app configuration (multi-region, scaling, TLS settings)
- `schemaHash` — SHA-256 of the current `prisma/schema.prisma` (proves the DB schema hasn't silently changed)
- `roleDecoratedRoutes` — list of every controller route with its `@Roles()` declaration (proves role-gating is applied)
- `auditLogSample` — last 100 entries from the `AuditLog` table
- `deploymentHistory` — recent deployment records from Fly.io
- `snapshotAt` — ISO-8601 timestamp of the snapshot

**Save this file** to a read-only location (e.g. S3 bucket `<<COMPANY_NAME>>-soc2-evidence/<date>-snapshot.json`) after every quarterly review. Version-controlled snapshots demonstrate that controls have been consistently in place over time — this is what an auditor means by "operating effectiveness."

---

## Evidence by Control Area

### CC6.1 — Logical Access (Role-Based Access Control)

**What the auditor wants:** Proof that access is enforced by roles and that every route is gated.

**Evidence to collect:**

1. **Role-decorated routes list** (from snapshot):
   - Call `GET /api/admin/soc2/evidence-snapshot` and save the `roleDecoratedRoutes` array.
   - This is a machine-generated list of every HTTP route and its required role — auditor gold.

2. **RolesGuard test results** (from CI):
   - Screenshot of a passing CI run (`build-and-test`) from GitHub Actions.
   - Path: GitHub → Actions → latest `build-and-test` run → view logs.
   - The role-guard rejection tests and the RolesEnforced meta-test (Phase 10 role-gating track) appear here.

3. **Screenshot: branch protection settings**:
   - GitHub → Repository Settings → Branches → `main` → show required status checks.

---

### CC6.2 — Authentication

**What the auditor wants:** Proof that only authenticated users can access user data.

**Evidence to collect:**

1. **JWT verification code** — point auditor to `src/auth/auth.guard.ts` and `src/auth/jwks.service.ts`.
2. **`@Public()` decorator audit** — list of routes that bypass authentication. These should be only public marketing/invite pages.
   ```bash
   # From a local copy, or via GitHub search
   grep -rn "@Public()" src/ --include="*.ts"
   ```
   Screenshot the result. Confirm each `@Public()` use is intentional.
3. **MFA status screenshot** — log into each critical service and screenshot that MFA is enabled:
   - Supabase: project Settings → Authentication → confirm MFA enforcement.
   - Fly.io: Account → Security → MFA.
   - GitHub: Settings → Password and authentication → Two-factor authentication.

---

### CC6.3 — Access Lifecycle (Granting, Changing, Revoking)

**What the auditor wants:** Proof that access is formally requested and revoked.

**Evidence to collect:**

1. **Access log** — the file at `<<ACCESS_LOG_LOCATION>>` listing all access grants and revocations.
2. **GitHub org member list** — export: GitHub Org → People → export (or screenshot).
3. **Audit log: role changes** — query the audit log for `user.role_changed` actions:
   ```
   GET /api/admin/audit-log?action=user.role_changed
   Authorization: Bearer <owner-JWT>
   ```
   Save the response. This shows every role promotion with timestamp, actor, and metadata.
4. **Quarterly access review** — the completed review from the Quarterly Review Runbook.

---

### CC7.2 — Security Monitoring

**What the auditor wants:** Proof you are watching for and responding to security events.

**Evidence to collect:**

1. **Sentry project screenshot** — log into Sentry, screenshot the error rate dashboard for the last 90 days. Path: `<<SENTRY_PROJECT_URL>>` → Issues or Performance view.
2. **Audit log sample** — from the snapshot (`auditLogSample` field), showing event types, actors, timestamps.
3. **Fly.io log export** — download 7 days of logs:
   ```bash
   flyctl logs --app <<FLY_APP_NAME>> --since 168h > fly_logs_$(date +%Y%m%d).txt
   ```
   Save to evidence folder. Logs show 200/400/500 distribution, auth failures, anomalies.

---

### CC8.1 — Change Management

**What the auditor wants:** Proof that code changes go through review and CI.

**Evidence to collect:**

1. **Merged PR list** — GitHub → Pull Requests → Closed → filter last 90 days. Screenshot or export.
2. **Example PR with CI passing** — open one merged PR, screenshot the CI checks showing `build-and-test` ✅.
3. **Branch protection screenshot** — GitHub → Repository Settings → Branches → `main` → screenshot the protection rules.
4. **Deployment history** — from the snapshot (`deploymentHistory` field), showing who deployed what and when.

---

### CC9.2 — Vendor Management

**What the auditor wants:** Proof that vendors are assessed and monitored.

**Evidence to collect:**

1. **Subprocessor table** — the signed `docs/soc2/policies/vendor-management-policy.md`.
2. **Vendor SOC 2 reports** — download each vendor's current SOC 2 Type II report:
   - Supabase: https://security.supabase.com (request report)
   - Fly.io: https://fly.io/security (request report)
   - Stripe: https://stripe.com/docs/security (report available on request via Stripe dashboard)
   - Sentry: https://sentry.io/security/ (request via Sentry support)
   - PostHog: https://posthog.com/handbook/company/security (SOC 2 report available)
   Save each report to `<<VENDOR_EVIDENCE_LOCATION>>`.
3. **DPA status** — confirm DPAs are in place by reviewing account/legal sections of each vendor.

---

### A1.1–A1.2 — Availability and Backups

**What the auditor wants:** Proof of uptime monitoring and backup discipline.

**Evidence to collect:**

1. **Uptime metrics** — Fly.io metrics: `flyctl metrics --app <<FLY_APP_NAME>>` or screenshot from PostHog / external uptime monitor.
2. **Supabase backup status** — Supabase dashboard → Settings → Database → Backups → screenshot showing PITR enabled and retention period.
3. **Backup test result** — from the Quarterly Review Runbook: the completed restore test documentation.
4. **Multi-region config** — from the snapshot (`flyConfig`), showing regions the app is deployed to.

---

### P6.6 — GDPR Data Deletion

**What the auditor wants:** Proof that users can delete their data and we actually delete it.

**Evidence to collect:**

1. **GDPR scrub code** — point auditor to `src/users/gdpr-scrub.service.ts`.
2. **Deletion audit log** — query:
   ```
   GET /api/admin/audit-log?action=user.account_deleted
   Authorization: Bearer <owner-JWT>
   ```
   Save the response showing deletion events.
3. **GDPR delete test** — screenshot of the `GdprScrubService` test passing in CI.

---

## Evidence Folder Structure

Organize evidence by quarter in a shared, access-controlled folder (e.g. Google Drive or S3):

```
<<EVIDENCE_FOLDER>>/
├── 2025-Q3/
│   ├── snapshot_20250930.json        ← from /admin/soc2/evidence-snapshot
│   ├── access_review_20250930.md     ← from quarterly review runbook
│   ├── fly_logs_20250930.txt
│   ├── sentry_screenshot_20250930.png
│   ├── github_prs_20250930.png
│   ├── backup_test_20250930.md
│   └── vendor_reports/
│       ├── supabase_soc2_2025.pdf
│       ├── fly_soc2_2025.pdf
│       └── stripe_soc2_2025.pdf
├── 2025-Q4/
│   └── ...
└── policies/                         ← signed PDFs of each policy
    ├── information-security-policy_signed.pdf
    └── ...
```

---

## Evidence Freshness

| Evidence type | Minimum freshness for Type I | Minimum freshness for Type II |
|---|---|---|
| Policy documents | Signed within last 12 months | Signed within last 12 months |
| Access review | Completed this quarter | Each quarter of observation period |
| Evidence snapshots | At least one recent one | One per month of observation period |
| Backup test | Completed this quarter | Each quarter of observation period |
| Vendor SOC 2 reports | Current year (annual) | Current year (annual) |
| CI screenshots | Recent PR (past 30 days) | Continuous — CI logs available in GitHub |

---

*This guide is original to The Growth Project. Evidence collection approach informed by Vanta's SOC 2 readiness documentation (https://www.vanta.com/resources/soc-2-checklist) and the AICPA's Illustrative SOC 2 Reports (https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services).*
