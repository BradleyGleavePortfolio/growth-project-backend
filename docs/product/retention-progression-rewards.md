# Retention Progression — Rewards Layer

> **Owner:** Platform OWNER (Bradley Gleave)
> **Status:** Spec, draft. No runtime code, no migrations.
> **Builds on:** [`retention-progression-system.md`](./retention-progression-system.md) (engine, schema, milestones, levels). This doc adds the **reward content** layer that the engine evaluates against.
> **Date locked:** 2026-05-01

---

## 0. Why this is a separate doc

`retention-progression-system.md` defines the **engine** — milestones, levels, badges, the state machine, the schema. That doc is intentionally reward-agnostic: it tells you what fires when, but not what the user **gets**.

This doc defines **what the user gets**. It is split out because:

1. The engine ships first; the rewards layer can iterate without schema changes.
2. Owner decisions on rewards (especially the financial ones — leads, mastermind seats, retreat costs) need to be reviewable independently.
3. Several reward classes are deliberately deferred (§7) until the owner has live data to set thresholds against. The engine accommodates the deferral via `granted_features` arrays + `JoiningIncentive.granted_features` and an extension table introduced here (§4).

The rule: **adding or changing a reward must NOT require a Prisma migration.** Reward rows live in the runtime catalog (§4) and are seedable / OWNER-editable through the admin console.

---

## 1. The mental model

Tonight's decisions split rewards into **two completely independent systems with separate audiences**:

