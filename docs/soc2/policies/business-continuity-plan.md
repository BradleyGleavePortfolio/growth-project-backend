# Business Continuity Plan

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Verify the RTO and RPO targets are achievable with the current infrastructure.
- [ ] Confirm Fly.io multi-region is configured (or note the target date for it).
- [ ] Confirm Supabase backup cadence and test that restores work.
- [ ] Store signed copy in company Google Drive.
- [ ] Set annual review reminder and schedule a test failover exercise.

---

## Policy Details

| Field | Value |
|---|---|
| **Company name** | `The Growth Project, LLC` |
| **Effective date** | `<<EFFECTIVE_DATE>>` |
| **Policy owner** | `<<POLICY_OWNER_NAME>>`, `<<POLICY_OWNER_TITLE>>` |
| **Next review date** | `<<NEXT_REVIEW_DATE>>` |
| **Version** | 1.0 |

---

## 1. Purpose

This plan ensures `The Growth Project, LLC` can continue to serve coaches and athletes if a significant technical failure or external event disrupts the service. It defines our recovery targets, our backup strategy, and the step-by-step actions to take when things go wrong.

**Plain English:** This document answers "what happens if the app goes down, the database gets corrupted, or Fly.io has a region outage — and how fast can we recover?"

---

## 2. Recovery Targets

| Metric | Definition | Target |
|---|---|---|
| **RTO** (Recovery Time Objective) | Maximum time from incident to service restored | `<<RTO_HOURS>>` hours (recommended: 4) |
| **RPO** (Recovery Point Objective) | Maximum data loss (age of the last usable backup) | `<<RPO_HOURS>>` hours (recommended: 1) |
| **Uptime target** | Percentage of time the API is reachable | `<<UPTIME_TARGET>>` (recommended: 99.5% = ~44 hours downtime/year) |

These targets are aspirational until a Type I audit. They become contractual only when included in customer agreements.

---

## 3. Infrastructure Overview

The Growth Project backend runs on:

| Component | Provider | Region | Notes |
|---|---|---|---|
| Application servers | Fly.io | `<<PRIMARY_REGION>>` (e.g. `iad`) | NestJS + Docker |
| Database | Supabase Postgres | `<<DB_REGION>>` | Managed Postgres; Supabase handles physical replication |
| CDN / edge | Fly.io anycast | Global | TLS termination, routing |
| Object storage | `<<OBJECT_STORAGE_PROVIDER>>` | `<<OBJECT_STORAGE_REGION>>` | Data exports, asset uploads (if any) |
| DNS | `<<DNS_PROVIDER>>` | Global | |

---

## 4. Multi-Region Strategy

### Current state

The app is currently deployed to the primary region `<<PRIMARY_REGION>>`. A single-region deployment means a Fly.io regional outage takes the service down until Fly recovers or we manually fail over.

### Target state (to achieve before Type II audit)

Deploy the app to a second Fly.io region (`<<SECONDARY_REGION>>`, e.g. `lhr` for Europe). Fly.io's Anycast routing will direct users to the nearest healthy region automatically.

**Steps to enable multi-region:**
1. Add `[[services]]` section in `fly.toml` with the secondary region.
2. Run `flyctl regions add <<SECONDARY_REGION>>`.
3. Verify the secondary region starts successfully: `flyctl status`.
4. Test a regional failover by temporarily pausing the primary region.

Note: Supabase Postgres is a single-region managed service. Read replicas can be added for read traffic, but writes always go to the primary. This means a full Supabase regional failure has a different mitigation path (see Section 6.2).

---

## 5. Database Backup Strategy

### Supabase automated backups

Supabase provides point-in-time recovery (PITR) on Pro and Enterprise plans. Status for our account:

| Plan | PITR enabled | Backup retention | Daily backup |
|---|---|---|---|
| `<<SUPABASE_PLAN>>` | `<<PITR_ENABLED>>` | `<<BACKUP_RETENTION_DAYS>>` days | Yes |

- Check current PITR status: Supabase dashboard → Settings → Database → Backups.
- **Action:** If not on Pro or Enterprise, upgrade before pursuing Type I audit. PITR is the evidence an auditor wants to see for RPO compliance.

### Manual backup cadence

In addition to Supabase automated backups, perform a manual export weekly:

