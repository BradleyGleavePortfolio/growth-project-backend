# Handoff brief: #43 Application Funnel

**Spec:** [`docs/specs/commerce/application-funnel.md`](../../../specs/commerce/application-funnel.md).

## WHY

High-ticket offers ($500+ to $30k) require qualification: the coach can't sell to everyone, the customer-fit affects deliverable quality, and compliance for medical-adjacent / financial-coaching offers requires pre-screen attestations.

Today coaches piece this together with Typeform → Calendly → Notion CRM → Stripe link. Six tools, three apps, the same fields entered three times, conversions lost at every transition. No single source of truth for "what state is this prospect in" or "which setter closed them".

This spec is **the** TGP system of record for the prospect-to-customer pipeline. PR #122 §3's qualification state machine (`INTERESTED → APPLIED → SCREENED → APPROVED → DEPOSIT_PAID → CONFIRMED`) is the runtime backing.

## WHEN

- Spec accepted.
- [`offer-builder.md`](../../../specs/commerce/offer-builder.md) S1 (so `Offer.requires_application` + `Offer.application_form_id` exist).
- PR #121 #26 (intake-questionnaire) §6-reconciliation accepted (form-question vocabulary unified).
- PR #118 Team Mode at "first runtime PR opened" so setter attribution column is in place.
- §20 OQs closed (auto-decline policy, AI-scoring opt-in).

## WHERE

- New sub-module `src/commerce/applications/`.
- New tables: `ApplicationForm`, `ApplicationFormQuestion`, `Application`, `ApplicationAnswer`, `ApplicationDecision`, `ApplicationCallSlot` (S2).
- New routes: `/api/v1/coach/applications/*`, `/api/v1/application-form/:slug` (public), `/api/v1/owner/applications/*`.
- Public SSR at `/c/:slug/apply/:offer_slug`.

## WHO

- Sign-off: founder, backend lead, PR #121 #26 spec author (form vocabulary).
- Pager: backend lead.

## WHAT

**State machine:** `RECEIVED → SCREENED → APPROVED|DECLINED|EXPIRED|WITHDRAWN`.

**Approval emits a one-time signed checkout token** bound to `(application_id, offer_id, prospect_email)`. Token resolves at `/api/v1/checkout/sessions` and auto-fills the prospect identity. Default 7-day expiry.

**Setter attribution** flows through `attributed_setter_user_id` and the affiliate spec's `shared_by_affiliate_id`. Both columns reserved at submit.

**Non-goals:** not a CRM (no pipeline stages); no in-house Calendly in S1 (redirect to coach's existing); no autonomous AI decisions (S2 scoring is advisory only).

## HOW

S0 spec → S1 (form CRUD + state machine + manual approve/decline + checkout-token) → S2 (CallSlot, AI scoring stub, setter UI) → S3 GA. Smallest first PR: `ApplicationForm` + `ApplicationFormQuestion` + four CRUD endpoints, ≤450 LOC.

## Risk + dependency highlights

- PII data leak — strict tenancy, 90-day decline TTL, RTBE coverage, setter-only-visibility default.
- Coach over-collection — high-sensitivity question gate at publish.
- Spam / burst — captcha + per-IP throttle + per-coach burst cap.
- AI scoring drift / bias — advisory only; PR #120 lane #08 governance + per-form opt-in.

## Operator handoff

`APPLICATION_FUNNEL_ENABLED`, `APPLICATION_AI_SCORING_ENABLED` flags. Per-form `status='paused'`. Runbook `docs/commerce/application-funnel-runbook.md`. Spam-rate, decline-rate, AI-scoring-failure dashboards. Privacy-purge throughput dashboard for declined-app TTL.
