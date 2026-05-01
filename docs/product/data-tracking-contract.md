# Data tracking contract

Status: **draft, docs-only**. Companion to [`README.md`](./README.md) and
to [`../metrics.md`](../metrics.md). This spec is the contract that
ties every Wave 2 product event to the existing PostHog +
`AuditLog` plumbing without inventing a third analytics system.

The contract is **append-only with respect to the existing
taxonomy**: every event listed here is a new entry on
`src/analytics/events.ts`; no existing event is renamed, retyped, or
removed.

---

## 1. Why a contract

The Wave 2 specs add about a hundred new event surfaces across
sub-coach hierarchy, progression, onboarding, and AI surfaces.
Without a single contract, every spec lists its own events and the
runtime author ends up reconciling four overlapping vocabularies at
review time. With a contract:

- The runtime author has one canonical list to seed
  `src/analytics/events.ts`.
- The admin Product usage screen
  (`docs/admin/control-room-spec.md` §9) has one place to read the
  event taxonomy.
- The compliance reviewer has one place to verify the no-PII-in-
  properties invariant.

This file is the contract. The four event sources (`sub-coach-
hierarchy.md`, `retention-progression-system.md`, `onboarding-
clients.md`, `onboarding-coaches.md`) refer to events by name; this
file is the source of truth for the names, properties, distinct
ids, and audit pairings.

---

## 2. Inheritance from the existing stack

The contract preserves every invariant in [`../metrics.md`](../metrics.md):

- **PostHog distinct id is always our internal opaque user id.** The
  single exception is `invite_previewed` (anonymous public preview
  lookups) which uses `code:<GP-XXXXXX>` — Wave 2 does not change
  that exception and does not add a new one.
- **PII deny-list is enforced at the dispatch layer.**
  `AnalyticsService.capture()` strips email, name, phone, address,
  password, and a small list of related keys before sending to
  PostHog. Every Wave 2 event listed below passes the deny-list as
  written; the contract is verified by the existing
  PostHog dispatch test in `test/analytics/`.
- **`AuditLog` is the authoritative record for state changes.**
  PostHog is the funnel and cohort tool; `AuditLog` is the forensic
  record. Every state-changing event in Wave 2 has both a PostHog
  event and an `AuditLog` row. The two are paired in the table in
  §3 below.
- **`POSTHOG_KEY` unset = silent no-op.** The runtime never throws
  on missing PostHog config; instrumentation calls are safe to ship
  unconditionally per [`../metrics.md`](../metrics.md).

---

## 3. The Wave 2 event registry

The table below is the canonical list. Each row is one PostHog
event. Properties are listed in the order
`AnalyticsService.capture()` should serialize. `Audit pair` is the
`AuditAction` constant fired in the same flow (or `—` when the
event is read-only).

### 3.1 Sub-coach hierarchy events (per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §14)

| Event | Distinct id | Properties | Audit pair |
|---|---|---|---|
| `org_created` | owner user id | `archetype`, `billing_flow` | `org.created` |
| `org_archetype_changed` | owner user id | `from_archetype`, `to_archetype`, `actor_role` | `org.archetype_changed` |
| `org_billing_flow_changed` | owner user id | `from_flow`, `to_flow` | `org.billing_flow_changed` |
| `org_archived` | owner user id | (none) | `org.archived` |
| `org_member_invited` | inviter user id | `org_id`, `intended_role`, `archetype` | `org.member.invited` |
| `org_member_redeemed_invite` | redeemer user id | `org_id`, `role`, `archetype` | `org.member.invite_redeemed` |
| `org_member_removed` | actor user id | `org_id`, `removed_role`, `reassignment_strategy` | `org.member.removed` |
| `org_member_role_changed` | actor user id | `org_id`, `target_user_id_hash`, `from_role`, `to_role` | `org.member.role_changed` |
| `org_client_reassigned` | actor user id | `org_id`, `from_membership_id`, `to_membership_id`, `reason_category` | `org.client.reassigned` |
| `org_transfer_scheduled` | head coach user id | `org_id`, `destination_membership_id`, `currency`, `amount_bucket` | `org.transfer.scheduled` |
| `org_transfer_failed` | head coach user id | `org_id`, `destination_membership_id`, `failure_category` | `org.transfer.failed` |
| `org_transfer_reversed` | head coach user id | `org_id`, `destination_membership_id` | `org.transfer.reversed` |
| `assistant_client_read` | assistant user id | `org_id`, `target_resource_kind` | `assistant.client.read` |

