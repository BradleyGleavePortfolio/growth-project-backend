# Incident Response Plan

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Confirm that all contact details in the Incident Response Team table are current.
- [ ] Run at least one tabletop exercise (a simulated incident walkthrough) before your first audit.
- [ ] Verify that the Secrets Leak Runbook (referenced in Section 6.3) exists and is current.
- [ ] Store signed copy in company Google Drive.
- [ ] Set annual review reminder.

---

## Policy Details

| Field | Value |
|---|---|
| **Company name** | `The Growth Project, LLC` |
| **Effective date** | `<<EFFECTIVE_DATE>>` |
| **Policy owner** | `<<POLICY_OWNER_NAME>>`, `<<POLICY_OWNER_TITLE>>` |
| **DPO / Privacy contact** | `<<DPO_EMAIL>>` |
| **Next review date** | `<<NEXT_REVIEW_DATE>>` |
| **Version** | 1.0 |

---

## 1. Purpose

An incident is any event that actually or potentially compromises the confidentiality, integrity, or availability of `The Growth Project, LLC`'s systems or user data. This plan defines exactly what to do when one happens — so that in a stressful moment, no one is improvising.

**Plain English:** If something goes wrong — a hack, a data leak, a secret committed to GitHub, a server going down — this document tells you the exact steps to follow and who to call.

---

## 2. Incident Response Team

| Role | Name | Contact |
|---|---|---|
| **Incident Commander** (decision-maker) | `<<CEO_NAME>>` | `<<CEO_PHONE>>` / `<<CEO_EMAIL>>` |
| **Technical Lead** (investigation + containment) | `<<TECH_LEAD_NAME>>` | `<<TECH_LEAD_PHONE>>` / `<<TECH_LEAD_EMAIL>>` |
| **DPO / Privacy contact** (user notification decisions) | `<<DPO_NAME>>` | `<<DPO_EMAIL>>` |
| **Legal counsel** | `<<LEGAL_COUNSEL_NAME>>` | `<<LEGAL_COUNSEL_CONTACT>>` |
| **Backup / on-call** | `<<BACKUP_NAME>>` | `<<BACKUP_CONTACT>>` |

---

## 3. Incident Severity Levels

| Level | Description | Response time | Examples |
|---|---|---|---|
| **P1 — Critical** | User data confirmed or likely exposed; production fully down | Immediate (within 30 minutes of discovery) | Confirmed data breach, ransomware, full service outage |
| **P2 — High** | Partial service degradation; potential data exposure; secret suspected compromised | Within 2 hours | API returning 5xx for >10% of requests, suspected leaked API key, failed login spike |
| **P3 — Medium** | Limited impact; no confirmed data exposure | Within 24 hours | Single-user complaint, minor feature broken, dependency vulnerability (no known exploit) |
| **P4 — Low** | Cosmetic or non-security issues | Next business day | Typo in an error message, slow query, stale cache |

---

## 4. Five-Phase Response

### Phase 1 — Detect and Report

**Anyone** who discovers or suspects an incident must report it immediately to `<<POLICY_OWNER_NAME>>` at `<<POLICY_OWNER_EMAIL>>` or `<<POLICY_OWNER_PHONE>>`.

- Do not investigate on your own before reporting.
- Do not discuss the incident on Slack or email (use a secure channel or phone call for initial triage).
- Preserve evidence: do not delete logs, restart servers, or change configurations before the Technical Lead has seen them.

Detection sources:
- Sentry error alerts (`<<SENTRY_PROJECT_URL>>`)
- Fly.io logs (`flyctl logs --app <<FLY_APP_NAME>>`)
- Audit log anomalies (spike in failed auth, unusual admin actions — `GET /admin/audit-log`)
- GitHub secret scanning alerts
- Staff report
- User complaint

---

### Phase 2 — Assess

The Incident Commander and Technical Lead assess within `<<SEVERITY_ASSESS_MINUTES>>` minutes of the report (recommended: 30 min for P1, 2 hours for P2):

1. What happened? What systems and data are involved?
2. Is it still ongoing?
3. What is the severity level (P1–P4)?
4. Are any users' personal data (especially Highly Confidential data) affected?

File an incident record in `<<INCIDENT_LOG_LOCATION>>` (e.g. a private Google Doc titled "INC-YYYY-MM-DD-<short description>"). The incident record captures: discovery time, discoverer, initial assessment, and every action taken with timestamps.

---

### Phase 3 — Contain

Stop the bleeding:

**If a secret / API key is compromised:**
1. Immediately rotate the affected secret via the Secrets Rotation Runbook (`docs/secrets-rotation-runbook.md` — Phase 10 secrets rotation track).
2. Revoke the old key if the provider supports it.
3. Search the git history for any exposure: `git log -p | grep <<KEY_PREFIX>>`.

