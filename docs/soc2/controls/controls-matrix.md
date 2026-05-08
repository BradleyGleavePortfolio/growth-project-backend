# SOC 2 Controls Matrix

This matrix maps SOC 2 Trust Services Criteria (TSC) to the concrete technical and procedural controls implemented by The Growth Project. It is structured for auditor review: each row names the criterion, describes what we do to satisfy it, and points to the specific code, config, or policy that provides the evidence.

**Scope:** Security (CC) criteria are all included. Availability (A) and Privacy (P) criteria relevant to our scope are included. Processing Integrity (PI) and Confidentiality (C) criteria will be added before a Type II audit.

**How to read this:** "Implemented" means the control exists and is tested. "Partial" means the control is built but not yet fully documented or tested. "Planned" means we intend to implement before audit.

---

## CC1 — Control Environment

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC1.1 | Entity demonstrates commitment to integrity and ethical values | Implemented | Information Security Policy + Acceptable Use Policy (`docs/soc2/policies/`) signed by leadership |
| CC1.2 | Board / management oversees internal controls | Partial | Bradley (founder) acts as security officer. Formal board oversight to be documented when a board is constituted. |
| CC1.3 | Management establishes organizational structure, reporting lines, and authorities | Implemented | Role matrix in Access Control Policy; GitHub org owner hierarchy |
| CC1.4 | Entity demonstrates commitment to competence | Partial | Annual security training required per Information Security Policy. Training log: `<<TRAINING_LOG_LOCATION>>` |
| CC1.5 | Management enforces accountability for internal controls | Implemented | Audit log captures every privileged action with actor ID and role. `AuditService` in `src/audit/audit.service.ts` |

---

## CC2 — Communication and Information

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC2.1 | Entity uses relevant, quality information | Implemented | Structured JSON logging to Fly.io logs; Sentry for error capture; PostHog for product analytics |
| CC2.2 | Entity communicates internally about security | Implemented | Policies in `docs/soc2/policies/`; incident escalation path in Incident Response Plan |
| CC2.3 | Entity communicates with external parties about security commitments | Partial | Privacy Notice on public site. SOC 2 report to be issued. Breach notification process in Incident Response Plan |

---

## CC3 — Risk Assessment

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC3.1 | Entity defines risk assessment objectives | Partial | Risk objectives defined in Information Security Policy. Formal risk register: `<<RISK_REGISTER_LOCATION>>` (to be created). |
| CC3.2 | Entity identifies and analyzes risks | Partial | Informal risk identification during development. Formal annual risk assessment required before Type I. |
| CC3.3 | Entity considers fraud risk | Implemented | Rate limiting on auth endpoints (Phase 10 rate limiting track, `feat/phase-10-rate-limiting`); referral fraud detection in referral track |
| CC3.4 | Entity identifies and assesses changes that could affect security | Implemented | Change Management Policy; PR security checklist for auth/authz changes |

---

## CC4 — Monitoring Activities

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC4.1 | Entity performs ongoing evaluations of controls | Implemented | CI gates on every PR (`build-and-test`); quarterly access review (runbook `docs/soc2/runbook-quarterly-review.md`) |
| CC4.2 | Entity evaluates and communicates deficiencies | Partial | Sentry alerts go to `<<SENTRY_ALERT_EMAIL>>`. Formal deficiency tracking: `<<DEFICIENCY_LOG_LOCATION>>` (to be created). |

---

## CC5 — Control Activities

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC5.1 | Entity selects and develops controls | Implemented | Controls selected and documented in this matrix |
| CC5.2 | Entity selects and develops general IT controls over technology | Implemented | Branch protection on `main`; CI gates; Prisma migration discipline |
| CC5.3 | Entity deploys policies through procedures | Implemented | Policies in `docs/soc2/policies/`; runbooks in `docs/soc2/runbook-quarterly-review.md` and `docs/` |

---

## CC6 — Logical and Physical Access Controls

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| **CC6.1** | Entity implements logical access security to prevent unauthorized access | **Implemented** | `JwtAuthGuard` + `RolesGuard` in `src/auth/`. Every route is authenticated by default (global `APP_GUARD`). Role-gating meta-test in `src/auth/` (Phase 10 role-gating track, `feat/phase-10-role-gating`) asserts every controller route carries an explicit `@Roles()` decorator. |
| **CC6.2** | Entity uses authentication prior to accessing resources | **Implemented** | Supabase ES256 JWT verified locally via JWKS (`JwksVerifierService` in `src/auth/jwks.service.ts`). No round-trip to Supabase on every request. Tokens expire after `<<JWT_EXPIRY>>` hours. |
| **CC6.3** | Entity authorizes, modifies, and removes access to systems | **Implemented** | Access lifecycle in Access Control Policy. Offboarding checklist. GitHub org managed by owner. `promoteUser` writes `AuditAction.USER_ROLE_CHANGED` to `AuditLog`. |
| CC6.4 | Entity restricts physical access to facilities | Implemented | No company-owned hardware. Cloud providers (Fly.io, Supabase) hold SOC 2 Type II for physical controls. Vendor list in Vendor Management Policy. |
| CC6.5 | Entity disposes of assets securely | Partial | No company hardware to dispose of. Staff devices: full-disk encryption required (Acceptable Use Policy). Cloud data deletion via GDPR scrub endpoint. |
| **CC6.6** | Entity implements logical access to protect against external threats | **Implemented** | Rate limiting on auth and public routes (Phase 10 rate limiting track, `feat/phase-10-rate-limiting`). CORS restricted to known origins (`CORS_ORIGINS` in `src/common/env-validation.ts`). |
| CC6.7 | Entity restricts transmission and movement of information | Implemented | TLS enforced by Fly.io edge. No plaintext health data in logs (see Data Classification Policy). |
| **CC6.8** | Entity implements controls to prevent or detect malware | Partial | `npm audit` run in CI. Dependency review via Dependabot (to be enabled — see `<<DEPENDABOT_CONFIG>>`). Container base image updated regularly. |

