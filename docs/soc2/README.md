# SOC 2 Compliance — The Growth Project

> **Plain-English entry point.** This folder is where Bradley (and eventually an auditor) comes to understand the compliance posture of The Growth Project backend. Everything here is designed to be readable by a non-technical founder — if a paragraph feels confusing, it needs to be rewritten.

---

## What is SOC 2?

SOC 2 (System and Organization Controls, level 2) is a security audit framework run by a licensed CPA firm. It answers one question for enterprise customers: *"Can I trust this company with sensitive data?"*

An auditor reviews your technical controls, your written policies, and your evidence of following those policies — then issues a report. Two flavors exist:

| | Type I | Type II |
|---|---|---|
| **What it checks** | Do the right controls *exist* on a single day? | Did the controls *actually work* continuously over 6–12 months? |
| **Typical cost** | $15k–$30k | $30k–$80k |
| **Useful for** | "We're serious about security" signal | Enterprise contracts, procurement questionnaires |
| **When to pursue** | When first enterprise prospects ask for it | 6–12 months after Type I, when you have an evidence trail |

The five "Trust Services Criteria" (TSC) that auditors evaluate:

1. **Security (CC)** — access controls, encryption, monitoring. *Required for every SOC 2 report.*
2. **Availability (A)** — uptime, disaster recovery.
3. **Processing Integrity (PI)** — data is processed correctly, completely, on time.
4. **Confidentiality (C)** — sensitive data is protected.
5. **Privacy (P)** — personal information is handled per your stated privacy notice.

The Growth Project is scoping to **Security + Availability + Privacy** for an initial Type I. Processing Integrity and full Confidentiality criteria can be layered in before a Type II.

---

## Where We Are on the Journey

```
Stage 1 — Controls exist (technical)    ← WE ARE HERE
Stage 2 — Policies written              ← THIS FOLDER DELIVERS THIS
Stage 3 — Evidence trail started        ← Q3 / Q4 2025 target
Stage 4 — Pre-audit readiness review    ← ~3 months before audit
Stage 5 — Type I audit                  ← Target: when first enterprise deal is imminent
Stage 6 — Type II observation period    ← 6–12 months continuous evidence
Stage 7 — Type II report issued         ← Year 2
```

---

## Technical Controls Already In Place

The following Phase 10 tracks implement concrete controls referenced throughout the policy documents. Links point to their feature branches until they are merged to `main`.

| Control area | Implementation | Phase 10 track / PR |
|---|---|---|
| Role-based access control | `JwtAuthGuard` + `RolesGuard` + `@Roles()` decorator; `owner > coach > student` hierarchy | Phase 10 — Role Gating (`feat/phase-10-role-gating`) |
| Audit logging | `AuditService` + `AuditLog` Prisma model; every privileged action writes an immutable row | Phase 10 — Audit Logging (`feat/phase-10-audit-logging`) |
| Secrets management | Secrets stored as Fly.io secrets; rotation runbook in `docs/secrets-rotation-runbook.md` | Phase 10 — Secrets Rotation (`feat/phase-10-secrets-rotation`) |
| Observability & alerting | Sentry for errors, PostHog for analytics, structured JSON logging to Fly logs | Phase 10 — Observability (`feat/phase-10-observability`) |
| Rate limiting | NestJS `ThrottlerModule`; per-IP limits on auth + public routes | Phase 10 — Rate Limiting (`feat/phase-10-rate-limiting`) |
| GDPR / data deletion | `GdprScrubService`; 30-day soft-delete then hard-purge; `AuditAction.USER_ACCOUNT_DELETED` emitted | Phase 10 — GDPR Delete (`feat/phase-10-gdpr-delete`) |
| Data export | `UserDataExportService`; DSAR (Data Subject Access Request) endpoint for users to pull their data | Phase 10 — Data Export (`feat/phase-10-data-export`) |
| Multi-region availability | Fly.io multi-region app config; DB backup cadence in `business-continuity-plan.md` | Phase 10 — BCP |
| Evidence snapshot | `GET /admin/soc2/evidence-snapshot` endpoint (this PR) | This PR |

---

## Pre-Audit Checklist

Work through this list before booking an auditor. Items marked ✅ are done; items marked ⬜ need action.

### Policies
- ⬜ Every policy in `docs/soc2/policies/` has been reviewed, placeholders filled, and signed (wet or DocuSign).
- ⬜ Policies are version-controlled (they already are — this repo is the source of truth).
- ⬜ All employees / contractors have read and acknowledged each policy (use a Google Form or DocuSign receipt).

### Technical controls
- ⬜ Role-gating hardening track merged and CI green.
- ⬜ Audit logging track merged; audit log queryable via `GET /admin/audit-log`.
- ⬜ Secrets rotation runbook executed at least once; rotation date documented.
- ⬜ Vulnerability scanning: run `npm audit --audit-level=high` and resolve highs.
- ⬜ Dependency pinning: `package-lock.json` committed and reproducible.
- ⬜ MFA enabled for: Supabase project owner, Fly.io account, GitHub org, Stripe, Sentry.
- ⬜ No production secrets in code (verify with `git log -p | grep -i secret`).

### Evidence
- ⬜ First quarterly review (see `runbook-quarterly-review.md`) completed and result filed.
- ⬜ `GET /admin/soc2/evidence-snapshot` exported and stored in a read-only location (e.g. S3 bucket with versioning).
- ⬜ Penetration test or automated DAST scan run (OWASP ZAP, Burp Suite free tier, or third-party).
- ⬜ Vendor / subprocessor list reviewed and signed (see `policies/vendor-management-policy.md`).

### Business
- ⬜ Privacy Notice on public site updated to match `data-classification-policy.md` retention periods.
- ⬜ DPA (Data Processing Agreement) template ready for enterprise customers.
- ⬜ Incident response plan rehearsed at least once (tabletop exercise).

---

## Expected Timeline

| Milestone | Target |
|---|---|
| All policies signed | Q3 2025 |
| First quarterly review completed | Q3 2025 |
| Evidence trail: 3 months of audit logs + snapshots | Q4 2025 |
| Type I readiness review (internal) | Q4 2025 |
| Type I audit booked | Q1 2026 |
| Type I report issued | Q2 2026 |

---

## Document Index

| File | Purpose |
|---|---|
| `policies/information-security-policy.md` | Master security posture statement |
| `policies/acceptable-use-policy.md` | Rules for staff using company systems |
| `policies/access-control-policy.md` | How access is granted, reviewed, revoked |
| `policies/data-classification-policy.md` | Data tiers from Public to Highly Confidential |
| `policies/incident-response-plan.md` | How we respond to security events |
| `policies/business-continuity-plan.md` | How we keep the service running after disruption |
| `policies/vendor-management-policy.md` | How we vet and track third-party processors |
| `policies/change-management-policy.md` | How code changes are reviewed and deployed |
| `controls/controls-matrix.md` | SOC 2 TSC criteria mapped to technical controls |
| `controls/evidence-collection.md` | How to collect audit evidence for each control |
| `runbook-quarterly-review.md` | What to do every quarter to maintain the evidence trail |

---

*Adapted in structure from Vanta's open-source SOC 2 readiness guidance (https://www.vanta.com/resources/soc-2-checklist) and the AICPA Trust Services Criteria (https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services). All policy content is original to The Growth Project.*
