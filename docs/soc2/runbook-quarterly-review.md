# Quarterly SOC 2 Review Runbook

Run this every quarter. It takes about 2–3 hours the first time, and about 1 hour once you have the rhythm. The goal is to maintain the evidence trail that a Type II auditor will look at.

**Who runs this:** Bradley (or the compliance contact). You'll need owner-level access to the app, GitHub, Fly.io, and Supabase.

**When to run:** End of March, end of June, end of September, end of December.

**Output:** A completed review file at `<<EVIDENCE_FOLDER>>/<year>-Q<n>/quarterly_review_<date>.md`. File this before the quarter ends.

---

## Step 1 — Access Review (~30 min)

Goal: confirm that everyone who has access to production systems still needs that access.

### 1a. Application role audit

1. Call `GET /api/admin/users?role=owner` with your owner JWT. This returns all `owner`-role users.
2. Confirm each owner is a real person who currently works at or with the company.
3. Revoke any stale owners: call `POST /api/admin/users/:id/promote` with `role: "coach"` or `role: "student"` as appropriate, or delete the user account.
4. Record the current owner list in your review file.

### 1b. Infrastructure access audit

For each system, pull the current user list and verify everyone should be there:

| System | How to get the list |
|---|---|
| **GitHub org** | github.com/orgs/BradleyGleavePortfolio/people |
| **Fly.io org** | Fly.io dashboard → Organization → Members |
| **Supabase project** | Supabase dashboard → Project Settings → Members |
| **Stripe** | Stripe dashboard → Team |
| **Sentry** | Sentry → Organization Settings → Members |
| **PostHog** | PostHog → Organization Settings → Members |

For any person who no longer works with the company:
1. Remove them from each system immediately.
2. Check whether they had access to any secrets (API keys, database passwords). If so, rotate those secrets (see Step 4).
3. Log the removal in your review file with the date and reason.

### 1c. Sign off

In your review file, write:
```
Access review completed: <date>
Owner-role users: <list>
Stale access revoked: <list, or "none">
Secrets rotated due to offboarding: <list, or "none">
Reviewed by: <your name>
```

---

## Step 2 — Evidence Snapshot (~15 min)

1. Make sure you are logged in as an `owner`.
2. Call:
   ```
   GET /api/admin/soc2/evidence-snapshot
   Authorization: Bearer <your owner JWT>
   ```
3. Save the response as `snapshot_<YYYYMMDD>.json` in `<<EVIDENCE_FOLDER>>/<year>-Q<n>/`.
4. Inspect the snapshot:
   - `roleDecoratedRoutes` — any routes missing a `@Roles()` decorator? If so, open a GitHub issue immediately.
   - `auditLogSample` — do the recent entries look normal? Any unexpected `user.role_changed` or admin actions you don't recognize?
   - `flyConfig` — are the expected regions listed?
5. Note any anomalies in your review file.

---

## Step 3 — Backup Test (~30 min)

Goal: confirm that the database can actually be restored.

1. Go to Supabase dashboard → Settings → Database → Backups. Screenshot the backup status. Confirm the most recent backup is less than 25 hours old (daily backup).
2. If PITR is enabled: confirm the retention window is set to `<<BACKUP_RETENTION_DAYS>>` days or more.
3. Perform a restore test:
   - Supabase dashboard → Backups → Restore to a new database (use a test project, not production).
   - Run a basic query against the restored database: `SELECT count(*) FROM "User";`
   - Confirm the row count is plausible.
   - Delete the test database immediately after.
4. Record in your review file:
   ```
   Backup test completed: <date>
   Most recent backup age: <hours>
   Restore test result: <success/failure>
   Row count on restored DB: <count>
   Test DB deleted: yes
   ```

If the restore test fails, this is a P2 incident. Open an issue and escalate to the Technical Lead.

---

## Step 4 — Rotate One Set of Secrets (~30 min)

Rotate at least one category of secrets per quarter so no key is more than 1 year old. Rotate in this order across quarters:

| Quarter | Rotate |
|---|---|
| Q1 (March) | Supabase Service Role Key + Anon Key |
| Q2 (June) | Stripe Webhook Secret + API Keys |
| Q3 (September) | Sentry DSN + PostHog Project API Key |
| Q4 (December) | Any remaining integration keys + internal service tokens |

**How to rotate Fly.io secrets:**

```bash
# Rotate a secret
flyctl secrets set SECRET_NAME="new_value" --app <<FLY_APP_NAME>>

# Verify new value is set (shows redacted)
flyctl secrets list --app <<FLY_APP_NAME>>
```

