# ZION / TGP Database Data Capture Checklist

**Status:** Owner-declared **top-3 must-do of 2026.** This is the foundation feature that unblocks behavioral personalization (A20), predictive churn (A16), AI training data, franchise benchmarking, and longevity/biomed science.

**Rule that overrides everything else in this doc:** If a datapoint can help answer one of these questions, **store it:**

1. What happened?
2. Why did it happen?
3. What changed?
4. Who approved it?
5. Did it work?
6. What should happen next?

---

## 1. Core Identity Data

- User ID, account type, tenant, role.
- Coach ID, client ID, team hierarchy.
- Membership status, package, billing state.
- Consent flags, privacy tier, access scope.

---

## 2. Coaching and Product Data

- Programs, workouts, exercises, set/rep targets.
- Program version history and every edit.
- AI-generated recommendations and whether coach accepted, edited, or rejected them.
- Check-ins, form submissions, coach replies, video replies.
- Milestones, streaks, rewards, churn risk, re-engagement events.

---

## 3. Wearable and Recovery Data

- HRV, resting heart rate, sleep duration, sleep quality.
- Recovery score, active energy, strain, step count.
- Device source, sync time, missing-data flags.
- Daily/weekly rollups and trend deltas.

---

## 4. Support and Troubleshooting Data

- Crisp support tickets and user-reported problems.
- Ticket category, platform area, resolution, response time.
- Attachments, screenshots, reproduction steps.
- Whether the issue maps to a known bug, doc gap, or feature gap.

---

## 5. Operational Memory Data

- Feature flags per tenant, per coach, per user.
- Audit logs for permission checks and content access.
- Package contents and deliverables promised to the client.
- Billing events, subscription changes, refunds, failed payments.
- Onboarding steps, migration imports, completion state.

---

## 6. AI Training Data

- Prompt, retrieved context, final answer.
- User rating, coach override, human correction.
- Approved vs rejected drafts.
- Code fixes proposed, tests run, pass/fail, audit outcome.
- Outcome labels: retained client, completed workout, churned, improved, ignored.

---

## 7. Longevity / Biomed Data

- Baseline biomarker panels.
- Intervention type, dose, timing, and duration.
- Telomere-related assays, inflammation markers, metabolic markers.
- Exercise load, nutrition, sleep, stress, symptom logs.
- Longitudinal outcomes by person and by protocol.

---

## 8. Gym / Franchise Data (Stage 4 + post-Stage-4)

This data class only unlocks when TGP enters the gym vertical (Stage 4). Captured here so the schema is anticipated, not retrofitted.

### 8.1 Highest-value data categories

- **Check-in and attendance patterns:** hour-by-hour traffic, peak days, seasonality, no-show rates, return frequency. Powers churn prediction, staffing, facility planning.
- **Class demand and waitlist behavior:** which class types, times, instructors, and formats drive bookings, cancellations, repeat attendance. Enables demand forecasting + schedule optimization.
- **Membership lifecycle data:** signups, freezes, failed payments, pauses, churn, reactivation, plan upgrades. Revenue forecasting + retention modeling.
- **Staff performance data:** response times, conversion rates, client satisfaction, upsell performance, issue resolution by staff/trainer. Powers QA + manager-level coaching.
- **Facility utilization data:** rack usage, studio usage, recovery room, equipment, front desk, by time window. Capex planning + layout optimization.

### 8.2 AI-strengthening signals

- **Churn-risk labels:** member stops checking in / cancels classes / pauses billing / reduces frequency → direct supervised signal for retention models.
- **Demand forecasting labels:** class bookings, waitlists, attendance heatmaps → clean time-series dataset.
- **Personalization signals:** member goals, class preferences, training frequency, nutrition habits, trainer interactions → tailored recommendations.
- **Operational exception patterns:** failed payments, overcrowding, equipment bottlenecks, unanswered member requests → training data for automated alerts and triage.

### 8.3 Franchise-level advantage

Multi-location data unlocks **benchmarking intelligence** — comparing locations against each other:
- Which gyms retain members better
- Which managers run cleaner operations
- Which class schedules outperform
- Which member segments behave differently by geography

**This turns TGP from "software for gyms" into "benchmarking intelligence for gym networks."** This is a category-defining moat that competitors (Mindbody, Daxko, Glofox) do not currently exploit at scale.

### 8.4 Gym event tables

- `member_events`: check-in, class booked, class canceled, payment failed, freeze, churn, reactivation.
- `staff_events`: response, approval, upsell, incident, outreach.
- `location_events`: peak traffic, capacity, utilization, revenue per square foot.
- `retention_events`: warning signals, intervention, recovery.

---

## 9. Event-First Design

Store the system as **events**, not just current state. Current state is a projection of events; events are the source of truth.

### 9.1 Core events

- `client_created`
- `program_assigned`
- `workout_completed`
- `checkin_submitted`
- `support_ticket_opened`
- `feature_flag_changed`
- `package_delivered`
- `payment_failed`
- `biomarker_collected`
- `protocol_applied`
- `code_fix_proposed`
- `test_passed`

