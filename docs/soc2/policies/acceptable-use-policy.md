# Acceptable Use Policy

> **Before signing this policy, complete every item in the checklist below.**

## Pre-Signing Checklist

- [ ] Replace every `<<PLACEHOLDER>>` with real values.
- [ ] Have all current staff and contractors read this policy.
- [ ] Collect signed acknowledgements (email or DocuSign receipt is sufficient).
- [ ] Store the signed copy in the company Google Drive alongside the Information Security Policy.
- [ ] Set a calendar reminder to review this policy annually.

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

This policy sets the rules for using `<<COMPANY_NAME>>` systems — laptops, accounts, production infrastructure, and any tool we pay for. Following these rules protects our users, protects the business, and keeps us compliant with the security commitments we make to enterprise customers.

**Plain English:** Don't use company tools for anything you wouldn't be comfortable explaining to a customer or a regulator. If you're unsure, ask first.

---

## 2. Scope

This policy applies to:

- All employees, contractors, advisors, and any other person granted access to `<<COMPANY_NAME>>` systems.
- All company-issued and personal devices used to access company systems.
- All accounts: GitHub, Fly.io, Supabase, Stripe, Sentry, PostHog, Slack, Google Workspace, and any other tool in the company's stack.

---

## 3. Permitted Uses

You may use company systems to:

- Perform your job responsibilities.
- Access systems, data, or code that you have been explicitly granted access to.
- Learn skills directly relevant to your role (e.g. reading technical documentation, online courses).
- Reasonable personal use that does not interfere with work or consume significant resources.

---

## 4. Prohibited Uses

You must not use company systems to:

### 4.1 Unauthorized Access
- Access any system, account, database, or data you have not been explicitly granted access to.
- Use another person's credentials, even if they offer them to you.
- Attempt to bypass authentication, rate limits, or role guards.
- Access production databases directly (Supabase Postgres) without an approved support ticket or incident resolution.

### 4.2 Data Handling
- Copy, download, or export Highly Confidential data (bloodwork, body composition, health metrics) outside of approved, encrypted workflows.
- Share any user's personal data (name, email, health data) via email, Slack, or any unencrypted channel.
- Use production data in development or testing environments. Use anonymized or synthetic data instead.

### 4.3 Code and Secrets
- Commit API keys, passwords, or secrets to source control. All secrets belong in Fly.io secrets or an approved secrets manager.
- Deploy code to production without a passing CI run and at least one peer review (see Change Management Policy).
- Disable or bypass security controls (guards, rate limits, audit logging) without written approval from `<<POLICY_OWNER_NAME>>`.

### 4.4 Communication
- Use company systems to send spam, phishing, or any unsolicited commercial communication.
- Represent yourself as `<<COMPANY_NAME>>` without authorization.
- Share confidential company information (unreleased features, financial data, customer lists) with unauthorized parties.

### 4.5 General
- Use company systems for illegal activities.
- Install unauthorized software on company devices.
- Use company resources for mining cryptocurrency, operating personal web services, or any other personal commercial activity.

---

## 5. Device Security

All devices used to access company systems must:

- Use full-disk encryption (FileVault on macOS, BitLocker on Windows, LUKS on Linux).
- Auto-lock after no more than 5 minutes of inactivity.
- Have automatic OS and security updates enabled.
- Run up-to-date antivirus/endpoint protection if on Windows.

---

## 6. Password and Authentication Rules

- Passwords must be at least 16 characters. Use a password manager (`<<RECOMMENDED_PASSWORD_MANAGER>>`, e.g. 1Password or Bitwarden).
- Multi-factor authentication (MFA) is required on every account that supports it — especially GitHub, Fly.io, Supabase, Stripe, and Google Workspace.
- Do not reuse passwords across services.
- Do not store passwords in plaintext (notes apps, spreadsheets, code comments).

---

## 7. Incident Reporting

If you suspect an account is compromised, a device is lost or stolen, or you accidentally committed a secret to source control:

1. Report it to `<<POLICY_OWNER_NAME>>` at `<<POLICY_OWNER_EMAIL>>` immediately — do not wait.
2. Follow the steps in the [Incident Response Plan](incident-response-plan.md).
3. Do not attempt to investigate or remediate on your own unless instructed to do so.

**Reporting a potential incident is always the right call. There is no penalty for good-faith reports.**

---

## 8. Monitoring

`<<COMPANY_NAME>>` logs actions taken on production systems (audit log, Fly.io logs, GitHub audit log). These logs may be reviewed in the event of an incident or audit. You should have no expectation of privacy when using company systems to access production infrastructure.

---

## 9. Enforcement

Violations of this policy may result in:

- Revocation of system access.
- Disciplinary action, up to and including termination.
- Legal action if the violation caused harm to users or the business.

---

## 10. Acknowledgement

By signing / acknowledging below, you confirm you have read, understood, and agree to follow this policy.

| Name | Role | Acknowledgement method | Date |
|---|---|---|---|
| (add rows for each staff member) | | | |

---

*This policy template is original to The Growth Project. Structure informed by SANS Institute Acceptable Use Policy template (https://www.sans.org/information-security-policy/) and NIST SP 800-53 AC family controls.*