Follow the Secrets Rotation Runbook (`docs/secrets-rotation-runbook.md`) for each key's full rotation procedure.

Record in your review file:
```
Secrets rotated this quarter: <list of key names>
Rotation date: <date>
Old keys revoked with providers: <yes/no + details>
```

---

## Step 5 — Vulnerability Scan (~15 min)

1. Run `npm audit --audit-level=high` against the backend:
   - GitHub → backend repo → Actions → trigger or view the latest `build-and-test` run.
   - `npm audit` is run as part of the build (or run it in the GitHub Actions environment).
   - Alternatively, clone locally and run `npm audit --audit-level=high`.
2. Review any high or critical findings.
3. For any high-severity finding: open a GitHub issue and resolve it within 30 days.
4. For any critical-severity finding: treat as a P2 incident. Resolve within 7 days.
5. Record in your review file:
   ```
   npm audit result: <clean / N high / N critical>
   Issues opened: <list, or "none">
   ```

---

## Step 6 — Audit Log Review (~15 min)

Review the audit log for anything unusual:

```
GET /api/admin/audit-log?limit=200
Authorization: Bearer <your owner JWT>
```

Look for:
- `user.role_changed` — any unexpected role promotions?
- `user.account_deleted` — expected deletions?
- Any actions by actors you don't recognize?
- Any unusual spikes in `billing.*` actions (potential billing fraud)?
- Any `user.data_export_requested` entries — were these legitimate user requests?

If you see anything unexpected, investigate before closing the review. Treat confirmed unauthorized access as a P1 incident.

Record in your review file:
```
Audit log reviewed: <date>
Entries reviewed: <count>
Anomalies found: <description, or "none">
Actions taken: <description, or "none">
```

---

## Step 7 — Vendor Review (~15 min)

Once per year (do this in Q4):

1. Open `docs/soc2/policies/vendor-management-policy.md`.
2. For each vendor in the subprocessor table: check that their SOC 2 report is current (most expire annually). Download the latest report and save to `<<VENDOR_EVIDENCE_LOCATION>>`.
3. Confirm each DPA is still valid.
4. Check each vendor's security incident history: search `<<vendor name>> security breach 2025` and review results.
5. Remove any vendor from the table that is no longer in use.
6. Add any new vendor that was onboarded this year.

Record in your review file:
```
Vendor review completed: <date>
SOC 2 reports refreshed: <list>
New vendors added: <list, or "none">
Vendors removed: <list, or "none">
```

---

## Step 8 — File the Review (~10 min)

1. Complete the review file (template below).
2. Save it to `<<EVIDENCE_FOLDER>>/<year>-Q<n>/quarterly_review_<date>.md`.
3. Commit a placeholder entry to `docs/soc2/` if needed to keep the review date in source control.

---

## Quarterly Review Template

Copy and fill this in:

```markdown
# Quarterly SOC 2 Review — <Year> Q<n>

**Completed by:** <name>
**Date:** <YYYY-MM-DD>
**Quarter:** <e.g. Q2 2025, covering April–June 2025>

## Step 1 — Access Review

Owner-role users reviewed: <yes>
Owner list: <names>
Stale access revoked: <names, or "none">
Secrets rotated due to offboarding: <key names, or "none">

## Step 2 — Evidence Snapshot

Snapshot saved to: <path>
Anomalies in roleDecoratedRoutes: <description, or "none">
Anomalies in auditLogSample: <description, or "none">
Fly regions in snapshot: <list>

## Step 3 — Backup Test

Most recent backup age at review time: <hours>
Restore test result: <success/failure>
Row count on restored DB: <count>

## Step 4 — Secrets Rotation

Keys rotated: <list>
Old keys revoked: <yes/no>

## Step 5 — Vulnerability Scan

npm audit result: <clean / N high / N critical>
Issues opened: <list, or "none">

## Step 6 — Audit Log Review

Entries reviewed: <count>
Anomalies: <description, or "none">

## Step 7 — Vendor Review (Q4 only)

Completed: <yes/no>
SOC 2 reports refreshed: <list>
Changes to subprocessor table: <description, or "none">

## Notes

<any follow-up items, open questions, or items to escalate>
```

---

*This runbook is original to The Growth Project. Structure informed by AICPA TSC CC4.1 (ongoing monitoring), A1.2 (backup testing), and SOC 2 audit preparation guidance from Vanta (https://www.vanta.com/resources/soc-2-checklist).*