### 9.2 Money-flow events (A13 dependency)

- `money_flow_rule_created`
- `money_flow_rule_modified`
- `reservation_initiated`
- `reservation_released`
- `payout_initiated`
- `payout_completed`
- `ach_return_received`
- `clawback_initiated`

### 9.3 Gym events (Stage 4)

- `member_checked_in`
- `class_booked`
- `class_canceled`
- `member_frozen`
- `member_reactivated`
- `staff_responded`
- `staff_upsold`
- `facility_capacity_hit`

### 9.4 AI / behavioral events

- `ai_draft_generated`
- `coach_approved_draft`
- `coach_edited_draft`
- `coach_rejected_draft`
- `behavioral_profile_updated`
- `intervention_triggered`
- `intervention_outcome_recorded`

---

## 10. Minimum Tables to Start

| Table | Purpose |
|---|---|
| `users` | Identity and role scope |
| `coaches` | Coach profile and permissions |
| `clients` | Client identity and status |
| `programs` | Program definitions |
| `program_versions` | Program change history |
| `workout_logs` | Workout-level adherence data |
| `checkins` | Client self-report data |
| `wearable_readings` | Recovery and biometrics |
| `support_tickets` | Crisp history |
| `feature_flags` | Per-tenant/user toggles |
| `audit_logs` | Access and action trace |
| `packages` | Promised deliverables |
| `package_items` | Line-item contents |
| `ai_actions` | Drafts, prompts, approvals |
| `biomarker_events` | Longitudinal science data |
| `code_fix_runs` | Audit → fix → test loop history |
| `team_hierarchy` | Self-referential N-level org chart (HC/SC/JC/etc) |
| `money_flow_rules` | A13 rule definitions |
| `money_flow_events` | A13 event log |
| `member_events` | Gym attendance + lifecycle (Stage 4) |
| `staff_events` | Gym staff actions (Stage 4) |
| `location_events` | Gym facility utilization (Stage 4) |
| `behavioral_profiles` | Per-user motivational profile (A20) |
| `intervention_events` | Personalization interventions + outcomes |
| `exercise_demos` | Crowdsourced demo library (A19) |
| `demo_usage_events` | Royalty tracking for A19 |

---

## 11. The Strategic Frame

**All this data is MASSIVE for future AI training in a memory-driven world.** Storing every event, every coach decision, every client outcome creates a defensible training corpus that:

- Trains TGP's behavioral personalization models (A20)
- Trains predictive churn models (A16)
- Trains AI program generation refinements (A14)
- Trains AI response drafting in coach-specific voice (A15)
- Provides longitudinal evidence for biomed/longevity claims (A22+)
- Enables franchise benchmarking when Stage 4 lands
- Is itself a sellable data asset (anonymized, aggregated) to research institutions

**Storage cost is rounding error. The cost of NOT storing is catastrophic — every untracked event is training data competitors will have if we delay.**

---

## 12. Doctrine Flags

- **RLS tiers** must be applied to every new table — `audit_logs`, `money_flow_events`, `biomarker_events` are TIER 1.
- **Idempotency** mandatory on every event insertion (event has a unique idempotency key).
- **Consent and privacy tier** enforced via `users.privacy_tier` join — biomarker and behavioral profile data subject to strictest tier.
- **Retention policy** documented per table (e.g., raw wearable readings: 5 years, rollups: indefinite; support tickets: 7 years for compliance; AI prompt/response: indefinite for training).
- **Tenant isolation:** every event row has `tenant_id`. No cross-tenant query path exists at the data layer.

---

## 13. Operator Sequencing

This is a multi-PR program, not a single feature. Suggested ordering:

1. **PR1 — Event scaffolding:** add `ai_actions`, `audit_logs` (expanded), `money_flow_events`. ~5-8 operators.
2. **PR2 — Identity + team hierarchy expansion:** `team_hierarchy` self-referential N-level. ~3-5 operators.
3. **PR3 — Behavioral profile capture:** `behavioral_profiles`, `intervention_events`. ~5-8 operators.
4. **PR4 — Biomed scaffold:** `biomarker_events`, longevity protocol tracking. ~5-8 operators.
5. **PR5 — Crowdsourced demos:** `exercise_demos`, `demo_usage_events`. Lands with A19. ~3-5 operators.
6. **PR6 — Gym event scaffold:** `member_events`, `staff_events`, `location_events`. Lands with Stage 4. ~5-8 operators.

**Total: 26-42 operators** spread across 2026 to make the data foundation real.

---

## 14. Open Operator Questions

1. **Retention windows** per table — defaults proposed above; owner final ruling?
2. **PII scrubbing for training corpus** — at insert time (loses fidelity) or at training-prep time (more storage, more flexibility)? Recommendation: training-prep time.
3. **Real-time event streaming** vs nightly batch? Recommendation: real-time for money + support + intervention, batch for analytics rollups.
4. **Data export rights for coaches** — should coaches be able to export their own clients' data (within consent boundaries) if they leave TGP? Likely yes, but spec the format and limits.