```bash
# Run from a secure machine with DATABASE_URL set
pg_dump "$DATABASE_URL" --no-password -F c -f "backup_$(date +%Y%m%d).dump"
# Upload to <<BACKUP_STORAGE_LOCATION>> with versioning enabled
```

Manual backup location: `<<BACKUP_STORAGE_LOCATION>>` (e.g. S3 bucket `The Growth Project, LLC-db-backups` with versioning enabled and lifecycle policy to expire after 90 days).

### Backup test cadence

A database restore must be tested at least quarterly:

1. Download the most recent backup from `<<BACKUP_STORAGE_LOCATION>>`.
2. Restore into a temporary Postgres instance.
3. Run `npx prisma validate` and a basic query against the restored DB.
4. Document the result in the Quarterly Review (`docs/soc2/runbook-quarterly-review.md`).

---

## 6. Failure Scenarios and Response

### 6.1 Application Server Outage (Fly.io)

**Symptoms:** API returning 5xx or unreachable. Sentry alerts firing.

**Response:**
1. Check Fly.io status: https://status.fly.io
2. Check app status: `flyctl status --app <<FLY_APP_NAME>>`
3. Check logs for the crash cause: `flyctl logs --app <<FLY_APP_NAME>>`
4. If a bad deploy: `flyctl releases list --app <<FLY_APP_NAME>>` → `flyctl deploy --image <previous_image>`
5. If infrastructure issue: monitor Fly.io status; scale up if capacity issue (`flyctl scale count 3 --app <<FLY_APP_NAME>>`)
6. Communicate status to users if downtime exceeds 15 minutes (via status page or email to coach administrators).

**Expected recovery time:** 15–60 minutes.

---

### 6.2 Database Outage (Supabase)

**Symptoms:** API returning 500 on any data-dependent endpoint. `DATABASE_URL` connection errors in logs.

**Response:**
1. Check Supabase status: https://status.supabase.com
2. If a Supabase regional outage: wait for Supabase to recover (managed infrastructure — no user action available beyond putting the app in read-only or maintenance mode).
3. If a data corruption event: initiate PITR restore from Supabase dashboard.
4. Test restored database with a basic query before switching traffic back.
5. Document data loss window (time from last known-good state to outage) for RPO tracking.

**Expected recovery time:** 1–4 hours for PITR restore.

---

### 6.3 Secret / Credential Compromise

Handled by the Incident Response Plan (Section 6.3 — Secrets Committed) and the Secrets Rotation Runbook (`docs/secrets-rotation-runbook.md`).

---

### 6.4 DNS / Domain Outage

**Response:**
1. Check DNS propagation: `dig <<API_DOMAIN>>`.
2. If TTL-related: reduce TTL to 60s before making changes.
3. If registrar outage: contact `<<DNS_PROVIDER>>` support.
4. If domain hijack suspected: invoke Incident Response Plan immediately.

---

### 6.5 Third-Party Service Degradation (Stripe, Supabase Auth, PostHog, Sentry)

The app is designed to degrade gracefully:

- **Stripe webhooks unavailable:** Billing event processing is delayed but no data is lost (Stripe retries for 72 hours).
- **Supabase Auth / JWKS unavailable:** `JwksVerifierService` caches the JWK set for `<<JWKS_CACHE_TTL>>` (default: 1 hour). No new logins possible during outage; existing valid JWTs continue to work until expiry.
- **Sentry / PostHog unavailable:** Both no-op — errors are logged to Fly.io stdout but no alerting.

---

## 7. Communication Plan

| Audience | Channel | When |
|---|---|---|
| Internal team | Slack `#incidents` + phone bridge | Immediately on P1/P2 |
| Coaches (paying users) | Email from `<<SUPPORT_EMAIL>>` | If downtime exceeds 30 minutes |
| Public status page | `<<STATUS_PAGE_URL>>` (e.g. statuspage.io) | For any P1 incident |

---

## 8. Plan Testing

This plan is tested at least once per year via a tabletop exercise:

- Tabletop: team walks through a simulated scenario (e.g. "Supabase is down, what do we do?") without actually taking systems offline.
- Live test: at least once before a Type II audit, perform an actual failover test in a maintenance window.

Test results are documented in the Quarterly Review Runbook.

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This plan template is original to The Growth Project. Structure informed by AICPA TSC Availability criteria (A1.1–A1.3) and NIST SP 800-34r1 Contingency Planning Guide (https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-34r1.pdf). Fly.io multi-region documentation: https://fly.io/docs/reference/regions/.*
