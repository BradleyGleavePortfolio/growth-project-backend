# Spec: Application Funnel

> **Status:** Draft — docs only. Roadmap row #43. No runtime, schema, env-var, or module-wiring change in this PR.
>
> Read [`payments-checkout.md`](./payments-checkout.md), [`coach-storefronts.md`](./coach-storefronts.md), and [`offer-builder.md`](./offer-builder.md) first.

## 1. Cross-references

- **PR #118** Team Mode — setter attribution lives entirely in this lane via `acted_by_member_user_id` on each application + decision row.
- **PR #120** lanes #01 (entitlements), #03 (RBAC + tenancy), #04 (data lifecycle — applications carry sensitive PII), #06 (observability), #08 (AI governance — application scoring).
- **PR #121** spec #26 (intake-questionnaire) — **closely adjacent.** Intake is post-purchase (a paid client fills it after onboarding). Application is pre-purchase (a prospect fills it to qualify before checkout). §6 reconciles.
- **PR #122** masterminds — §3 application + qualification funnel: states `INTERESTED → APPLIED → SCREENED → APPROVED → DEPOSIT_PAID → CONFIRMED`. This spec is the runtime backing.
- **PR #123** coach-experience wave #36 (messaging) — once approved, the prospect is auto-linked to a coach DM thread.

## 2. WHY

High-ticket offers ($500+ to $30k) **always** require qualification. Reasons:

1. **Coach time is finite.** A sales call costs the coach 30–60 minutes. The funnel must filter out non-fits before the call.
2. **Customer fit is part of the deliverable.** A mismatched client is more likely to refund, chargeback, or churn — coach earnings drop, TGP take-rate revenue drops, support cost spikes.
3. **Compliance.** Some offers (medical-adjacent fitness, finance coaching with quasi-investment-advisor framing) require pre-screen attestations to limit liability.
4. **Setter attribution.** A coach with a sales team needs the application/decision/closer pipeline tracked for revenue-share.

Today coaches use Typeform → Calendly → custom Notion CRM → Stripe link. The funnel is six tools and three apps duplicating the same fields. Conversion drops at every transition. There is no single record of "what state is this prospect in" or "which setter closed them".

This spec is **the** TGP system of record for the prospect-to-customer pipeline that gates `Offer.requires_application=true` checkouts.

### What "shipped" unlocks

- A coach builds an application form in TGP once.
- Storefront page renders the form inline (no Typeform).
- Approval transitions the prospect to a checkout link automatically; deposits via the payment plan / deposit-balance flow specced in [`offer-builder.md`](./offer-builder.md) §8.
- Coach (or setter) sees an applications inbox with state machine, deny/approve, schedule a sales call.
- Setter attribution is automatic: who shared the link, who screened, who approved, who closed. Revenue share splits accordingly.

## 3. WHEN

1. ✅ This spec is reviewed and accepted by founder + backend lead.
2. ✅ [`offer-builder.md`](./offer-builder.md) at S1 — `Offer.requires_application=true` + `Offer.application_form_id` columns exist.
3. ✅ PR #121 spec #26 (intake) §6-reconciliation accepted (form schema family unified — see §6 below).
4. ✅ PR #118 Team Mode at "first runtime PR opened" — setter attribution column present.
5. ✅ Open questions §20 closed (auto-decline policy, application data retention).

## 4. WHERE

- **New module:** `src/commerce/applications/`.
- **New tables:** `ApplicationForm`, `ApplicationFormQuestion`, `Application`, `ApplicationAnswer`, `ApplicationDecision`, `ApplicationCallSlot` (S2). 
- **Touches existing:** `Offer` (FK source), `User`, `CoachProfile`. Read-only on `src/messaging/` (post-approval thread). Read-only on PR #121 #26 `IntakeQuestionnaireTemplate` (shared form-question vocabulary).
- **New routes:** `/api/v1/coach/applications/*`, `/api/v1/application-form/:slug` (public), `/api/v1/coach/applications/:id/decisions`, `/api/v1/owner/applications/*`.
- **Public pages:** `/c/:slug/apply/:offer_slug` (SSR application form, hosted by storefront module).

## 5. WHO