`amount_bucket` is a coarse bucket (`<100`, `100-500`, `500-2000`,
`>2000`) rather than the raw cents value, per the no-revenue-in-
properties invariant for non-finance events. The actual amount is
in the `Invoice` mirror; PostHog gets the bucket only.

`target_user_id_hash` is a non-reversible hash of the target user
id, not the id itself, when the event would otherwise leak which
specific user a role change targeted in a way that PostHog cohorts
do not require. The runtime author confirms the hash shape (HMAC
with a server-side secret) at implementation time. The contract
recommends hashing only when the event is highly sensitive; the
default is to send the raw internal id (which is non-PII).

### 3.2 Retention progression events (per [`retention-progression-system.md`](./retention-progression-system.md) §16)

| Event | Distinct id | Properties | Audit pair |
|---|---|---|---|
| `progression_milestone_completed` | user id | `axis`, `milestone_id`, `archetype`, `source` | `progression.milestone_completed` |
| `progression_milestone_granted` | actor (admin) user id | `axis`, `milestone_id`, `target_user_id_hash` | `progression.milestone_granted` |
| `progression_badge_awarded` | user id | `axis`, `badge_id`, `awarded_by_milestone_id` | `progression.badge_awarded` |
| `progression_badge_granted` | actor user id | `axis`, `badge_id`, `target_user_id_hash` | `progression.badge_granted` |
| `progression_level_advanced` | user id | `axis`, `from_level_id`, `to_level_id`, `archetype` | `progression.level_advanced` |
| `progression_level_demoted` | actor user id | `axis`, `from_level_id`, `to_level_id`, `target_user_id_hash`, `reason_category` | `progression.level_demoted` |
| `progression_yearly_upsell_taken` | user id | `axis`, `archetype`, `promoted_from_level_id`, `promoted_to_level_id`, `currency`, `amount_bucket` | `progression.yearly_upsell_auto_promoted` |
| `progression_feature_unlock_blocked` | user id | `axis`, `feature_id`, `reason` | `progression.feature_unlock_blocked` |
| `charter_member_admitted` | actor user id | `axis`, `target_user_id_hash`, `reason_category` | `charter.member_admitted` |
| `charter_member_removed` | actor user id | `axis`, `target_user_id_hash`, `reason_category` | `charter.member_removed` |
| `charter_message_sent` | user id | `axis`, `body_length_bucket` | `charter.message_sent` |
| `joining_incentive_user_admitted` | user id | `axis`, `cohort_label`, `archetype`, `granted_features_count` | `incentive.user_admitted` |
| `joining_incentive_created` | actor user id | `axis`, `archetype_or_null`, `cohort_label`, `max_admits` | `incentive.created` |
| `joining_incentive_retired` | actor user id | `cohort_label` | `incentive.retired` |
| `client_first_win` | user id | `archetype`, `days_from_onboarding_completion`, `kind` | `progression.milestone_completed` (separate row, milestone id `client.first_win_<archetype>`) |

`body_length_bucket` is `<50`, `50-200`, `200-1000`, `>1000`
characters — never the raw body. The body itself is in the
`MessageThread` table, audited separately.

`reason_category` is a closed enumeration the runtime author defines
at implementation time (e.g. `manual_review`, `refund_window`,
`role_violation`). The free-text reason lives only in `AuditLog`
metadata, never in PostHog.

### 3.3 Client onboarding events (per [`onboarding-clients.md`](./onboarding-clients.md) §7)

| Event | Distinct id | Properties | Audit pair |
|---|---|---|---|
| `client_onboarding_step_completed` | user id | `step`, `archetype` | `client.onboarding_started` (step=welcomed) / `client.onboarding_completed` (step=first_program_assigned) |
| `client_onboarding_reminder_24h_sent` | user id | `archetype`, `furthest_step` | `client.onboarding_reminder_sent` (with stage='24h') |
| `client_onboarding_coach_nudge_sent` | coach user id | `archetype`, `furthest_step`, `client_user_id_hash` | `client.onboarding_coach_nudge_sent` |
| `client_onboarding_reengagement_email_sent` | user id | `archetype`, `furthest_step` | `client.onboarding_reengagement_sent` |
| `client_onboarding_lapsed_14d` | user id | `archetype`, `furthest_step` | `client.onboarding_lapsed_14d` |
| `client_onboarding_recovered` | user id | `archetype`, `delay_hours_bucket` | `client.onboarding_recovered` |
| `onboarding_config_changed` | actor user id | `field`, `before_bucket`, `after_bucket` | `onboarding_config_changed` |

