# Data Classification Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Confirm the data inventory in Section 4 matches what the system actually stores (cross-check against `prisma/schema.prisma`).
- [ ] Confirm retention periods align with your Privacy Notice.
- [ ] Confirm bloodwork / health data handling procedures are implemented in code before signing.
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

This policy defines how `The Growth Project, LLC` classifies the data it holds, and the handling requirements for each classification level. It ensures that the most sensitive data — particularly health and biometric data belonging to athletes and coaching clients — receives the strongest protections.

**Plain English:** Not all data needs the same level of protection. A public blog post is different from someone's blood test results. This policy defines four tiers and tells everyone how to handle each one.

---

## 2. Classification Tiers

### Tier 1 — Public

Data that is intended to be publicly accessible. Unauthorized disclosure causes no harm.

**Examples:** Marketing copy, public pricing, the privacy notice, the terms of service, the public invite landing pages, anonymized aggregate statistics published in marketing materials.

**Handling requirements:**
- No special restrictions on storage or transmission.
- Still subject to integrity controls (don't let someone edit your public pages without authorization).

---

### Tier 2 — Internal

Data intended only for internal use. Unauthorized disclosure could be embarrassing or give competitors an advantage, but would not directly harm users.

**Examples:** Internal metrics dashboards, business performance numbers, engineering architecture documents, employee names and job titles, non-sensitive internal communications.

**Handling requirements:**
- Store on company systems only (Google Drive, GitHub private repos, Supabase).
- Do not share outside the company without explicit approval.
- Use access controls to limit to current staff (no public links).
- TLS in transit.

---

### Tier 3 — Confidential

Data about identifiable people or business operations that, if disclosed, could harm users, create legal liability, or damage business relationships.

**Examples:** User email addresses, user names, coach billing information, client list (which coach a user is connected to), platform subscription data, check-in content (mood, notes), meal log content, workout logs, coach analytics.

**Handling requirements:**
- Encrypted in transit (TLS 1.2+) and at rest (Supabase AES-256 encryption).
- Access limited to staff and systems with a documented business need.
- Access is role-gated in the application (minimum `coach` role to access coach data; users can only access their own).
- Audit log entry written for any bulk export or unusual access pattern.
- Do not include in error messages, application logs, or Slack messages.
- Retention: retained for the duration of the user relationship plus `<<CONFIDENTIAL_RETENTION_YEARS>>` years (recommended: 3). Deleted on GDPR / CCPA deletion request via `GdprScrubService`.

---

### Tier 4 — Highly Confidential

The most sensitive data we hold. This is data whose unauthorized disclosure could directly harm a person's health, safety, or financial wellbeing, or that carries the highest legal and regulatory risk.

**Examples:**
- **Bloodwork results** — any lab panel imported or manually entered (e.g. testosterone, HbA1c, lipid panel).
- **Body composition metrics** — body fat percentage, visceral fat, DEXA scan data.
- **Biometric data** — weight history, height, medical conditions noted in a check-in.
- **Sleep and HRV data** — where personally identifiable (linked to a user's account).
- Any data that qualifies as "special category" data under GDPR (Article 9), i.e. health data, genetic data, biometric data.

**Handling requirements:**
- Encrypted in transit (TLS 1.2+) and at rest (Supabase AES-256).
- Access limited to the minimum role required. In the application:
  - A `student` can only read their own Highly Confidential data.
  - A `coach` can read the Highly Confidential data of their direct clients only, and only with the client's explicit consent (`consent` table in Prisma schema).
  - An `owner` can access for audit / support purposes only — access is logged.
- **Never** included in:
  - Application logs (structured or unstructured)
  - Error messages (e.g. Sentry breadcrumbs must not include raw health values)
  - Slack messages, emails, or any unencrypted channel
  - Development or test environments (use synthetic/anonymized data)
- Bulk exports of Highly Confidential data require written approval from `<<POLICY_OWNER_NAME>>`.
- Data subject access requests (DSARs) for Highly Confidential data are fulfilled only to the data subject themselves, after identity verification.
- Retention: retained for the duration of the user relationship plus `<<HIGHLY_CONFIDENTIAL_RETENTION_YEARS>>` years (recommended: 7, to cover medical record retention norms). Hard-deleted on deletion request — no soft-delete for this tier.
- De-identification: if used for any analytical purpose, bloodwork and biometric data must be de-identified (all PII removed, quasi-identifiers generalized) before use.

---

## 3. Classification in Practice

### How to classify a new piece of data

1. Does it identify a person? → At least Tier 3.
2. Is it health, biometric, or genetic data? → Tier 4 (Highly Confidential).
3. Is it internal business data with no personal info? → Tier 2.
4. Is it meant to be public? → Tier 1.

When in doubt, classify higher and ask `<<POLICY_OWNER_NAME>>` for a formal decision.

### Who is responsible for classification

The engineer who designs the feature is responsible for classifying new data when it is first defined in the Prisma schema. Classification should appear as a comment on the model field, e.g.:

```prisma
// Classification: Highly Confidential — bloodwork result
testosterone_ng_dl Float?
```

---

## 4. Data Inventory

This is the authoritative list of data types held by `The Growth Project, LLC`, their classification, and their Prisma model location. Update this table whenever a new model or field is added.

| Data type | Classification | Prisma model | Notes |
|---|---|---|---|
| User email | Confidential | `User.email` | Supabase Auth source of truth |
| User full name | Confidential | `User.name` | |
| User role | Internal | `User.role` | |
| Coach profile | Confidential | `CoachProfile` | |
| Coach subscription | Confidential | `CoachSubscription` | Stripe-linked |
| Client–coach relationship | Confidential | `CoachProfile` ↔ `User.coach_id` | |
| Check-in content (notes, mood) | Confidential | `CheckIn` | |
| Weight log | Highly Confidential | `WeightLog` | Body composition data |
| Body fat % | Highly Confidential | `CheckIn.body_fat_pct` (if present) | Biometric |
| Bloodwork results | Highly Confidential | `<<BLOODWORK_MODEL>>` | Lab data; GDPR Article 9 |
| Sleep / HRV data | Highly Confidential | `SleepLog`, `HrvLog` | From wearable integrations |
| Meal logs | Confidential | `FoodLog` | |
| Workout logs | Confidential | `WorkoutLog` | |
| Audit log | Internal | `AuditLog` | Contains actor IPs and emails |
| Stripe invoice data | Confidential | `Invoice` | |
| GDPR deletion requests | Internal | `DeletionRequest` | |

---

## 5. Third-Party Data Sharing

Highly Confidential data is **never** shared with third parties except:

- With the data subject's explicit, informed, revocable consent.
- With a healthcare provider acting under HIPAA Business Associate Agreement (if applicable).
- As required by law (e.g. court order), in which case legal counsel must be consulted first.

All third-party data processors are listed in the [Vendor Management Policy](vendor-management-policy.md).

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This policy template is original to The Growth Project. Classification tiers adapted from NIST SP 800-60 (https://csrc.nist.gov/publications/detail/sp/800-60/vol-1-rev-1/final) and GDPR Article 9 special category definitions (https://gdpr.eu/article-9-processing-special-categories-of-personal-data-prohibited/). Health data retention guidance draws on NHS Records Management Code of Practice 2021 (https://transform.england.nhs.uk/information-governance/guidance/records-management-code/) as a reference minimum.*