| Role             | Responsibility                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Sign-off         | Founder, backend lead, PR #121 #26 spec author (form-question vocabulary).                                 |
| On the hook      | Backend lead. Frontend specialist for inline form embed.                                                    |
| Downstream       | [`offer-builder.md`](./offer-builder.md) (`requires_application` gate), affiliate (setter attribution), masterminds. |
| Hard boundaries  | Does **not** own intake post-purchase (PR #121 #26 owns), does **not** own messaging (PR #123 #36 owns).    |

## 6. WHAT — relationship to PR #121 spec #26 (intake-questionnaire)

Two surfaces, one form-question vocabulary, two distinct workflows:

|                       | PR #121 #26 intake-questionnaire                  | This spec — application                          |
| --------------------- | ------------------------------------------------- | ------------------------------------------------ |
| When filled           | Post-purchase, after onboarding                   | Pre-purchase, prospect / lead                    |
| Identity              | Authenticated client                              | Anonymous → captures email/name to register     |
| Fields                | Goals, intake medical, equipment, history         | Qualifying questions: budget, timeline, fit     |
| Outcome               | Profile populated; coach reviews                  | Approved → checkout link; declined → polite no  |
| Tenancy axis          | client + coach                                    | prospect-by-email + coach                        |
| State machine         | None (one-shot)                                   | Multi-state with decisions, calls, deposits     |

**Reconciliation:** the **question-and-answer schema** is shared. Both surfaces use `FormQuestionKind` enum and the per-kind validator from PR #121 #26. The intake-questionnaire owns the enum and the validator. This spec consumes them.

The **forms themselves** are separate models (`ApplicationForm` vs. `IntakeQuestionnaireTemplate`) because the workflows differ; collapsing into one table would force every `IntakeQuestionnaireTemplate` to also carry application-funnel columns it does not need, and vice versa.

### 6.1 Already exists

- `User`, `CoachProfile`, `src/messaging/` (post-approval DM thread).
- PR #121 #26 form-question vocabulary (post merge of #121).

### 6.2 Net-new

- The six tables in §8.
- Application state machine.
- Setter attribution chain.
- Optional AI-scoring stub (S2 only; off by default; PR #120 lane #08 governance applies).

### 6.3 Non-goals

- **No CRM** — we are not building Pipedrive. The applications inbox is a triage UI, not a sales-stage tracker.
- **No phone-call scheduling system in S1** — `ApplicationCallSlot` is sketched for S2; S1 surfaces a coach's existing Calendly URL as a redirect after approval.
- **No automated AI-decisions in S1.** AI scoring (S2) is advisory, never auto-decline. PR #120 lane #08 forbids autonomous high-stakes decisions.

## 7. HOW — phases

- **S0 spec.** Accepted.
- **S1 skeleton.** `ApplicationForm`, `ApplicationFormQuestion`, `Application`, `ApplicationAnswer`, `ApplicationDecision`. State machine: `RECEIVED → SCREENED → APPROVED|DECLINED`. Coach inbox + manual approve/decline. Approval emits a checkout link. `APPLICATION_FUNNEL_ENABLED=false`.
- **S2 private beta.** Add `ApplicationCallSlot` + Calendly redirect, setter attribution UI, optional AI scoring (advisory).
- **S3 GA.** Flag-on for entitled coaches.

### 7.1 Smallest first runtime PR

PR-1: `ApplicationForm` + `ApplicationFormQuestion` + four endpoints (create, get, update, list). No application-row submission yet. Tests for question validator. Flag default off. ≤450 LOC.

### 7.2 Kill-switch

`APPLICATION_FUNNEL_ENABLED=false`: public application submission returns 503; existing applications still readable + decidable by coach.

## 8. Data model sketch (additive, **not** committed)

```prisma
model ApplicationForm {
  id                       String                     @id @default(cuid())
  coach_user_id            String                     // FK → User.id
  slug                     String                     // unique within coach
  title                    String
  description_md           String?                    @db.Text
  status                   ApplicationFormStatus      @default(DRAFT)
  // Behaviour
  auto_decline_after_days  Int?                       // null = manual only
  redirect_after_submit_url String?                   // for affiliate landing flows
  approval_redirect_kind   ApprovalRedirectKind       @default(CHECKOUT)
  approval_redirect_url    String?                    // when kind=EXTERNAL_URL (e.g. Calendly)
  // Forward-compat
  acted_by_member_user_id  String?
  created_at               DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  archived_at              DateTime?
  coach                    User                       @relation(fields: [coach_user_id], references: [id], onDelete: Cascade)
  questions                ApplicationFormQuestion[]
  applications             Application[]
  @@unique([coach_user_id, slug])
}

enum ApplicationFormStatus {
  DRAFT
  ACTIVE
  PAUSED
  ARCHIVED
}

enum ApprovalRedirectKind {
  CHECKOUT          // S1 default — emit a one-time checkout token for the linked Offer
  EXTERNAL_URL      // S1 — coach's Calendly etc.
  CALL_SLOT         // S2 — internal call scheduler
}

model ApplicationFormQuestion {
  id                       String                     @id @default(cuid())
  form_id                  String
  // Drawn from PR #121 #26 vocabulary; this column is the integration point
  kind                     String                     // FormQuestionKind enum value
  prompt                   String                     @db.Text
  required                 Boolean                    @default(true)
  // Per-kind config (e.g. select options)
  config                   Json
  position                 Int
  // S2 — used by AI scoring stub
  scoring_weight           Int                        @default(0)
  form                     ApplicationForm            @relation(fields: [form_id], references: [id], onDelete: Cascade)
  @@unique([form_id, position])
}

model Application {
  id                       String                     @id @default(cuid())
  form_id                  String
  offer_id                 String?                    // FK → Offer.id (which offer this app is FOR)
  coach_user_id            String                     // denormalised for tenancy guard

  // Prospect identity
  prospect_user_id         String?                    // FK → User.id (if registered)
  prospect_email           String                     // normalised lowercase
  prospect_name            String?
  prospect_phone           String?
  prospect_country         String?

  // Attribution
  source_kind              ApplicationSourceKind      @default(STOREFRONT)
  source_ref               String?                    // affiliate.code, storefront.slug, etc.
  utm_source               String?
  utm_medium               String?
  utm_campaign             String?
  // Setter attribution (PR #118 hook + affiliate spec)
  attributed_setter_user_id String?
  shared_by_affiliate_id   String?                   // FK → Affiliate.id (#44 spec)

  // State
  state                    ApplicationState           @default(RECEIVED)
  declined_reason          ApplicationDeclineReason?
  declined_external_note   String?                    @db.Text
  approved_at              DateTime?
  declined_at              DateTime?
  withdrawn_at             DateTime?
  expired_at               DateTime?

  // S2 AI scoring
  ai_score                 Float?                     // 0..1; advisory only
  ai_score_rationale       String?                    @db.Text
  ai_score_template_version String?                   // PR #117 prompt version

  // Privacy
  data_retention_until     DateTime                   // populated on submit per §12

  // Forward-compat
  acted_by_member_user_id  String?

  submitted_at             DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  form                     ApplicationForm            @relation(fields: [form_id], references: [id], onDelete: Cascade)
  coach                    User                       @relation(fields: [coach_user_id], references: [id])
  answers                  ApplicationAnswer[]
  decisions                ApplicationDecision[]
  call_slot                ApplicationCallSlot?
  @@index([coach_user_id, state, submitted_at])
  @@index([prospect_email])
}

enum ApplicationState {
  RECEIVED
  SCREENED            // a setter has triaged
  APPROVED
  DECLINED
  WITHDRAWN
  EXPIRED             // auto via auto_decline_after_days
}

enum ApplicationSourceKind {
  STOREFRONT
  AFFILIATE_LINK
  DIRECT_URL
  IMPORT              // operator import for a coach's prior list
}

enum ApplicationDeclineReason {
  NOT_A_FIT
  FINANCIAL
  TIMING
  COMPLIANCE
  DUPLICATE
  ABUSE
  OTHER
}

model ApplicationAnswer {
  id                       String                     @id @default(cuid())
  application_id           String
  question_id              String                     // FK → ApplicationFormQuestion.id
  // Free-text or JSON value depending on FormQuestionKind
  answer                   Json
  application              Application                @relation(fields: [application_id], references: [id], onDelete: Cascade)
  @@unique([application_id, question_id])
}

model ApplicationDecision {
  id                       String                     @id @default(cuid())
  application_id           String
  decided_by_user_id       String                     // FK → User.id (coach or setter)
  decision                 DecisionKind
  internal_note            String?                    @db.Text
  external_note            String?                    @db.Text
  occurred_at              DateTime                   @default(now())
  application              Application                @relation(fields: [application_id], references: [id], onDelete: Cascade)
  @@index([application_id, occurred_at])
}

enum DecisionKind {
  SCREENED_OK
  SCREENED_NEEDS_INFO
  APPROVED
  DECLINED
  REOPENED
}

// S2 — internal call scheduler (Calendly-style)
model ApplicationCallSlot {
  id                       String                     @id @default(cuid())
  application_id           String                     @unique
  scheduled_for            DateTime
  duration_minutes         Int                        @default(30)
  attended                 Boolean?
  application              Application                @relation(fields: [application_id], references: [id], onDelete: Cascade)
}
```

### 8.1 Retention

| Table                       | Retention                                | GDPR scrub                                                                                |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ApplicationForm`           | Lifetime of coach                        | Title may contain PII; pseudonymise on RTBE.                                              |
| `ApplicationFormQuestion`   | Lifetime of form                         | Prompt may contain PII; pseudonymise on RTBE.                                             |
| `Application`               | **90 days** for declined/expired by default; **lifetime + 7y** for approved (tax) | Configurable via `data_retention_until`; declined PII purged on schedule unless OWNER hold. |
| `ApplicationAnswer`         | Mirrors parent `Application`             | Hard-delete on parent purge.                                                              |
| `ApplicationDecision`       | Mirrors parent                           | Drop notes if PII; keep decision kind for audit.                                          |
| `ApplicationCallSlot`       | Mirrors parent                           | None.                                                                                     |

The 90-day declined-application TTL is the per-table entry the data-lifecycle matrix in PR #120 lane #04 reserved.

## 9. API sketch + payment routing

### 9.1 Coach-facing — form CRUD

```
POST   /api/v1/coach/application-forms                      → create draft
GET    /api/v1/coach/application-forms                      → list
GET    /api/v1/coach/application-forms/:id                  → full form + questions
PATCH  /api/v1/coach/application-forms/:id                  → update (rejects protected fields if ACTIVE)
POST   /api/v1/coach/application-forms/:id/questions        → add question
PATCH  /api/v1/coach/application-forms/:id/questions/:qid   → update
DELETE /api/v1/coach/application-forms/:id/questions/:qid   → remove (rejects if active applications exist)
POST   /api/v1/coach/application-forms/:id/publish          → DRAFT → ACTIVE
POST   /api/v1/coach/application-forms/:id/pause            → ACTIVE → PAUSED
```

### 9.2 Coach-facing — applications inbox

```
GET    /api/v1/coach/applications                            → filter by state, form, since
GET    /api/v1/coach/applications/:id                        → full app + answers + decisions
POST   /api/v1/coach/applications/:id/decisions              → body { decision, internal_note?, external_note? }
POST   /api/v1/coach/applications/:id/withdraw               → coach-side abandon (rare)
GET    /api/v1/coach/applications/:id/checkout-link          → mints one-time signed URL on APPROVED
```

Throttle: 60/min/coach (read), 12/min/coach (write decisions). RBAC: `team.applications.review` (PR #118 matrix).

Setter visibility: a `SETTER` role (PR #118) can see only applications where `attributed_setter_user_id == self`, unless coach grants the role broader visibility (open question PR #118 §10 OQ-3).

### 9.3 Public — submit

```
GET   /api/v1/application-form/:coach_slug/:form_slug         → form schema for SSR/inline
POST  /api/v1/application-form/:coach_slug/:form_slug/submit  → body { email, name, answers, utm, source_ref }
GET   /api/v1/application/:token                              → prospect can view their own application status (token in submit response)
```

Captcha: required by default.

Throttle: 5 submissions / 10 min / IP / form. Email-domain blocklist applies. Duplicate detection: same `prospect_email` to same `form_id` within 24h returns the existing `Application.id` rather than creating a duplicate (the prospect is told their application is already received).

### 9.4 Operator

```
GET   /api/v1/owner/applications                            → cross-coach search
POST  /api/v1/owner/applications/:id/redact                  → drop free-text PII (compliance request)
GET   /api/v1/owner/applications/export                      → ledger-style CSV
```

### 9.5 Approval → checkout flow

On `decision=APPROVED`:

1. `Application.state` → `APPROVED`. Audit row written.
2. If `ApplicationForm.approval_redirect_kind=CHECKOUT`, mint a one-time signed checkout token bound to `(application_id, offer_id, prospect_email)`. The token expires in 7 days (configurable per form).
3. The token resolves at `/api/v1/checkout/sessions` ([`payments-checkout.md`](./payments-checkout.md) §9.3) which auto-fills the prospect identity. The checkout uses the `Offer` row's payment routing.
4. Email + (S2) DM the prospect with the checkout URL.
5. If the prospect never converts, after 30 days the application moves to `EXPIRED` state and the checkout token is revoked. Audit row.

## 10. Tax, refund, chargeback, dispute

Not directly relevant — applications do not move money. Indirect relevance: an `Application.id` is recorded on the resulting `Charge.metadata` field for reverse-attribution; refunds tied to "this client was a bad fit despite our screen" feed back into the coach's screening review.

## 11. Ledger and reconciliation

Applications themselves do not touch the ledger. The downstream `Charge` (when the prospect converts) is the ledger event. `ApplicationDecision` is **the** evidence row used in setter revenue-share computation: who hit `APPROVED` is who gets the share. If multiple decisions exist (rare), the latest `APPROVED` wins.

## 12. RBAC, privacy, GDPR scrub

- Tenant: `coach_user_id` everywhere. Row-level guard.
- Public submit is unauthenticated; we trust the captcha + throttle.
- Application data is **highly sensitive PII** (income, health, financial). RTBE drops free-text answers and pseudonymises name/email. The decline-applications 90-day TTL keeps cohort sizes small.
- Setter visibility: per PR #118 matrix; `team.applications.review_own` vs. `team.applications.review_all`.
- Coach RTBE cascades.

### 12.1 Audit log additions

```
APPLICATION_FORM_PUBLISHED
APPLICATION_FORM_PAUSED
APPLICATION_RECEIVED
APPLICATION_SCREENED
APPLICATION_APPROVED
APPLICATION_DECLINED
APPLICATION_WITHDRAWN
APPLICATION_EXPIRED
APPLICATION_REDACTED                // operator privacy
APPLICATION_AI_SCORED               // S2
APPLICATION_CHECKOUT_TOKEN_MINTED
APPLICATION_CHECKOUT_TOKEN_REVOKED
```

## 13. Abuse, fraud, moderation

- **Spam.** Captcha + 5-per-10-min/IP throttle + email-domain blocklist (disposable). Repeat-offender IPs blocked at the edge.
- **PII over-collection.** Form publish blocks if a question kind is in the "high-sensitivity" list (SSN, full DOB, financial account numbers) without explicit "I have a documented reason" attestation by coach. Logged.
- **Coach abuse.** Review queue triggers: form has > 50 questions; `auto_decline_after_days` < 1; question prompt regex hits hate-speech / harassment patterns.
- **Setter / closer abuse.** Setter cannot self-approve their own applications (impossible by definition; included as a sanity rule when assignment is staff→staff).
- **Anti-burst.** A new coach (Connect age < 14d) is capped at 50 applications/day. Floor lifts on operator approval.

## 14. Feature flags + entitlements

| Flag                              | Default | Effect                                                                       |
| --------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `APPLICATION_FUNNEL_ENABLED`      | `false` | Public submit 503; coach inbox + decisions still work for existing rows.     |
| `APPLICATION_AI_SCORING_ENABLED`  | `false` | Skip AI scoring; advisory column stays null.                                 |
| `APPLICATION_CALL_SLOT_ENABLED`   | `false` | S2 — block create of `CallSlot`; existing rows render in coach UI.           |

Entitlements:

- `applications.basic` — single form, manual decisions, checkout redirect. L1.
- `applications.advanced` — multiple forms, setter attribution, AI scoring. L2.

## 15. Tests

### 15.1 Unit

- `application.state-machine.spec.ts` — every legal transition covered; illegal transitions rejected.
- `application.form-validator.spec.ts` — per-kind config schema enforced; `protected_fields` change rejected on ACTIVE.
- `application.checkout-token.spec.ts` — minted token bound to email/app/offer; expiry honoured; revoke is permanent.
- `application.dedupe.spec.ts` — duplicate within 24h returns existing row.

### 15.2 Integration

- Public submit → coach inbox row → coach approves → token mint → checkout success → `Charge.metadata.application_id` populated.
- Decline → 90-day TTL → privacy job hard-deletes free-text after window.
- Setter attribution: setter shares affiliate link → application created with `attributed_setter_user_id` → setter sees only their apps.
- AI scoring stub (S2): scoring is advisory; never auto-decides.

### 15.3 Smoke

- Per-coach test form on staging; smoke submit nightly; alarm on dropped pipeline.

## 16. Risks

| Risk                                          | Mitigation                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| PII data leak                                 | Strict tenancy, 90-day decline TTL, RTBE coverage, setter-only visibility default.    |
| Coach over-collection                         | High-sensitivity question gate (§13).                                                 |
| Spam/burst submissions                        | Captcha + IP throttle + per-coach burst cap (§13).                                    |
| Lost checkout token (prospect doesn't convert) | 30-day expiry; coach can re-mint via inbox; expiry transitions to EXPIRED.            |
| AI scoring drift / bias                       | Advisory only; never auto-decline; PR #120 lane #08 governance + per-form opt-in.     |
| Dedupe rule false-positive                    | 24h window, same-email same-form only; coach can re-open via inbox.                   |
| Setter attribution race                       | First share wins; recorded at submit time; cannot be retroactively re-attributed.     |
| Form schema drift after applications submitted | Adding/removing questions on ACTIVE form blocked; pause + duplicate to a new form is the path. |

## 17. Dependencies

- **Internal:** [`offer-builder.md`](./offer-builder.md) (`requires_application` + `application_form_id`), [`payments-checkout.md`](./payments-checkout.md) (checkout sessions), PR #121 #26 (form-question vocabulary), PR #118 (setter role), [`affiliate-referral.md`](./affiliate-referral.md) (attribution chain).
- **External:** hCaptcha (existing). Email send (existing transactional pipeline). Calendly (S1 fallback redirect, no integration code).
- **Human:** Founder closes §20 OQs.

## 18. Acceptance criteria

1. Coach can build a 5-question form, publish, link from storefront, and receive a submission in <2 min on happy path.
2. Public submit completes in <800ms p95.
3. Approval mints a checkout token; checkout success carries `application_id` on `Charge`.
4. 90-day TTL purges declined free-text PII (cron job verified in staging across two consecutive runs).
5. Setter sees only their attributed apps when role is `team.applications.review_own`.
6. AI scoring is advisory; never auto-transitions an application's state (S2).
7. PR #118 forward-compat columns present.
8. PR #120 lanes #03 (RBAC) + #04 (lifecycle) + #08 (AI governance, S2) green.
9. Operator runbook merged.

## 19. Operator handoff

- **Kill-switches:** flags above; per-form `status='paused'`.
- **Dashboards:** Grafana — application submit rate, p95 submit latency, decline rate, expired rate. PostHog — application funnel by `OfferKind`. Privacy dashboard — declined-PII purge throughput.
- **Runbook:** `docs/commerce/application-funnel-runbook.md` — abuse triage, setter-attribution disputes, PII redact request, AI scoring incident.
- **Alerts:** spam rate > 5% over 10 min; 0 decisions/coach with > 100 received apps for > 7 days (likely UX regression); AI scoring failure rate > 5%.

## 20. Open questions

- **OQ-1** Default auto-decline window. Bias: 30 days. **Owner: founder.**
- **OQ-2** AI-scoring opt-in vs. opt-out. Bias: opt-in per form. **Owner: founder + PR #120 lane #08.**
- **OQ-3** Setter visibility default (`review_own` vs. `review_all`). Mirrors PR #118 §10 OQ-3. **Owner: founder.**
- **OQ-4** Whether application export to CSV is coach-self-serve or OWNER-mediated. Bias: coach-self-serve, throttled. **Owner: backend lead.**