`delay_hours_bucket` is `<24`, `24-72`, `72-168`, `>168` hours.

`client_user_id_hash` on the coach-nudge event is the hash form per
§3.1.

### 3.4 Coach onboarding events (per [`onboarding-coaches.md`](./onboarding-coaches.md) §7)

| Event | Distinct id | Properties | Audit pair |
|---|---|---|---|
| `coach_onboarding_step_completed` | coach user id | `step`, `archetype`, `is_sub_coach` | `coach.onboarding_started` (step=welcomed) / `coach.onboarding_completed` (step=first_client_signed) |
| `coach_onboarding_reminder_sent` | coach user id | `archetype`, `furthest_step`, `stage` | `coach.onboarding_reminder_sent` |
| `coach_onboarding_flagged_lapsed` | coach user id | `archetype`, `furthest_step` | `coach.onboarding_flagged_lapsed` |
| `coach_onboarding_recovered` | coach user id | `archetype`, `delay_days_bucket` | `coach.onboarding_recovered` |
| `coach_template_prefilled` | coach user id | `archetype`, `kind` | `coach.template_prefilled` |
| `coach_template_authored` | coach user id | `archetype`, `kind` | `coach.template_authored` |
| `coach_template_archetype_default_changed` | actor user id | `archetype`, `kind`, `previous_template_id` | `coach.template_archetype_default_changed` |
| `coach_template_retired` | actor user id | `archetype`, `kind`, `template_id` | `coach.template_retired` |

### 3.5 AI surface events (per [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §6)

| Event | Distinct id | Properties | Audit pair |
|---|---|---|---|
| `ai_recap_previewed` | coach user id | `client_count_bucket`, `tokens_bucket` | — (read-side) |
| `ai_recap_sent` | coach user id | `client_count_bucket`, `coach_edited` (boolean) | `ai.recap_sent` |
| `ai_program_builder_drafted` | coach user id | `archetype`, `tokens_bucket` | — (preview is read-side; save is the audited action) |
| `ai_program_builder_saved` | coach user id | `archetype`, `coach_edited` (boolean) | `ai.program_saved` |
| `ai_check_in_summarized` | coach user id | `tokens_bucket`, `coach_edited` (boolean) | `ai.check_in_summary_accepted` |
| `ai_at_risk_evaluated` | (server-only) | `cohort_size_bucket`, `flagged_count_bucket` | — (no audit; read-side) |

Server-only events use a synthetic `distinctId = 'system:at_risk_worker'`.
The contract recommends a small set of synthetic distinct ids for
server-side events that have no acting user; this avoids polluting
real-user funnels.

`tokens_bucket` is `<1k`, `1k-5k`, `5k-15k`, `>15k`.

