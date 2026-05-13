# Vendor Management Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Verify the subprocessor table (Section 4) against current active services.
- [ ] Confirm each critical vendor has a Data Processing Agreement (DPA) in place or signed.
- [ ] Check that each vendor's current SOC 2 / ISO 27001 status matches what is listed.
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

`The Growth Project, LLC` relies on third-party services to deliver the Growth Project platform. Some of these services process personal data on our behalf — they are called "data processors" or "subprocessors." This policy defines how we select, assess, and monitor those vendors so that a failure at a vendor does not become a failure of our users' trust.

**Plain English:** We use other companies' software to run our product. This document tracks which ones, what data they can see, and whether they have security certifications we can rely on.

---

## 2. Scope

This policy covers:

- Any third-party service or tool used by `The Growth Project, LLC` that processes, stores, or has access to user personal data (Confidential or Highly Confidential per our Data Classification Policy).
- Infrastructure providers, SaaS tools, analytics platforms, and communication tools.

It does NOT cover tools used for purely internal purposes where no user personal data flows (e.g. a design tool with no user data imported).

---

## 3. Vendor Assessment Criteria

Before adopting a new vendor that will process user personal data, assess it on:

| Criterion | What to check |
|---|---|
| **Security posture** | SOC 2 Type II report, ISO 27001 cert, or equivalent. Ask for the report or check their trust/security page. |
| **DPA availability** | Does the vendor offer a Data Processing Agreement? GDPR requires one for any EU data. |
| **Data residency** | Where is data stored? Does it leave the EU/UK if we have EU/UK users? |
| **Breach history** | Check Have I Been Pwned, vendor security bulletins, public news. |
| **Data deletion** | Can we delete user data from the vendor on request? How long is data retained? |
| **Uptime / reliability** | Does the vendor have a public status page? What is their SLA? |

For vendors that will process Highly Confidential data (health, biometric data), require:
- SOC 2 Type II or HIPAA Business Associate Agreement (BAA).
- Written DPA.
- Confirmation that data is encrypted at rest and in transit.

---

## 4. Subprocessor Table

This is the canonical list of vendors that process personal data on behalf of `The Growth Project, LLC`. Update this table whenever a new vendor is added or an existing one is removed.

| Vendor | Category | Data processed | Data location | DPA in place | SOC 2 / cert | Purpose |
|---|---|---|---|---|---|---|
| **Supabase** | Database & Auth | All user data (Confidential + Highly Confidential) | `<<SUPABASE_REGION>>` | Yes — [Supabase DPA](https://supabase.com/legal/dpa) | SOC 2 Type II | Postgres database, authentication, JWKS |
| **Fly.io** | Hosting / compute | Application memory only (no persistent user data beyond what Supabase holds) | `<<FLY_REGIONS>>` | Yes — [Fly.io DPA](https://fly.io/legal/privacy-policy/) | SOC 2 Type II | Application runtime, TLS termination |
| **Stripe** | Payments | Coach billing data, payment methods | USA | Yes — [Stripe DPA](https://stripe.com/legal/dpa) | SOC 2 Type II, PCI DSS Level 1 | Coach SaaS billing |
| **Sentry** | Error monitoring | Error metadata, stack traces (may contain user IDs — no health data) | USA (or EU if Sentry EU used) | Yes — [Sentry DPA](https://sentry.io/legal/dpa/) | SOC 2 Type II | Server error reporting |
| **PostHog** | Product analytics | Event data (user IDs, feature usage) | `<<POSTHOG_REGION>>` | Yes — [PostHog DPA](https://posthog.com/dpa) | SOC 2 Type II | Product analytics |
| **Expo / EAS** | Mobile build | Mobile app binary (no user data) | USA | — | — | iOS/Android build service |
| **Apple App Store** | Distribution | App binary, crash reports | USA | Covered by Apple Developer Agreement | ISO 27001 | iOS app distribution |
| **Google Play Store** | Distribution | App binary, crash reports | USA | Covered by Google Developer Agreement | ISO 27001 | Android app distribution |
| **`<<EMAIL_PROVIDER>>`** | Transactional email | User email address, email content | `<<EMAIL_PROVIDER_REGION>>` | `<<EMAIL_DPA_STATUS>>` | `<<EMAIL_CERT>>` | Transactional notifications |
| **`<<PUSH_PROVIDER>>`** | Push notifications | Device push tokens, notification content | `<<PUSH_PROVIDER_REGION>>` | `<<PUSH_DPA_STATUS>>` | `<<PUSH_CERT>>` | Mobile push notifications |

> **Note on AI features:** If the Coach AI or Client Bot features use an external LLM provider (e.g. Perplexity, OpenAI), add that provider to this table. Confirm that no Highly Confidential data (bloodwork, biometric data) is included in prompts sent to the LLM. See `src/ai/ai.service.ts` for prompt construction.

---

## 5. Adding a New Vendor

1. Complete the vendor assessment (Section 3).
2. Get a DPA signed or confirmed where user personal data flows.
3. Add the vendor to the subprocessor table (Section 4) in this document.
4. If the new vendor will process Highly Confidential data, get written approval from `<<CEO_NAME>>` before onboarding.
5. If `The Growth Project, LLC` has a public Privacy Notice that lists subprocessors (some GDPR models require this), update it.

---

## 6. Vendor Offboarding

When a vendor is removed:

1. Delete all `The Growth Project, LLC` user data from the vendor (use their data deletion / export tools).
2. Revoke all API keys and credentials for the vendor.
3. Remove the vendor from the subprocessor table.
4. Update the Privacy Notice if it lists subprocessors.
5. Log the removal in `<<VENDOR_LOG_LOCATION>>`.

---

## 7. Annual Vendor Review

Once per year (and before any SOC 2 audit), review this table:

1. Confirm each vendor is still in use.
2. Check whether each vendor's SOC 2 report is current (most expire annually).
3. Check each vendor's security incident history for the past year.
4. Confirm DPAs are still valid.

The Quarterly Review Runbook (`docs/soc2/runbook-quarterly-review.md`) includes a vendor review step.

---

## Signatures

| Name | Title | Signature | Date |
|---|---|---|---|
| `<<CEO_NAME>>` | `<<CEO_OR_FOUNDER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |
| `<<POLICY_OWNER_NAME>>` | `<<POLICY_OWNER_TITLE>>` | __________________ | `<<EFFECTIVE_DATE>>` |

---

*This policy template is original to The Growth Project. Structure informed by AICPA TSC CC9.2 (vendor management) and GDPR Article 28 (processor obligations, https://gdpr.eu/article-28-processor/). Subprocessor links verified as of 2025-05-07; re-verify each annually as DPA URLs and terms change.*