---

## CC7 — System Operations

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC7.1 | Entity detects and monitors new vulnerabilities | Partial | `npm audit` quarterly. GitHub Dependabot alerts (to be enabled). |
| **CC7.2** | Entity monitors for security events and anomalies | **Implemented** | Sentry captures all 500-level errors and sends alerts. Audit log captures all privileged actions. Fly.io log streaming for operational events. Observability track (`feat/phase-10-observability`) adds structured metrics. |
| CC7.3 | Entity evaluates security events for incident response | Implemented | Incident Response Plan defines P1–P4 severity classification and evaluation steps |
| CC7.4 | Entity responds to security incidents | Implemented | Incident Response Plan (`docs/soc2/policies/incident-response-plan.md`) |
| CC7.5 | Entity identifies, develops, and implements activities to recover from security incidents | Implemented | Incident Response Plan Phase 4 (Eradicate and Recover); Business Continuity Plan |

---

## CC8 — Change Management

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| **CC8.1** | Entity authorizes, designs, develops, configures, documents, tests, approves, and deploys infrastructure and software to meet objectives | **Implemented** | All code changes go through PR review + CI (`build-and-test` job). `main` branch protection enforces required status checks. Deploy via Fly.io CI/CD on merge. Change Management Policy (`docs/soc2/policies/change-management-policy.md`). |

---

## CC9 — Risk Mitigation

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| CC9.1 | Entity identifies, selects, and develops risk-mitigation activities | Implemented | Rate limiting, role guards, audit logging, GDPR delete, secrets rotation all address identified risks |
| **CC9.2** | Entity assesses and manages risks from vendors and business partners | **Implemented** | Vendor Management Policy (`docs/soc2/policies/vendor-management-policy.md`) with subprocessor table, DPA status, and SOC 2 status for each vendor |

---

## A1 — Availability

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| A1.1 | Entity maintains and monitors infrastructure to meet availability commitments | Implemented | Fly.io multi-region deployment (see Business Continuity Plan). Sentry + Fly.io logs for uptime monitoring. |
| A1.2 | Entity provides data backup and recovery capabilities | Implemented | Supabase PITR backups. Manual weekly backup procedure in Business Continuity Plan. Restore test in Quarterly Review Runbook. |
| A1.3 | Entity designs, develops, and implements BCP/DR procedures | Implemented | Business Continuity Plan (`docs/soc2/policies/business-continuity-plan.md`) |

---

## P — Privacy

| Criterion | Description | Status | Implementation |
|---|---|---|---|
| P1.1 | Entity provides notice about privacy practices | Partial | Privacy Notice exists on public site. Links to `docs/soc2/policies/data-classification-policy.md` classification tiers. |
| P3.1 | Entity collects personal information consistent with its privacy notice | Implemented | Data collected is limited to what is needed for coaching features. Bloodwork is Highly Confidential per Data Classification Policy. |
| P4.1 | Entity limits use of personal information to stated purposes | Implemented | Health/biometric data is never passed to third-party LLMs or analytics without de-identification. See Data Classification Policy Section 5. |
| **P6.1** | Entity provides individuals with access to their personal information | **Implemented** | DSAR endpoint (Phase 10 data export track, `feat/phase-10-data-export`): `POST /users/me/data-export`. Returns full data bundle for the authenticated user. |
| **P6.6** | Entity destroys personal information based on policies | **Implemented** | `GdprScrubService` (`src/users/gdpr-scrub.service.ts`) performs 30-day soft-delete then hard-purge. `AuditAction.USER_ACCOUNT_DELETED` emitted. Phase 10 GDPR delete track (`feat/phase-10-gdpr-delete`). |
| P8.1 | Entity monitors compliance with privacy commitments | Partial | GDPR deletion requests logged. Privacy audit via quarterly review runbook. Formal privacy audit before Type I. |

---

## Controls Not Yet Implemented (Pre-Audit Backlog)

| Control area | Gap | Action required |
|---|---|---|
| CC3.2 — Formal risk register | No documented risk register | Create and maintain risk register at `<<RISK_REGISTER_LOCATION>>` |
| CC4.2 — Deficiency log | No formal tracking | Create deficiency log at `<<DEFICIENCY_LOG_LOCATION>>` |
| CC6.8 — Dependabot | Not enabled | Add `.github/dependabot.yml` to enable automated dependency updates |
| CC7.1 — Vulnerability scanning | Manual `npm audit` only | Enable Dependabot + consider OWASP ZAP scan before audit |
| P1.1 — Privacy Notice | Not linked to classification tiers | Update public Privacy Notice to reference data categories |
| P8.1 — Privacy audit | Not yet performed | Add privacy audit step to Quarterly Review Runbook |

---

*Cross-references: AICPA Trust Services Criteria 2017 (https://www.aicpa.org/resources/landing/system-and-organization-controls-soc-suite-of-services). Control implementation references code on `feat/phase-10-*` branches pending merge to `main`.*
