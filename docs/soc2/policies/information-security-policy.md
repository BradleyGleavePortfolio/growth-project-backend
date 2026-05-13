# Information Security Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Have a lawyer or compliance advisor review the policy.
- [ ] Ensure all staff listed in the Scope section have read this document.
- [ ] Store the signed copy in a durable, version-controlled location (this repo + a PDF in the company Google Drive).
- [ ] Set a calendar reminder to review this policy annually.

---

## Policy Details

| Field | Value |
|---|---|
| **Company name** | `The Growth Project, LLC` (e.g. "The Growth Project Ltd.") |
| **Effective date** | `<<EFFECTIVE_DATE>>` |
| **Policy owner** | `<<POLICY_OWNER_NAME>>`, `<<POLICY_OWNER_TITLE>>` |
| **DPO / Privacy contact** | `<<DPO_EMAIL>>` |
| **Next review date** | `<<NEXT_REVIEW_DATE>>` (set to 12 months from effective date) |
| **Version** | 1.0 |

---

## 1. Purpose

This policy explains how `The Growth Project, LLC` protects the information entrusted to us — by our clients (coaches), their end-users (athletes / students), and our business partners. It sets the minimum security standard for everyone who works at or with `The Growth Project, LLC`.

**Plain English:** This is the document that says "here is how we keep data safe and who is responsible for what." If something bad happens, this is the first place an auditor will look to understand what we promised to do.

---

## 2. Scope

This policy covers:

- All systems operated by `The Growth Project, LLC`, including the Growth Project backend API, the mobile app, the coach console, and all third-party services listed in the Vendor Management Policy.
- All employees, contractors, advisors, and any other person who has access to `The Growth Project, LLC` systems or data.
- All data we hold about users, coaches, and business operations — regardless of where it is stored (Supabase Postgres, Fly.io, Stripe, etc.).

---

## 3. Information Security Objectives

`The Growth Project, LLC` commits to:

1. **Confidentiality** — Keeping user data private. Only people who need it for their job can see it.
2. **Integrity** — Making sure data is accurate and has not been changed without authorization.
3. **Availability** — Keeping the service running so coaches and users can access their data when they need it.
4. **Privacy** — Handling personal data in line with our Privacy Notice and applicable laws (GDPR, CCPA).

---

## 4. Roles and Responsibilities

| Role | Responsibilities |
|---|---|
| **`<<CEO_OR_FOUNDER_TITLE>>`** (`<<CEO_NAME>>`) | Ultimate accountable owner of this policy. Signs off on exceptions and major changes. |
| **`<<POLICY_OWNER_TITLE>>`** (`<<POLICY_OWNER_NAME>>`) | Day-to-day policy steward. Updates, trains staff, tracks compliance. |
| **Engineering** | Implements technical controls. Reports vulnerabilities. Follows change management policy. |
| **All staff / contractors** | Read and follow this policy. Report suspected incidents immediately. |

---

## 5. Access Control

- Access to production systems is limited to the minimum needed to do the job ("least privilege").
- All production access is controlled by role: `owner`, `coach`, or `student`. Details in the [Access Control Policy](access-control-policy.md).
- Multi-factor authentication (MFA) is **required** for all accounts that can access production infrastructure: Supabase, Fly.io, GitHub, Stripe, Sentry.
- Contractors are given the minimum access required for their engagement. Access is revoked within 24 hours of contract end.
- The access list is reviewed quarterly. See the [Quarterly Review Runbook](../runbook-quarterly-review.md).

---

## 6. Data Classification

All data handled by `The Growth Project, LLC` is classified into one of four tiers. Full definitions are in the [Data Classification Policy](data-classification-policy.md). The short version:

| Tier | Examples | Handling |
|---|---|---|
| **Public** | Marketing copy, public pricing | No restrictions |
| **Internal** | Internal metrics, aggregate stats | Internal access only |
| **Confidential** | User email addresses, coach business data | Encrypted in transit and at rest; access logged |
| **Highly Confidential** | Bloodwork, body composition, health metrics | Encrypted, role-gated, audit logged; never in logs or error messages |

---

## 7. Encryption

- All data in transit uses TLS 1.2 or higher. Fly.io handles this at the edge.
- All data at rest is encrypted by Supabase Postgres (AES-256) and Fly.io volume encryption.
- API keys and secrets are stored as Fly.io secrets (encrypted at rest) — never in code or `.env` files committed to source control.

---

## 8. Vulnerability Management

- Dependencies are reviewed for known vulnerabilities at least quarterly using `npm audit`.
- Critical or high-severity findings are resolved within `<<VULN_SLA_CRITICAL_DAYS>>` days (recommended: 7) and high within `<<VULN_SLA_HIGH_DAYS>>` days (recommended: 30).
- Security patches for the operating system / container base image are applied within 30 days of release.

---

## 9. Incident Response

If a security incident occurs (data breach, unauthorized access, service outage caused by an attack), we follow the [Incident Response Plan](incident-response-plan.md). Key commitments:

- Incidents are reported to `<<DPO_EMAIL>>` within 24 hours of discovery.
- Affected users are notified within 72 hours if their personal data was exposed (GDPR requirement).
- A post-incident review is completed within 2 weeks.

---

## 10. Physical Security

`The Growth Project, LLC` operates as a remote-first company. Servers run on Fly.io (no physical hardware owned by us). Physical security controls:

- No company-owned servers. Cloud provider (Fly.io) is responsible for physical access controls to data center hardware.
- Staff devices must use full-disk encryption (FileVault on macOS, BitLocker on Windows).
- Staff devices must lock after 5 minutes of inactivity.
- Lost or stolen devices must be reported to `<<POLICY_OWNER_NAME>>` within 4 hours. Remote wipe is initiated immediately.

---

## 11. Business Continuity

We aim for `<<UPTIME_TARGET>>` uptime (recommended: 99.5%). Our disaster recovery targets and backup procedures are in the [Business Continuity Plan](business-continuity-plan.md).

---

## 12. Training

- All new staff / contractors complete a security onboarding session within their first 2 weeks. Topics: this policy, acceptable use, password management, phishing awareness.
- Annual security awareness training is required for all staff.
- Training completion is logged in `<<TRAINING_LOG_LOCATION>>` (e.g. Google Drive folder).

---

## 13. Policy Exceptions

Any exception to this policy requires written approval from the `<<CEO_OR_FOUNDER_TITLE>>`. Exceptions are time-limited (maximum 90 days) and logged in `<<EXCEPTION_LOG_LOCATION>>`.

---

## 14. Enforcement

Violations of this policy may result in disciplinary action, up to and including termination of employment or contract.

---

## 15. Review and Update

This policy is reviewed annually or after any significant security incident. Changes require approval from the `<<CEO_OR_FOUNDER_TITLE>>`.

---

## Signatures

By signing below, you confirm that you have read, understood, and agree to comply with this policy.

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This policy template is original to The Growth Project. Structure adapted from AICPA Trust Services Criteria CC1.1–CC1.5 (https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services) and NIST SP 800-53 (https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final).*