| System | Audience | What it rewards | Cohort scope |
|---|---|---|---|
| **Coach Rewards** | B2B — coaches who pay TGP for the OS | Tenure on the platform AND achievement on the platform | Cross-platform (all coaches see each other's public achievements) |
| **Client Rewards** | B2C — clients who pay coaches (NOT TGP) | Consistency, outcome, and community contribution | Same-coach only (a client never sees clients of other coaches) — with one explicit cross-coach exception (§6.5 Year One) |

The split matters because the economics are inverted:

- **Coach rewards** can include things the platform pays for (leads from TGP's funnel, mastermind seats, an annual retreat) because the coach is a paying customer to TGP and LTV justifies the spend.
- **Client rewards** can NOT include free months, refunds, or platform-funded discounts. The client doesn't pay TGP — they pay their coach. A free month would cut into the coach's revenue, which is the wrong incentive. Client rewards are status, access, and social capital — costs near zero to deliver.

This is encoded in §3 (`RewardKind` enum) and enforced at the API contract level.

---

## 2. Coach Rewards — Two Tracks

### 2.1 Track A — Coach Tenure Ladder

The coach is rewarded for **months of paid tenure on the platform**, regardless of revenue. This is the relationship-investment track. Every reward is either zero marginal cost to TGP, or a cost recovered by the coach staying another month.

| Tenure milestone | Internal id | Reward | Marginal cost to TGP | Notes |
|---|---|---|---|---|
| **Month 1** | `coach.tenure_m1` | 30-min onboarding call with TGP team | Low (1 person × 30 min) | Anchors them through the highest-churn window. Already happens informally; this formalises it as an earned milestone, not a sales activity. |
| **Month 3** | `coach.tenure_m3` | Up to 20 qualifying leads from TGP's email funnel routed to the coach's landing page | Variable; capped at 20 | "Up to" wording matters: a dead funnel month should not break the promise. Lead quality is tracked per coach for ROI evidence — see §5.4 reporting. |
| **Month 6** | `coach.tenure_m6` | Mastermind invite — quarterly group call, **8–12 coaches max per cohort** | Low (1 owner-hour per quarter, capped headcount) | The relationships drive retention more than the content. Cohort cap protects the value. |
| **Month 9** | `coach.tenure_m9` | "Coach Spotlight" — a case-study post on the TGP site, an email blast to the TGP list, and a repost to TGP social | Low (content production) | Zero hard cost. Doubles as marketing for TGP. Coaches will repost to their own funnels — free reach for both sides. |
| **Month 12** | `coach.tenure_m12` | Done-for-you funnel audit (1 hour, TGP team reviews landing page + ad copy + onboarding email + churn analytics) AND tier-aware annual-lock-in offer (§2.3) | Medium (1 person × 1 hour) | The audit is the gift; the annual upgrade is the prize. Sequencing matters — audit first, upgrade offer at the close. |
| **Month 18** | `coach.tenure_m18` | Priority feature requests — dedicated channel where the coach's requests jump the roadmap queue (within reason) plus a quarterly 1-on-1 with the OWNER for product feedback | Low (one OWNER-hour per quarter) | Costs nothing material. At 18 months in, their feedback is genuinely better than untiered support tickets. Treats the coach as a co-builder. |
| **Month 24** | `coach.tenure_m24` | Lifetime locked pricing AND lifetime referral revenue share (20% recurring on any coach they refer who stays > 3 months) | Strategic (price-rise opportunity cost) | The "I'll never leave" anchor. Locked pricing makes them feel founding. The referral rev share converts them to acquisition. **OWNER decision recorded:** see [Open question 1](#71-confirm-lifetime-locked-pricing-still-acceptable-at-scale). |
| **Month 36** | `coach.tenure_m36` | In-person retreat invite — annual, ~20 coaches max, hosted by OWNER (2-day workshop format, location TBD per year) | High (real money) | Capstone. By 36 months any coach reaching this has produced enough LTV to justify the spend. **Defaults TBD** — see §7 deferred. |

**State diagram (per coach):**

```
                    +-----------------+
                    | coach signs up  |
                    +--------+--------+
                             |
                             | active subscription
                             v
                    +-----------------+
                    | tenure_clock    |
                    | starts ticking  |
                    +--------+--------+
                             |
                             | on every monthly anniversary
                             | (computed on the 1st of each month
                             |  by a cron job; see §5.1 for the
                             |  algorithm and §5.2 for race handling)
                             v
              +--------------+----------------+
              | TenureRewardGrant row written |
              | for the matching milestone    |
              +-------------------------------+
                             |
                             | on grant
                             v
              +-------------------------------+
              | NotificationDispatch enqueued |
              | + audit row written           |
              +-------------------------------+
```

A pause/cancel/restart of the subscription does not advance the tenure clock. See §5.3 (tenure-clock arithmetic) for handling.

### 2.2 Track B — Coach Achievement Ladder

Tenure rewards alone do not push behaviour. Achievements do. These unlock independently of tenure and are visible on the coach's profile and to the platform-OWNER admin console.

**Achievement levels are layered on top of the existing engine's coach levels** (Founding → Practicing → Compounding → Operating → Scaling → Charter Coach defined in `retention-progression-system.md` §2.1). The achievement ladder is a more granular, public-facing surface; the existing engine levels remain the canonical state machine.

The mapping from existing engine milestones to public achievement names:

| Engine milestone | Achievement (public name) | Internal id | Trigger |
|---|---|---|---|
| `coach.first_client_signed` | **First Win** | `coach.ach_first_win` | Already in engine catalog (see `retention-progression-system.md` §3.2) |
| Composite: 10 clients retained > 60 days | **Trusted** | `coach.ach_trusted` | New milestone — see §2.4 below |
| `coach.first_thousand_revenue` (extended: 25 active clients OR $5K MRR) | **Builder** | `coach.ach_builder` | Existing + extended trigger; see §2.4 |
| `coach.first_sub_coach_hired` (or 50 active clients OR $10K MRR) | **Operator** | `coach.ach_operator` | Existing + extended; see §2.4 |
| Composite: 100 active clients OR $25K MRR | **Authority** | `coach.ach_authority` | New milestone — §2.4. **This is the badge that triggers the §2.5 upsell-overlap policy.** |
| Top 10 coaches by retention rate (rolling 90 days) | **Top Performer** | `coach.ach_top_performer` | New milestone — leaderboard cron, §5.5 |
| Composite: reactivated 5 lapsed clients | **Comeback Coach** | `coach.ach_comeback` | New milestone — §2.4 |
| Composite: referred 3 paying coaches who stayed > 3 months | **Referrer** | `coach.ach_referrer` | New milestone — §2.4. **Triggers the lifetime-rev-share grant from `coach.tenure_m24` early when achieved before month 24.** |

### 2.3 Annual lock-in offer (Month 12) — tier-aware

The Month-12 reward includes an upsell offer to switch from monthly to annual billing. The offer scales by the coach's current pricing tier so the perceived value matches what they already pay:

| Coach tier | Monthly price reference | Annual offer at M12 |
|---|---|---|
| **OS-only** | $300–$500/mo | 2 months free on annual commitment |
| **OS + team coach** | ~$2,200/mo | 1 month free on annual commitment + a dedicated 1-on-1 quarterly business review with the OWNER |
| **White-glove** | ~$7,000/mo | No discount. Instead: a custom outcome (e.g., joint-launched program, OWNER co-branding on a campaign, advisory seat on a product committee). Specifics negotiated 1-on-1. |

The "1-on-1 negotiated outcome" for white-glove must NOT be hardcoded in the catalog — see §3.2 (`RewardGrant.payload` is a JSON column for this exact reason).

### 2.4 Composite milestones — engine extension

The engine in `retention-progression-system.md` §3 defines milestones as single events. The achievement track introduces **composite milestones** — a milestone that fires when N concurrent conditions are all true. The engine extension is small:

```prisma
model CompositeMilestoneRule {
  id                  String          @id              // e.g. "coach.ach_authority"
  milestone           Milestone       @relation(fields: [id], references: [id], onDelete: Cascade)
  expression          Json            // discriminated-union AST; see below
  evaluation_cadence  String          // 'event' | 'cron_daily' | 'cron_weekly'
  retired_at          DateTime?
  created_at          DateTime        @default(now())
}
```

`expression` is a small discriminated-union AST evaluated by the runtime engine:

```ts
type CompositeExpression =
  | { kind: 'and';  children: CompositeExpression[] }
  | { kind: 'or';   children: CompositeExpression[] }
  | { kind: 'count_active_clients';      gte: number }
  | { kind: 'mrr_cents';                  gte: number } // Decimal(14,2)
  | { kind: 'count_clients_retained';    gte: number; min_days_retained: number }
  | { kind: 'count_clients_reactivated'; gte: number; reactivation_window_days: number }
  | { kind: 'top_n_leaderboard';         leaderboard: 'retention_90d'; rank_lte: number }
  | { kind: 'count_referrals_qualified'; gte: number; min_days_stayed: number };
```

The expressions for the achievement milestones in §2.2:

```ts
// coach.ach_trusted — 10 clients retained > 60 days
{ kind: 'count_clients_retained', gte: 10, min_days_retained: 60 }

// coach.ach_builder — 25 active clients OR $5,000 MRR
{ kind: 'or', children: [
  { kind: 'count_active_clients', gte: 25 },
  { kind: 'mrr_cents', gte: 500_000 },          // $5,000.00
]}

// coach.ach_operator — 50 active clients OR $10,000 MRR
{ kind: 'or', children: [
  { kind: 'count_active_clients', gte: 50 },
  { kind: 'mrr_cents', gte: 1_000_000 },        // $10,000.00
]}

// coach.ach_authority — 100 active clients OR $25,000 MRR
{ kind: 'or', children: [
  { kind: 'count_active_clients', gte: 100 },
  { kind: 'mrr_cents', gte: 2_500_000 },        // $25,000.00
]}

// coach.ach_top_performer — top 10 by 90d rolling retention
{ kind: 'top_n_leaderboard', leaderboard: 'retention_90d', rank_lte: 10 }

// coach.ach_comeback — 5 lapsed clients reactivated within 30 days each
{ kind: 'count_clients_reactivated', gte: 5, reactivation_window_days: 30 }

// coach.ach_referrer — 3 referred coaches who stayed >= 90 days
{ kind: 'count_referrals_qualified', gte: 3, min_days_stayed: 90 }
```

**MRR is computed sub-coach-aware** per `sub-coach-hierarchy.md` §org-rolled-up-MRR and `tgp-finance-app/docs/billing/finance-org-roll-ups.md`. Decimal(14,2) end-to-end.

**Active client** is defined in `data-tracking-contract.md` and matches the existing engine's `coach.first_25_active_clients` definition — no redefinition here.

**The leaderboards** (`retention_90d`) are a new admin-feed endpoint introduced in `data-feed-rfc.md` §org observe family — see §5.5 below for the cron job.

### 2.5 Tier-overlap policy — achievement vs paid tier

**OWNER decision locked tonight: a coach earns the perks of the next tier as a marketing taste, even if they have not paid for that tier.**

Concretely:

- A coach who pays for **OS-only** ($300–500/mo) but earns the **Authority** achievement automatically receives **a one-time taste of white-glove perks** — specifically: one free quarterly executive review with the OWNER, **time-boxed to a single session, with a soft upsell at the end**.
- A coach who is **already on white-glove** and earns Authority gets a **brief, gracious acknowledgement** (a personal note from the OWNER) but no additional perk — the policy is documented in `notification.body.md` so the coach understands the symmetry. The OWNER can privately offer additional bespoke perks at their discretion.
- A coach on **OS+team coach** ($2,200/mo) who earns Authority gets the white-glove taste but **does not** trigger the $7K upsell automatically — they get a soft upsell to white-glove, recorded as a sales-qualified-lead event for the OWNER.

This is encoded as `RewardOverlapPolicy` rows (§3.3) and is the **only** place in the system where pricing tier and achievement tier interact. Everywhere else they are independent axes.

The intent (recorded for future engineers): **the achievement track is a generous, irreversible status; the pricing tier is what the coach pays for. When they overlap, we let the coach feel the next tier so they are pulled toward upgrading. We never feel like we are clawing back.**

---

## 3. Schema additions — Prisma sketch

The blocks below extend the engine schema in `retention-progression-system.md` §4. The runtime PR lifts these into `prisma/schema.prisma`. **No migration is implied by this spec PR.**

### 3.1 `RewardKind`

```prisma
enum RewardKind {
  // Coach-only kinds
  call_with_team
  lead_grant
  mastermind_seat
  spotlight_post
  funnel_audit
  priority_requests_channel
  lifetime_pricing_lock
  referral_revshare
  retreat_invite
  annual_upgrade_offer
  exec_review_taste                // §2.5 white-glove taste

  // Client-only kinds (§6)
  cohort_visibility_boost          // status surface in cohort feed
  coach_voice_message_prompt       // platform asks coach to record a message
  shareable_milestone_reel
  cohort_hall_of_fame_feature
  ama_slot_with_coach
  testimonial_landing_page_slot
  golden_ticket_year_one           // §6.5 Year One
  year_one_private_chat_admit      // §6.5 Year One
  client_special_social_cue        // §6.5 Year One
}
```

### 3.2 `RewardCatalog` and `RewardGrant`

```prisma
model RewardCatalog {
  id                          String         @id              // e.g. "coach.tenure_m6.mastermind_seat"
  kind                        RewardKind
  display_name                String
  description                 String
  audience                    String         // 'coach' | 'client'
  triggered_by_milestone_id   String?                         // FK to Milestone.id when 1:1 with a milestone
  triggered_by_milestone      Milestone?     @relation(fields: [triggered_by_milestone_id], references: [id], onDelete: SetNull)
  payload_schema_version      Int                              // version stamp for the JSON payload schema below
  default_payload             Json                             // shape varies by kind; see §3.4
  active                      Boolean        @default(true)
  retired_at                  DateTime?
  created_at                  DateTime       @default(now())

  @@index([audience])
  @@index([triggered_by_milestone_id])
}

model RewardGrant {
  id                          String         @id @default(uuid())
  user_id                     String
  user                        User           @relation(fields: [user_id], references: [id], onDelete: Cascade)
  catalog_id                  String
  catalog                     RewardCatalog  @relation(fields: [catalog_id], references: [id], onDelete: Restrict)
  granted_at                  DateTime       @default(now())
  payload                     Json                             // resolved payload at grant time (e.g. lead-allocation amount)
  redeemed_at                 DateTime?                        // when the user actually used the reward
  redemption_evidence         Json?                            // structured evidence (e.g. lead ids delivered)
  source                      String                           // 'auto' | 'admin_grant'
  granted_by_actor_id         String?                          // FK to User.id when admin-granted
  state                       String                           // 'pending_delivery' | 'delivered' | 'redeemed' | 'expired' | 'revoked'

  @@unique([user_id, catalog_id, granted_at]) // a reward can fire more than once per user (e.g. annual retreats), but never at the same instant
  @@index([user_id, state])
  @@index([state, granted_at])
}
```

### 3.3 `RewardOverlapPolicy`

```prisma
model RewardOverlapPolicy {
  id                              String        @id              // e.g. "coach.ach_authority.x.os_only"
  triggering_achievement_id       String                          // FK to Milestone.id (e.g. "coach.ach_authority")
  applies_when_pricing_tier       String                          // 'os_only' | 'os_plus_team_coach' | 'white_glove'
  resolves_to_reward_catalog_id   String                          // FK to RewardCatalog.id
  notification_template_id        String                          // FK to a notification template (server-rendered copy)
  active                          Boolean       @default(true)

  @@unique([triggering_achievement_id, applies_when_pricing_tier])
}
```

The runtime evaluation order on an achievement firing:

1. Look up `RewardOverlapPolicy` rows for the achievement.
2. Resolve the coach's current pricing tier (`CoachSubscription.product_tier` per existing schema).
3. Match the row, write a `RewardGrant` for the resolved catalog id.
4. Render the matching notification template; enqueue dispatch.
5. Emit audit row.

### 3.4 Reward payload shapes

The `default_payload` and `payload` columns are JSON; their shape depends on `RewardKind`. The shapes are versioned via `RewardCatalog.payload_schema_version`.

```ts
// kind: 'lead_grant'
{ schema: 1, max_leads: 20, source_funnel_id: string, expiry_days: 60 }

// kind: 'mastermind_seat'
{ schema: 1, cohort_label: string, scheduled_at: ISO8601, max_seats: 12, calendly_link: string }

// kind: 'spotlight_post'
{ schema: 1, draft_status: 'pending_intake' | 'in_review' | 'published', publish_url?: string }

// kind: 'funnel_audit'
{ schema: 1, scheduled_at?: ISO8601, audit_doc_url?: string, completed: boolean }

// kind: 'lifetime_pricing_lock'
{ schema: 1, locked_monthly_cents: number, locked_at: ISO8601, lock_terms_md: string }

// kind: 'referral_revshare'
{ schema: 1, percentage: number, min_days_stayed: number, currency: 'USD', stripe_connect_account_id?: string }

// kind: 'retreat_invite'
{ schema: 1, year: number, location_tbd: boolean, location?: string, dates_tbd: boolean, dates?: { start: ISO8601, end: ISO8601 }, max_seats: 20 }

// kind: 'annual_upgrade_offer'
{ schema: 1, tier_at_offer_time: 'os_only' | 'os_plus_team_coach' | 'white_glove', months_free?: number, custom_outcome_required?: boolean, expires_at: ISO8601 }

// kind: 'exec_review_taste'
{ schema: 1, scheduled_at?: ISO8601, soft_upsell_target_tier: 'white_glove', max_minutes: 60 }

// kind: 'golden_ticket_year_one'
{ schema: 1, retreat_offer_catalog_id: string, premium_retreat_year: number, expires_at: ISO8601 }

// kind: 'year_one_private_chat_admit'
{ schema: 1, channel_id: string, admitted_at: ISO8601 }

// kind: 'client_special_social_cue'
{ schema: 1, cue_token: 'year_one_v1', visible_in: ['cohort_feed', 'profile'] }
```

The runtime PR is responsible for a Zod schema per kind. The validator MUST be `@SkipDecimalNormalisation()` for `lifetime_pricing_lock.locked_monthly_cents` — see `tgp-finance-app/docs/billing/sub-coach-billing-split-spec.md` for the decimal-normalisation rules.

---

## 4. State machine — RewardGrant lifecycle

```
                 +--------------+
                 |  (no row)    |
                 +------+-------+
                        |
       milestone fires  |  composite expression evaluates true
                        v
              +-------------------------+
              | state: pending_delivery |     audit: reward.granted
              +-----------+-------------+
                          |
                          | dispatcher succeeds
                          | (call scheduled / leads queued / etc.)
                          v
              +-------------------------+
              | state: delivered        |     audit: reward.delivered
              +-----------+-------------+
                          |
                          | user redeems
                          | (attends call / claims leads / books retreat seat)
                          v
              +-------------------------+
              | state: redeemed         |     audit: reward.redeemed
              +-------------------------+

      Side branches (any non-redeemed state may transition out):

              +-------------------------+
              | state: expired          |     audit: reward.expired
              +-------------------------+     (e.g. annual_upgrade_offer.expires_at)

              +-------------------------+
              | state: revoked          |     audit: reward.revoked
              +-------------------------+     (OWNER admin action only — capability act:reward_revoke)
```

**Transition table:**

| From | Event | Guard | To | Side effects | Audit action |
|---|---|---|---|---|---|
| (no row) | milestone fires | `RewardCatalog.active = true` AND no overlapping policy says skip | `pending_delivery` | enqueue dispatcher; render notification template | `reward.granted` |
| `pending_delivery` | dispatcher success | dispatcher returns 2xx within 24h SLO | `delivered` | mark deliverable artifact (e.g. lead allocation, calendly link) | `reward.delivered` |
| `pending_delivery` | dispatcher failure (5 retries with backoff) | retries exhausted | `pending_delivery` (held) | open admin ticket on OWNER queue; daily digest | `reward.dispatch_failed` |
| `delivered` | user redemption event | matches kind-specific redemption signal | `redeemed` | write `redemption_evidence`; close any soft-upsell follow-ups | `reward.redeemed` |
| `delivered` | clock past `expiry` | `payload.expires_at < now()` | `expired` | notify user (template `reward.expired.{kind}.body`) | `reward.expired` |
| `pending_delivery` \| `delivered` | OWNER revoke | capability `act:reward_revoke` | `revoked` | reverse any side effects (e.g. lead reservations released) | `reward.revoked` |

---

## 5. Implementation algorithms

### 5.1 Tenure clock cron (Track A)

**Cadence:** daily at 09:00 UTC. Cheap; small set of coaches; idempotent by design.

**Algorithm:**

1. SELECT every `User` where the user has an active coach role and `CoachSubscription.status IN ('active', 'past_due')` (NOT `canceled`).
2. For each, compute `effective_tenure_days = SUM(active_billing_days_since_first_activation)` — see §5.3 for the arithmetic.
3. For each tenure milestone in the catalog (M1=30, M3=90, M6=180, M9=270, M12=365, M18=540, M24=730, M36=1095 days), check whether the user has crossed the threshold AND has no existing `RewardGrant` for the corresponding `RewardCatalog.id`.
4. If both conditions are true: write the `RewardGrant` row with `state=pending_delivery`, enqueue the dispatcher, write the audit row.

**Idempotency:** the `(user_id, catalog_id, granted_at)` unique key prevents double-grants within the same millisecond. The "no existing grant" check prevents double-grants across runs.

**Performance budget:**

- 100 coaches: < 200ms total job execution.
- 1,000 coaches: < 2s.
- 10,000 coaches: < 10s. (At this scale, partition by `CoachSubscription.created_at` month and parallelise.)

### 5.2 Composite milestone evaluator (Track B)

**Cadence:** `evaluation_cadence` per row in `CompositeMilestoneRule`.

- `'event'` cadence: hooks into the existing milestone-evaluation pipeline in `retention-progression-system.md` §5. When a candidate condition changes (e.g. `Invoice.amount_paid_cents` increments, an `ActiveClientCount` mirror updates, a referral converts), re-evaluate every `CompositeMilestoneRule` whose expression references that signal.
- `'cron_daily'` cadence: 02:00 UTC daily, one batch per rule, scoped to coaches whose recent activity touched any signal in the expression.
- `'cron_weekly'` cadence: 02:00 UTC Sunday, full sweep — used for `top_n_leaderboard` rules.

**Race handling:** the composite evaluator and the engine's per-milestone evaluator MUST run in the same process or share an advisory lock keyed on `(user_id, milestone_id)` to prevent double-firing. The doctrine in `retention-progression-system.md` §5 ("milestone fires at most once per user") is preserved.

### 5.3 Tenure-clock arithmetic — pause / cancel / restart

**Doctrine:** **the tenure clock pauses while the subscription is paused or canceled, and resumes on reactivation.** It does NOT reset on cancel.

The existing schema has `CoachSubscription.status` and `CoachSubscriptionEvent` rows (per webhook). The runtime computes:

```
effective_tenure_days(coach) = SUM over CoachSubscriptionEvent of:
  (event.status_window_end - event.status_window_start)
  WHERE event.status IN ('trialing', 'active', 'past_due')
```

The query is a small materialised view (`coach_effective_tenure`) refreshed nightly and updated synchronously on subscription webhooks. **Tenure thresholds are evaluated in days, not calendar months,** to make the arithmetic deterministic regardless of leap days, time zones, or short Februarys.

A coach who pauses for 90 days, then reactivates, hits Month-3 (90 days) some 180 calendar days after sign-up but the same 90 effective days. This is the correct behaviour: the rewards reflect investment in the relationship, not the wall clock.

### 5.4 Lead-grant delivery (Month 3) — variable cost protection

The Month-3 reward is "up to 20 qualifying leads" — the cap protects TGP when the funnel underperforms. Delivery rules:

1. On grant, write `RewardGrant.payload = { schema: 1, max_leads: 20, source_funnel_id: <current funnel>, expiry_days: 60 }`.
2. A new `LeadAllocation` table tracks attribution: `(reward_grant_id, lead_user_id, attributed_at, conversion_state)`. The lead's `User.attributed_to_coach_id` is set on signup if they came in through the coach's tagged URL.
3. The grant transitions to `delivered` when **either** 20 leads have been attributed **or** 60 days have elapsed (whichever first).
4. Leads delivered count is reported in the coach console; conversion rate (lead → paying client) is reported privately to TGP for ROI evidence.

**Why "up to" matters:** if TGP's funnel produces 5 leads in 60 days, the coach got 5 leads, not a broken promise. The `notification.body.md` template explicitly says "up to 20 qualifying leads from our funnel — we'll deliver as many as the funnel produces during your 60-day window."

### 5.5 Top Performer leaderboard (Track B)

**Cadence:** weekly, Sunday 02:00 UTC.

**Algorithm:**

1. For every active coach, compute 90-day rolling retention rate: `retained_clients / clients_at_window_start`.
2. Filter to coaches with `clients_at_window_start >= 10` (smaller rosters have too much variance).
3. Rank by retention rate, descending. Tie-break by absolute retained client count, descending.
4. Top 10 fire `coach.ach_top_performer` — `RewardGrant` written for that achievement's reward catalog, only if the coach does not already have an unredeemed Top Performer grant from the previous quarter.

**Anti-gaming:** a coach who artificially churns then re-signs the same client cannot game retention. The `is_retained` definition uses `User.created_at` for the original join, not the latest re-signup. The platform doctrine: **"a client who left and came back does not reset retention math."**

---

## 6. Client Rewards — Three Tracks

Per the OWNER decision tonight: **clients pay coaches, not TGP. So no free months, no platform-funded discounts.** Rewards are status, access, and social capital.

**Cohort scope:** every reward described below is visible **only to the coach's own roster** unless explicitly marked cross-coach. There is exactly one cross-coach surface in the system (§6.5 Year One golden ticket) and it is OWNER-controlled.

### 6.1 Track 1 — Consistency

The OS-agnostic track. Engine reuses existing milestones from `retention-progression-system.md` §3.1 (`first_workout_completed`, `first_food_logged`, `first_check_in_completed`, etc.). Tonight's rewards layer adds:

| Achievement | Trigger | Reward kind | Cohort scope |
|---|---|---|---|
| **Showing Up** (7-day streak across any check-in type) | composite: any check-in milestone fires 7 days running | `cohort_visibility_boost` (badge surfaced in cohort feed) | same-coach |
| **Locked In** (30-day streak) | composite: same as above × 30 | `coach_voice_message_prompt` (platform sends coach a one-tap "send congratulations" template) | same-coach |
| **Disciplined** (90-day streak) | composite × 90 | `cohort_hall_of_fame_feature` (quarterly hall-of-fame placement in cohort feed; coach's gated content unlocks) | same-coach |
| **Relentless** (180-day streak) | composite × 180 | `ama_slot_with_coach` + `testimonial_landing_page_slot` (with client opt-in) | same-coach |
| **Year One** (365-day streak with active engagement) | composite × 365 + an "activity marker" (defined §6.5) | `golden_ticket_year_one` + `year_one_private_chat_admit` + `client_special_social_cue` | same-coach + cross-coach (§6.5) |

**Streak doctrine — note for engine alignment:** the existing engine in `retention-progression-system.md` (§7.1) excised "streaks/badges/trophies/reactions" as PR #90 doctrine. The Consistency track uses streaks **internally** to compute progression but does NOT surface a daily streak counter to the user, does NOT award daily badges, and does NOT use streaks as social-reaction primitives. The user sees milestone names ("Showing Up", "Locked In") not numeric streak counts. This preserves the doctrine.

**Anti-gaming:**

1. A check-in counts only if it lands within the day's local-tz window. No backdating.
2. One streak-freeze per 30 days (illness/travel). Must be requested in-app, not retroactive.
3. Coach cannot mark a check-in for the client. If attempted, the action is blocked and audit-logged.
4. Streak resets on payment lapse > 7 days at the coach level (the client's coach being unpaid resets the streak — protects against ghost-paid streak farming).
5. Minimum-bar: a check-in must include at least one piece of structured data (logged set, food entry, weight entry, habit tick, expense entry — depending on OS). A bare tap does not count.

### 6.2 Track 2 — Outcome (OS-app-specific, coach-configurable)

The engine's existing milestone catalog covers `first_program_completed`, `first_goal_hit`, `first_outcome_check_in`. The rewards layer adds:

| Achievement (per OS) | Reward kind | Notes |
|---|---|---|
| **First milestone hit (any OS)** | `shareable_milestone_reel` (auto-compiled before/after that the client posts to their own social, tagging coach) | Drives organic growth: client posts → coach gets reach → platform indirectly gains. Zero hard cost. |
| **Outcome-verified** (coach explicitly marks the milestone hit per `client.first_milestone_celebrated_with_coach` from §3.1) | `coach_voice_message_prompt` (existing reward kind reused) | Single biggest retention factor in the literature: client feels seen by coach. |

**OS variation is implemented at the milestone-catalog level**, not the rewards layer — the catalog has `archetypes` already (`retention-progression-system.md` §3.3); we add an `os_variants` array for the same purpose at the OS level (Fitness OS, Finance OS, future OSes). The reward kinds remain OS-agnostic.

### 6.3 Track 3 — Community (cohort contribution)

| Achievement | Trigger | Reward kind | Cohort scope |
|---|---|---|---|
| **Helper** | client posts encouraging comment on 5 cohort-mates' check-ins | `cohort_visibility_boost` (badge in cohort feed) + coach gets prompt to consider promoting | same-coach |
| **Cheerleader** | top 5 most-supportive comments in cohort over rolling 30 days (auto via reaction count) | monthly shoutout in cohort recap | same-coach |
| **Cohort Lead** | coach manually promotes (1–2 per cohort, OWNER-side capability for now) | special badge + early access to coach's new content + private channel with coach | same-coach |
| **Ambassador** | referred a paying client to the same coach | platform-side: badge + referral attribution recorded; coach decides perk separately | same-coach |

**Wave 4 mobile dependency:** Track 3 requires a **cohort feed surface** in the mobile app. Wave 4 PR #98 §progression-mobile-ux must include a cohort feed in v1, OR Track 3 ships in v2. Decision deferred — see §7 Open question 4.

### 6.4 What client rewards explicitly do NOT include

- **No free months.** Client pays the coach; TGP cannot grant free months without cutting into coach revenue.
- **No discounts.** Same reason.
- **No refunds-as-reward.** Same reason.
- **No cross-cohort comparisons.** A client never sees the rank or activity of clients outside their coach's roster (except the §6.5 Year One channel).
- **No streak counters surfaced to client UI.** The Consistency track is computed via streaks internally but presented as named achievements only — preserves the PR #90 doctrine.

### 6.5 Year One — the one cross-coach exception

**OWNER decision locked tonight:** every client who hits 365 days **with their coach** AND has an "activity marker" (definition pending — see §7 Open question 5) receives:

1. **Golden ticket to a premium TGP retreat** — an upsell offer, not a free retreat. The retreat is a paid product TGP runs; the golden ticket is a gated invitation to buy a seat at a Year One member rate.
2. **Admission to a private cross-coach Year One chat channel** — moderated by TGP team. Status only; no comp data shared, no client poaching, coaches do not have visibility into the channel. **Charter Members rules apply** — see `retention-progression-system.md` §9.
3. **A special social cue** — a profile token (visible to the client's own coach + cohort-mates) marking them as a Year One member.

The cross-coach channel is **the only place** in the entire client experience where clients of different coaches see each other. The boundary is: status only, no comp data, no recruitment. Violation reports go to a new `act:year_one_moderation` capability held by the platform-OWNER and a designated trust-and-safety actor.

**The "activity marker"** must be defined before launch. The intent: a 365-day-tenured client who has been inactive for the last 30 days should NOT receive the golden ticket. See §7 Open question 5 for the threshold question.

---

## 7. Deferred decisions — owner must resolve before launch

These are deliberate gaps. The engine and rewards layer schema accommodate them all without future migrations. Each row below has a recommendation to break the tie.

| # | Question | Why deferred | Recommendation |
|---|---|---|---|
| **7.1** | Lifetime locked pricing at Month 24 — still acceptable when TGP raises base prices in year 3+? | Hard to reverse; affects long-term margin | **Yes, with cap:** lock the coach's *current* monthly rate; reserve the right to raise prices on new SKUs (e.g. white-glove tier) the coach later upgrades to. Document in `lock_terms_md`. |
| **7.2** | Mastermind cadence and host | Affects OWNER calendar | Quarterly, OWNER-hosted for the first 4 cohorts; senior team member from cohort 5 onward. |
| **7.3** | Retreat cost model — TGP pays, coach pays, hybrid? | Real money | Hybrid: TGP covers venue + content; coach pays own travel + a nominal seat fee ($500–1000) to filter for serious attendees. Final number deferred. |
| **7.4** | Cohort feed UX in mobile | Affects Wave 4 scope | Full feed (post + reactions + comment threads). Deferral lands Track 3 Community in v2; Tracks 1+2 unaffected. **Decision needed before Wave 4 PR #98 leaves draft.** |
| **7.5** | Year One "activity marker" threshold | Anti-fraud | Active in 4 of last 8 weeks (≥1 check-in/week in 4+ weeks of the trailing 56 days). |
| **7.6** | Year One golden ticket — single redemption or annual recurring? | Affects retreat seat allocation | Single redemption per Year One milestone; if the client renews to Year Two, a new golden ticket fires for the next year's retreat. |
| **7.7** | Top Performer reward — what does it actually grant? | Money / no money trade-off | A free month of OS subscription + leaderboard placement on the public coach directory + optional shoutout. Re-evaluate at 6 months of operating data. **Note: Top Performer is the only coach reward with a free-month component; coaches at this level have already produced enough LTV to justify it.** |
| **7.8** | "Up to 20 qualifying leads" — what counts as qualifying? | Affects Month-3 reward delivery | Email-opt-in subscriber within the matching archetype/niche, residing in the coach's geo target if specified, who has not already received another coach's lead grant in the past 90 days. |
| **7.9** | Tier-overlap "exec review taste" — soft upsell content | Sales material | Drafted by OWNER; lives in `notification_template` rows. Not a runtime concern. |
| **7.10** | Charter Members and Year One — relationship between the two | Avoid surface duplication | Charter Members is OWNER-curated and small (<50 lifetime); Year One is automatic at the milestone. A user can be in both. The mobile UI surfaces them as two separate badges. |

---

## 8. Cross-repo dependencies

| Dep | Where | Direction |
|---|---|---|
| `Milestone`, `MilestoneCompletion`, `BadgeAward` schema | `growth-project-backend/docs/product/retention-progression-system.md` | This doc extends |
| `CoachSubscription.product_tier` for tier-overlap policy | existing backend schema | This doc reads |
| Sub-coach-aware MRR for `mrr_cents` composite expressions | `growth-project-backend/docs/product/sub-coach-hierarchy.md` + `tgp-finance-app/docs/billing/finance-org-roll-ups.md` | This doc consumes |
| Notification template engine | existing `src/messaging/` + per-template copy | This doc requires |
| Cohort feed surface (Track 3 dependency) | `growth-project-mobile/docs/product/progression-mobile-ux.md` (Wave 4) | This doc may defer Track 3 to v2 |
| `act:reward_revoke` and `act:year_one_moderation` capabilities | `growth-project-backend/docs/admin/control-room-spec.md` (Wave 1) | This doc adds |
| Admin console screens to manage `RewardCatalog`, `RewardOverlapPolicy`, `JoiningIncentive` | Wave 1 + Wave 3 admin specs | This doc adds rows |
| `LeadAllocation` model (Month-3 reward) | new — added in this doc; requires runtime PR | This doc introduces |

---

## 9. Failure modes (≥5)

| # | Failure | Detection | Remediation |
|---|---|---|---|
| 1 | Tenure cron runs twice in the same day (e.g. retried after partial failure) and writes duplicate `RewardGrant` rows | Audit log volume spike; uniqueness violations | The `(user_id, catalog_id, granted_at)` unique key fires; the second write is rejected with the engine's standard idempotency-collision response. Cron is idempotent by design. |
| 2 | Composite expression evaluator double-fires a single milestone (race between event-cadence and cron-cadence) | Two `MilestoneCompletion` rows attempted for same `(user_id, milestone_id)` | Engine's existing unique key on `MilestoneCompletion` (per `retention-progression-system.md` §4) blocks the second insert. Advisory lock per §5.2 prevents the race. |
| 3 | Lead-grant funnel produces 0 leads in the 60-day window — coach feels deceived | Operations dashboard surfaces zero-lead grants | Notification template at grant time explicitly says "up to 20"; grant transitions to `delivered` at 60 days regardless; coach is messaged proactively at day 45 if delivery rate is below threshold. |
| 4 | Annual upgrade offer expires while coach is in the middle of upgrading via the support team | `expires_at` window misses an in-flight conversation | Manual override capability `act:reward_extend` lives on the OWNER role; extends `expires_at` with audit row. **Default: no auto-extension.** |
| 5 | Year One golden ticket fires for a client whose coach has already churned off the platform | Orphan grants — coach is gone but client's milestone fires | Tenure clock for the client uses **the client's payment history with the coach**, NOT the coach's payment history with TGP. If the coach has churned, the client is also off the platform; their tenure clock has stopped. The grant cannot fire. |
| 6 | A coach earns Authority on the same day they downgrade from white-glove to OS-only — overlap policy ambiguity | Race in policy evaluation | Policy reads `CoachSubscription.product_tier` at the **moment of grant**, not at the moment of milestone fire. The user's downgrade is sequenced before the grant; they receive the OS-only-side overlap reward. Audit row records both states. |
| 7 | Lifetime locked pricing — coach disputes that they were promised a lock | No internal record of the lock terms beyond `lock_terms_md` | The `lifetime_pricing_lock` reward grant is permanently retained; the rendered `lock_terms_md` (with timestamp + Stripe subscription id at grant time) constitutes the binding record. |
| 8 | Streak-freeze abused — client takes one freeze every 30 days for the entire year, never breaks streak, but is barely active | Activity marker (§6.5) check at Year One | The Year One milestone requires the activity marker (4 of last 8 weeks active), separate from the streak. A freeze-abuser hits 365 streaked days but fails the activity marker; no golden ticket. |

---

## 10. Performance budgets

| Surface | 100 coaches | 1,000 coaches | 10,000 coaches |
|---|---|---|---|
| Tenure cron full sweep | < 200ms | < 2s | < 10s (partition required) |
| Composite evaluator — event cadence (per signal) | < 50ms p95 | < 50ms p95 | < 100ms p95 (cache MRR mirror) |
| Composite evaluator — daily cron | < 1s | < 10s | < 60s (partition by org) |
| Top Performer weekly leaderboard | < 1s | < 10s | < 60s |
| Lead-grant attribution write | < 20ms p95 | < 20ms p95 | < 30ms p95 |
| Charter Members admit (admin action) | < 200ms | < 200ms | < 200ms (single-row write) |
| Year One channel admit | < 100ms | < 100ms | < 100ms |
| `RewardGrant` query for "my unredeemed rewards" (per user) | < 50ms p95 | < 50ms p95 | < 50ms p95 (indexed) |

---

## 11. Day-1 implementation order

This is the recommended commit sequence for the runtime PR (NOT this spec PR). Each commit is independently reviewable.

1. **Schema migration:** `RewardKind` enum, `RewardCatalog`, `RewardGrant`, `RewardOverlapPolicy`, `CompositeMilestoneRule`, `LeadAllocation`. No data, no logic.
2. **Catalog seed:** `prisma/seeds/reward-catalog.seed.ts` with the static rows from §2.1, §2.2, §3.4 default payloads. Idempotent upserts.
3. **Tenure-clock materialised view** (`coach_effective_tenure`) + `CoachSubscriptionEvent` mirror logic per §5.3.
4. **Composite expression evaluator** + AST + advisory-lock integration with the existing engine.
5. **Tenure cron** (§5.1) + handlers for each `RewardKind` (dispatcher functions per kind, behind a feature flag `retention_v1`).
6. **Lead-grant attribution** (§5.4) — new `LeadAllocation` table writes + the funnel's signup tagging.
7. **Top Performer cron** (§5.5) + leaderboard mirror.
8. **Tier-overlap policy evaluator** (§2.5) + notification template wiring.
9. **Year One milestone + activity marker** (§6.5) — depends on Wave 4 cohort feed only if Track 3 is in scope; Year One itself is independent.
10. **Admin console surfaces** for OWNER curation: RewardCatalog editor, RewardOverlapPolicy editor, JoiningIncentive editor, `act:reward_revoke` / `act:year_one_moderation` capability rows.

**Feature-flag gating:** every grant write checks `feature_flag('retention_v1')` and `feature_flag(\`retention_v1.\${kind}\`)`. Allows incremental rollout per reward kind. The engine schema is loadable in production with all flags off; nothing fires.

---

## 12. Senior engineer onboarding checklist

A new senior engineer joining this work should be able to:

- [ ] Read `retention-progression-system.md` and this doc end-to-end (~2 hours).
- [ ] Cross-reference `sub-coach-hierarchy.md` for org-rolled-up MRR semantics.
- [ ] Cross-reference `data-tracking-contract.md` for `active_client` definition + PostHog bucketing rules (no raw revenue / no PII to PostHog).
- [ ] Run `prisma migrate diff` against the documented schema deltas in §3 to see exactly what changes.
- [ ] Re-derive the composite expression AST in §2.4 from the achievement requirements in §2.2 — they should match line-for-line.
- [ ] Identify the 8 deferred decisions in §7 and confirm none of them block the Day-1 commit sequence in §11.
- [ ] Verify the doctrine alignment with `retention-progression-system.md` §7.1 (no streak counters surfaced to UI; no social-reaction primitives) — note where this doc says "Consistency track uses streaks internally but does not surface them" (§6.1).
- [ ] Read the failure modes in §9 and trace each one to the schema constraint or runtime guard that prevents it.
- [ ] Confirm performance budgets in §10 are achievable on the existing Postgres + Redis topology — no new infra required for the 100/1000 columns; the 10000 column requires the partitioning called out.

If any of the above takes more than the time budget implied, the doc is wrong and should be revised before code lands.

---

## 13. Audit contract

Every state transition in §4 writes an append-only audit row per the platform's audit contract (`docs/audit-and-gdpr.md`). The audit actions:

- `reward.granted` — actor: `'system' | <admin_user_id>`; payload: `{ reward_grant_id, catalog_id, source }`
- `reward.delivered` — actor: `'system'`; payload: `{ reward_grant_id, dispatcher_artifact }`
- `reward.redeemed` — actor: `<user_id>`; payload: `{ reward_grant_id, redemption_evidence }`
- `reward.expired` — actor: `'system'`; payload: `{ reward_grant_id, expired_at }`
- `reward.revoked` — actor: `<admin_user_id>`; payload: `{ reward_grant_id, reason }`
- `reward.dispatch_failed` — actor: `'system'`; payload: `{ reward_grant_id, retries, last_error_summary }`
- `reward.policy_resolved` — actor: `'system'`; payload: `{ achievement_milestone_id, pricing_tier_at_grant, resolved_catalog_id }` (the §2.5 policy evaluation)

Audit rows are NEVER deleted. PII inside `payload` is HMAC-hashed per `data-tracking-contract.md`.

---

## 14. PostHog telemetry

Per `data-tracking-contract.md` doctrine — no raw revenue, no PII, no body text:

- `reward.granted.coach.tenure_m{n}` — properties: `tenure_milestone_id`, `pricing_tier_bucket` (`os_only` / `team` / `white_glove`), no revenue numbers.
- `reward.granted.coach.achievement` — properties: `milestone_id` (e.g. `coach.ach_authority`), `pricing_tier_bucket`, `mrr_bucket` (`under_5k` / `5k_25k` / `25k_plus`).
- `reward.redeemed.{kind}` — properties: `kind`, `time_to_redeem_bucket` (`<24h` / `<7d` / `<30d` / `>30d`).
- `reward.policy_overlap_taste_offered` — properties: `pricing_tier_bucket`, `achievement_id`, `outcome_bucket` (`upsell_clicked` / `upsell_ignored` / `pending`).
- `reward.year_one_golden_ticket_redeemed` — properties: `retreat_year`, no client identifiers beyond hashed user id.

**No reward-grant payload (e.g. lead-allocation lists, mastermind cohort labels, lock terms) is shipped to PostHog.** The audit table is the source of truth.

---

## 15. Versioning

`RewardCatalog.payload_schema_version` is the per-row version stamp. Bumping a payload schema requires:

1. A new version of the `RewardCatalog` row written under a new `id` (e.g. `coach.tenure_m6.mastermind_seat.v2`).
2. The previous `id` is `retired_at`-stamped but not deleted.
3. New grants write against the new `id`; old grants retain their original payload + `payload_schema_version`.

This is the same pattern as the engine's milestone deprecation rule (`retention-progression-system.md` §3.1: removing a milestone is not allowed; deprecating one is).

---

## 16. Glossary

| Term | Definition |
|---|---|
| **Tenure clock** | Cumulative days a coach has been on an active or past-due subscription. Pauses on cancel/pause; resumes on reactivation. Computed via `coach_effective_tenure` materialised view. |
| **Activity marker** (Year One) | The threshold defined in §7 Open question 5; intended as: active in 4 of the last 8 weeks at the moment of the 365-day milestone. |
| **Composite milestone** | A milestone that fires when a discriminated-union AST expression evaluates true. Engine extension introduced in this doc (§2.4). |
| **Reward overlap policy** | The rule that resolves which reward catalog id fires when an achievement milestone overlaps with a coach's pricing tier. §2.5. |
| **Tier-overlap "taste"** | The brief, generous experience of a higher-tier perk granted to a coach who has earned it via achievement but not paid for it. Designed as a soft upsell. |
| **Golden ticket** | The cross-coach Year One reward — a gated invitation to buy a seat at a Year One member rate to a TGP retreat. §6.5. |
| **Active client** | Defined in `data-tracking-contract.md`; matches the engine's existing definition for `coach.first_25_active_clients`. |
| **Year One private chat** | The single cross-coach channel in the client experience. Status only, OWNER-moderated. §6.5. |

---

## 17. What this doc does NOT cover

- The runtime implementation (this is a spec PR; runtime lives in a separate PR).
- The notification template copy (lives in `notification_template` rows; OWNER-drafted).
- The visual design of badges (lives in `docs/QUIET_LUXURY_DOCTRINE.md`).
- The retreat operational planning (venue, agenda, logistics — outside engineering scope).
- The funnel architecture for the lead-grant program (lives in marketing infra; engineering only consumes attribution events).
- The legal terms of the lifetime pricing lock (`lock_terms_md` is drafted by counsel, not engineering).
- The Charter Members curation criteria (OWNER-only; deliberately opaque per `retention-progression-system.md` §9).

---