`coach_edited` is `true` whenever the coach modified the AI draft
before persisting — it is the integrity check on AI surface
quality per [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §6.2.

---

## 4. Property catalog

A small set of property names recur across events. The catalog
fixes their shape so the admin Product usage screen can render
consistent cohorts.

| Property | Type | Allowed values | Notes |
|---|---|---|---|
| `archetype` | string enum | `solo`, `gym`, `influencer`, `info_seller` | Closed. From [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §2. |
| `axis` | string enum | `client`, `coach` | Closed. From [`retention-progression-system.md`](./retention-progression-system.md) §2.1. |
| `billing_flow` | string enum | `separate`, `internal_split` | Closed. From [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §3.1. |
| `step` | string enum | client steps + coach steps | Closed. From [`onboarding-clients.md`](./onboarding-clients.md) §2 and [`onboarding-coaches.md`](./onboarding-coaches.md) §2. |
| `level_id` | string | `client_*` / `coach_*` | Closed at runtime per the seed. |
| `milestone_id` | string | per the milestone catalog | Closed at runtime per the seed. |
| `badge_id` | string | per the badge catalog | Closed at runtime per the seed. |
| `feature_id` | string | per the feature registry | Closed at runtime per the seed. |
| `currency` | string | ISO 4217 | Free-form within ISO 4217. |
| `amount_bucket` | string enum | `<100`, `100-500`, `500-2000`, `>2000` | Coarse bucket; raw amount lives in `Invoice` mirror. |
| `tokens_bucket` | string enum | `<1k`, `1k-5k`, `5k-15k`, `>15k` | AI cost shaping. |
| `client_count_bucket` | string enum | `<10`, `10-50`, `50-200`, `>200` | Roster shape. |
| `delay_hours_bucket` | string enum | `<24`, `24-72`, `72-168`, `>168` | Per recovery window. |
| `body_length_bucket` | string enum | `<50`, `50-200`, `200-1000`, `>1000` | Message payloads. |
| `furthest_step` | string enum | step names | Per onboarding flows. |
| `is_sub_coach` | boolean | true / false | Per [`onboarding-coaches.md`](./onboarding-coaches.md) §10. |
| `coach_edited` | boolean | true / false | AI integrity. |
| `reason_category` | string enum | OWNER-managed | Closed at runtime; free-text lives in audit only. |
| `*_user_id_hash` | string | HMAC of the internal id | When the raw id would expose action targeting. |
| `*_at` | ISO8601 string | (none) | Wall clock; PostHog timestamps the event itself. |

---

## 5. Forbidden properties

The following property names MUST NOT appear in any Wave 2 event
property bag. The dispatch test fails if any do.

- `email`, `email_address`, `username`, `email_hash`
- `name`, `first_name`, `last_name`, `display_name`
- `phone`, `phone_number`
- `address`, `city`, `region`, `country` (country is permitted as a
  separate computed property `archetype_country` if a future PR
  needs it; the user's literal address is not)
- `password`, `password_hash`, `secret`, `token`, `session_token`,
  `access_token`, `refresh_token`
- Raw `body`, `message_body`, `message_text`, `prompt`, `response`
  (use bucket variants only)
- Raw `amount_cents`, `amount`, `revenue` (use `amount_bucket`)
- Raw `mrr_cents`, `arr_cents` (use bucket variants per
  [`../metrics.md`](../metrics.md))
- File contents, image bytes, audio bytes, video bytes

The deny-list is the existing one in `AnalyticsService.capture()`.
Wave 2 adds: `body`, `message_body`, `message_text`, `prompt`,
`response`, `amount_cents`, `amount`, `mrr_cents`, `arr_cents`. The
runtime PR adds these to the deny-list array.

---

## 6. Audit row shape

Every state-changing event in §3 has an `AuditLog` row. The
existing `AuditLog` shape (per [`../audit-and-gdpr.md`](../audit-and-gdpr.md))
holds:

- `action` — the canonical event name (the right column of §3
  tables, prefixed with the namespace).
- `actor_id`, `actor_role`, `actor_email_snapshot` — per the
  existing service.
- `target_user_id`, `target_type`, `target_id` — per the existing
  service.
- `tenant_coach_id` — set to the coach whose tenant the action
  touched. For org-scoped actions, this is the org-OWNER's user id;
  per [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md) §13, a
  `tenant_org_id` value goes into the `metadata` JSON blob.
- `metadata` — the full free-text reason (when applicable), the
  before/after pair (for role / level changes), and the org id /
  membership id pointers.

The `AuditLog` row is the **canonical record**. PostHog rows are
**summary records** for funnel and cohort analysis. When the two
disagree, the audit row wins. The runtime author tests this
invariant by joining the two within a 5-minute window per the join
test in [`onboarding-clients.md`](./onboarding-clients.md) §9.6.

---

## 7. Distinct-id rules

The PostHog distinct id rule is closed:

- **Default:** the internal `User.id` (a UUID; non-PII).
- **Anonymous public surface:** the resource id (e.g.
  `code:<GP-XXXXXX>` for invite previews). Existing exception, not
  expanded by Wave 2.
- **Server-only events:** a synthetic `system:<service_name>` id
  (e.g. `system:at_risk_worker`, `system:first_win_watcher`).
  Synthetic ids are documented in the runtime PR's seed file; the
  set is closed.

Mixing distinct ids across events for the same logical user creates
broken cohorts. The contract: an event whose distinct id is the
internal user id remains so for the user's lifetime. We do not
re-id on signup, role flip, or org change.

---

## 8. Implementation contract for the runtime PR

The runtime PR that lifts this spec ships:

- New entries in `src/analytics/events.ts` for every event in §3.
- Updates to the `AnalyticsService` deny-list in §5.
- A jest test asserting every event in §3 is wired in
  `src/analytics/events.ts` with the right property names.
- A jest test asserting every state-changing event has a paired
  `AuditAction` constant in `src/audit/audit-actions.ts`.
- A jest test asserting no event has a forbidden property name in
  its declared property shape.
- A jest test asserting the synthetic distinct ids in §7 are
  the only synthetic ids used.
- A migration adding `OnboardingProgress`,
  `CoachOnboardingProgress`, `OnboardingConfig`, `CoachTemplate`
  per [`onboarding-clients.md`](./onboarding-clients.md) §5 and
  [`onboarding-coaches.md`](./onboarding-coaches.md) §5.
- A migration adding the `tenant_org_id` index on `AuditLog` per
  the [`../audit-and-gdpr.md`](../audit-and-gdpr.md) shape (the
  index is on the JSONB metadata field; Postgres GIN is the
  recommended shape).

The runtime PR does **not** ship sub-coach hierarchy or progression
system schema changes — those are owned by the schema-bearing
runtime PRs that lift [`sub-coach-hierarchy.md`](./sub-coach-hierarchy.md)
and [`retention-progression-system.md`](./retention-progression-system.md).
The data-tracking runtime PR is the *instrumentation* layer; it is
deployable independently.

---

## 9. Admin Product usage consumption

The admin Product usage screen
(`docs/admin/control-room-spec.md` §9) renders Wave 2 funnels:

- **Onboarding completion funnel** — five cells per
  [`onboarding-clients.md`](./onboarding-clients.md) §7.
- **Coach onboarding funnel** — six cells per
  [`onboarding-coaches.md`](./onboarding-coaches.md) §7.
- **Sub-coach invitation funnel** — invite_sent → invite_redeemed →
  first_client_signed by sub-coach.
- **Progression level distribution** — counts by level for both
  axes per [`retention-progression-system.md`](./retention-progression-system.md) §16.
- **AI adoption** — per-surface coach-edit-rate and adoption rate
  per [`positioning-whop-ai-for-coaches.md`](./positioning-whop-ai-for-coaches.md) §4.
- **Charter Members roster** — admit timestamps and admitting
  actors per [`retention-progression-system.md`](./retention-progression-system.md) §13.

Every funnel is sliced by `archetype`, `axis`, and signup-cohort,
and every cell is rendered against real `AuditLog` and PostHog rows
— no synthetic data, per [`../metrics.md`](../metrics.md).

---

## 10. Backwards compatibility

The contract is **append-only**. Existing events in
[`../metrics.md`](../metrics.md) (`invite_previewed`,
`invite_redeemed`, `user_registered`, `user_registered_google`,
`user_signup_with_code`, `coach_provisioned`, `coach_promoted`,
`coach_action`, `subscription_updated`, `subscription_canceled`,
`invoice_paid`, `invoice_payment_failed`, `ai_chat_invoked`,
`coach_message_sent`, `client_message_sent`, `client_food_logged`)
are unchanged.

A future PR may want to coalesce the existing `coach_action` event
into a richer `coach_action_v2` event with the new properties from
Wave 2. That migration is **out of scope for this PR** — the
contract treats existing events as immutable.

---

## 11. Open questions

1. **Hash secret rotation.** The `*_user_id_hash` properties in §3
   require an HMAC secret. The OWNER provides the secret and the
   rotation cadence (recommend: rotate annually with a graceful
   period of dual-emit during overlap).
2. **`reason_category` enumeration.** §4 says it is OWNER-managed.
   The runtime author asks the OWNER for the closed enumeration
   set before implementation; the spec does not invent the values.
3. **Synthetic distinct id namespace.** §7 declares
   `system:<service_name>`. The OWNER confirms whether the namespace
   should be reserved across all PostHog projects (so existing
   `coach_*` distinct ids never accidentally collide with future
   `system:coach_*` synthetic ids).
4. **AI cost properties.** §3.5 buckets tokens. The OWNER confirms
   whether the platform should additionally bucket dollar cost
   (`cost_bucket: 'free' | '<0.10' | '0.10-1.00' | '>1.00'`) on AI
   events. The recommendation: yes, once the AI cost mirror lands
   per `docs/admin/screens-addendum.md` §1.

These four questions are tracked in the root
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Wave 2 entry.

---

## 12. Out of scope

- **The actual PostHog dashboard configuration.** Owned by the
  OWNER's PostHog project. The contract describes the events; the
  dashboards consume them.
- **The PostHog cohort definitions.** Owned by the OWNER.
- **Server-side aggregation worker for admin metrics.** Owned by the
  admin runtime PRs per `docs/admin/pr-sequence.md`.
- **Data retention policy on PostHog.** Owned by the OWNER's PostHog
  configuration; the contract does not specify retention.
- **Sentry instrumentation.** Sentry remains the crash + perf
  surface; this contract is about product analytics. Sentry tags
  carry the same `archetype`, `axis`, and `org_id` properties for
  cross-tool correlation but are not enumerated here.