**If a user account is compromised:**
1. Revoke the user's session tokens via Supabase Auth admin SDK.
2. Temporarily disable the account if needed.
3. Notify the user.

**If production is under attack (DDoS, scraping, abuse):**
1. Enable Fly.io rate limiting (`flyctl autoscale`).
2. Block offending IPs via Fly.io firewall rules.
3. Consider temporarily putting the service in maintenance mode.

**If data was exfiltrated:**
1. Identify the access vector from audit logs and Fly.io request logs.
2. Revoke the access vector (API key, session, compromised account).
3. Preserve a forensic snapshot (`GET /admin/soc2/evidence-snapshot`) before any system changes.

---

### Phase 4 — Eradicate and Recover

Once the incident is contained:

1. Identify and fix the root cause (e.g. patch the vulnerability, add the missing `@Roles()` decorator, update the dependency).
2. Verify the fix in a non-production environment if time allows.
3. Deploy the fix to production using normal change management (PR + CI), unless the severity demands an emergency deploy (P1).
4. Restore any impacted data from backup if necessary (see Business Continuity Plan).
5. Verify the system is clean and operating normally.

---

### Phase 5 — Notify and Review

**User notification:**
- GDPR requires notifying affected data subjects within 72 hours of becoming aware of a personal data breach that poses a risk to individuals. `<<DPO_EMAIL>>` makes this decision.
- For UK/EU users, GDPR Article 33 also requires notifying the supervisory authority (ICO for UK: https://ico.org.uk/for-organisations/report-a-breach/) within 72 hours.
- Notification must include: what happened, what data was affected, what we did, and what users should do.

**Post-incident review:**
- Within 2 weeks of resolution, the Technical Lead writes a post-incident review.
- Review format: timeline, root cause, what we did well, what we could do better, action items with owners and due dates.
- Review is filed in `<<INCIDENT_LOG_LOCATION>>` alongside the incident record.
- Action items are tracked to completion.

---

## 5. Evidence Preservation

During and after a P1 or P2 incident:

1. Export the evidence snapshot: `GET /admin/soc2/evidence-snapshot` and save the result with timestamp.
2. Download the relevant Fly.io log window: `flyctl logs --app <<FLY_APP_NAME>> --since <time>`.
3. Export the relevant audit log window: `GET /admin/audit-log?since=<time>`.
4. Do not modify or delete any logs or system state until the incident is closed.

---

## 6. Special Scenarios

### 6.1 Production Database Breach

If the Supabase Postgres database is accessed without authorization:

1. Immediately rotate `DATABASE_URL` (includes password rotation in Supabase dashboard).
2. Rotate `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`.
3. Revoke and re-issue all Fly.io secrets.
4. Assess scope: query `AuditLog` for access patterns in the window of the breach.
5. Follow GDPR notification timeline.

### 6.2 GitHub Repository Compromise

If the source control repository is accessed by an unauthorized party:

1. Rotate all secrets that were ever in `.env.example` or committed to code (even briefly).
2. Rotate all secrets referenced in CI/CD workflows.
3. Audit GitHub org membership — remove any unknown accounts immediately.
4. Check for any backdoored code commits.

### 6.3 Secrets Committed to Source Control

If an API key or password is committed to GitHub (even in a private repo):

**Treat it as compromised immediately — even if it was only there for minutes.**

1. Follow the Secrets Leak Runbook at `docs/secrets-rotation-runbook.md` (Phase 10 secrets rotation track).
2. Rotate the key with the provider.
3. Use `git filter-repo` or BFG Repo-Cleaner to scrub the secret from git history.
4. Force-push the cleaned history.
5. Notify GitHub support if GitHub secret scanning already triggered an alert.

---

## 7. Communication Templates

### Internal incident kickoff message (P1/P2)

```
INCIDENT IN PROGRESS — [P1/P2]
What: <one line description>
Discovered: <time>
Systems affected: <list>
Data affected: <list, or "under investigation">
IC: <name>
TL: <name>
Incident doc: <link>
Status channel: <slack channel or bridge link>
```

### External user notification (after DPO approval)

```
Subject: Important security notice regarding your Growth Project account

Dear [name],

We are writing to inform you that on [date], we discovered [plain-English description of what happened].

Data that may have been affected: [list].

We have [actions taken: rotated credentials, patched the vulnerability, etc.].

What you should do: [e.g. change your password, watch for suspicious activity].

We are sorry this happened. If you have questions, contact us at <<DPO_EMAIL>>.

[Signature]
```

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This plan template is original to The Growth Project. Structure informed by NIST SP 800-61r2 (Computer Security Incident Handling Guide, https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-61r2.pdf) and GDPR Articles 33–34 (https://gdpr.eu/article-33-notification-of-a-personal-data-breach/). The secrets-leak runbook reference links to Phase 10 track `feat/phase-10-secrets-rotation`.*
