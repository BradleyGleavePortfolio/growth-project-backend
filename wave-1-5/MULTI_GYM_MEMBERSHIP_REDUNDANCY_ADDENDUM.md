# Multi-Gym Membership — Redundancy & Data-Integrity Addendum (B-Q3 follow-up)

**Status:** ADDENDUM TO PLAN B Section 4 — adopted before any schema lands
**Trigger:** User concern on the GymMembership join table — "I DON'T want per-location data tripping up over clients at other locations / going to multiple locations — redundancy logistics need to be handled before our enterprise-level data becomes untrustworthy"

---

## 1. The concern, restated

Sarah trains at Bellevue 6 months. Then also joins Kirkland.

Naïve join-table outcome:
- Bellevue's owner dashboard says: "1,247 members, $X MRR, Sarah is one of them"
- Kirkland's owner dashboard says: "892 members, $Y MRR, Sarah is one of them"
- Sarah counted TWICE in any cross-gym roll-up (e.g. corporate wellness aggregator, R82 marketplace, future franchise dashboard)
- Sarah's workouts/checkins exist ONCE on her account — which gym's metrics do they accrue to?
- Coach Alice (Bellevue) and Coach Bob (Kirkland) both write programs for Sarah — whose program is canonical? Whose comp does Sarah's revenue accrue to?
- Sarah pays Bellevue $200/mo AND Kirkland $150/mo — two `ClientPurchase` rows, two `entitlement_active` lines. Coach Alice can see her workouts; can Coach Bob also see them? Should he?

If we ship the bare GymMembership join without rules, every metric we surface is wrong the moment Sarah signs up at gym #2.

---

## 2. Hyperscaler reality-check

How does Stripe / Linear / Notion / Mindbody actually handle this?

**Stripe Customer:** A single Customer can exist on multiple Connected Accounts. Each account sees ONLY the charges that flowed through it. Stripe never auto-merges the customer's analytics across accounts. The Customer object is shared (one email, one name), but **revenue, activity, and behavior are accountscoped** — Account A never sees Account B's data, never counts Account B's charges in its KPIs.

**Linear Workspace membership:** A user can be in multiple workspaces. Each workspace sees only the issues, comments, and activity *within that workspace*. Issues are workspace-scoped, not user-scoped. Cross-workspace identity is purely "same human" — no data crossover.

**Notion Workspace membership:** Same pattern. User can be in 10 workspaces. Each workspace has its own page tree, its own analytics, its own audit log. The user's identity is shared (avatar, display name); their *contributions* are scoped to the workspace they made them in.

**Mindbody (the closest comp — multi-location fitness):** Mindbody distinguishes between (a) **the Client identity** (shared profile, contact info, waivers) and (b) **the Client Relationship per location** (memberships, visits, billing, instructor relationships, retention metrics — all per-location). A client at two studios shows up in both studios' rosters AND in both studios' retention reports — but each studio's MRR/visits/retention only reflects activity *at that studio*. Mindbody never double-counts revenue at the chain level; it provides a separate "Enterprise" rollup view that explicitly de-duplicates.

**ClassPass (cross-studio aggregator):** Identity is global. Visits, ratings, and revenue are visit-scoped to the studio where the visit occurred. The aggregator computes its own metrics from the union; individual studios see only their own slice.

**Unanimous pattern:** Identity is shared. **Activity, revenue, programs, and metrics are scoped to the relationship, not the person.**

That is the rule we will enforce.

---

## 3. The rules (binding before schema lands)

### Rule 1 — Membership is the relationship, not the person

Every piece of activity, revenue, program, comp, and metric attaches to a `GymMembership` row (the relationship), not to a `Client` row (the person). The Client is shared; the relationships are independent.

### Rule 2 — `ClientPurchase` MUST carry `gymId`

`ClientPurchase` already exists. We add a non-null `gymId` foreign key (matching the gym the purchase was scoped to at checkout — derived from the package's owning gym). Migration backfills: every existing `ClientPurchase` gets the `gymId` of the package it was attached to.

Consequence: `ClientActivitySummary`, `GymFinancialAggregate`, `CoachBusinessMetric` all aggregate on `gymId` — Sarah's Bellevue purchase only counts in Bellevue's KPIs. Sarah's Kirkland purchase only counts in Kirkland's KPIs. Never both.

### Rule 3 — Workouts, check-ins, and content unlocks are scoped via `ClientPurchase.gymId`

Sarah owns ONE workout history on her account. But each workout/checkin row carries a `sourcePurchaseId` (the `ClientPurchase` that gated the content). Roll-ups for Bellevue's owner filter to `purchase.gymId = bellevue_id`. For Sarah personally, she sees the union (her full history). For Coach Alice, she sees only workouts Sarah completed under a Bellevue purchase. For Coach Bob, only workouts under a Kirkland purchase.

### Rule 4 — Coach assignment is per-membership, NEVER global

`ClientCoachAssignment` carries `gymMembershipId`, not just `clientId`. Coach Alice is Sarah's coach at Bellevue. Coach Bob is Sarah's coach at Kirkland. Neither sees the other's programming or messages. Sarah sees both inside her single app, clearly labeled by gym.

### Rule 5 — Roman drafts are per-membership

If Bellevue fires Coach Alice, the termination cascade (B-Q4-followup) generates Roman drafts only for Sarah's *Bellevue* relationship. Her Kirkland relationship is untouched. The cascade query is `WHERE gymMembershipId IN (assignments under fired coach AT this gym)`.

### Rule 6 — Enterprise rollups are explicitly de-duplicated

If a future R82 wave ships a "franchise" or "corporate" multi-gym dashboard, it MUST use one of:
  - `COUNT(DISTINCT clientId)` for unique-human counts
  - `SUM(revenue) GROUP BY gymId` for non-double-counted revenue
  - Explicit "Unique members across N gyms: X" vs "Total memberships: Y" labels — never collapsed into one number without explicit naming

This is enforced by the evaluator: any KPI surfaced to a gym_owner is scoped by `gymId IN (their owned gyms)` AND aggregated per-gym, never collapsed.

### Rule 7 — Conflicting writes are forbidden

If Coach Alice (Bellevue) and Coach Bob (Kirkland) both try to assign Sarah a "Push Day" program on the same calendar date, both can — they're two separate `ProgramAssignment` rows, each scoped to their own `gymMembershipId`. Sarah's app shows BOTH ("From Bellevue · Coach Alice" and "From Kirkland · Coach Bob"), labeled. No single canonical "the program" — programs are membership-scoped, just like everything else.

### Rule 8 — Workout completion attribution

When Sarah completes a workout, the app asks (or infers from the program's `gymMembershipId`) which membership it was completed under. That workout row carries `gymMembershipId`. Revenue/retention/engagement metrics attribute to that gym only. If she completes a workout that wasn't from either gym's program (her own freelancing), it carries `gymMembershipId = NULL` and rolls up only into her personal history.

### Rule 9 — Lapsed/churned definitions are per-membership

C-Q4 defined lapsed=7d no logs, churned=payment lockout (day 10). These signals are computed per `gymMembershipId`. Sarah can be "lapsed at Bellevue, active at Kirkland." Each gym's dashboard reflects only their own relationship.

### Rule 10 — RLS enforces all of the above

A gym_owner's RLS predicate is `gymId IN (SELECT gymId FROM GymOwnerGym WHERE ownerId = auth.uid())`. Every table that surfaces to owners carries `gymId` or a foreign-keyable path to `gymId`. There is no path by which Bellevue's owner can read a row that originated from Sarah's Kirkland relationship. Tested by T_RLS_* suite (Plan B §6).

---

## 4. Schema deltas required vs. Plan B as drafted

| Plan B as drafted | Addendum requires |
|---|---|
| `GymMembership(id, gymId, clientId, joinedAt, status)` | Same |
| `ClientPurchase` (existing) | **ADD** `gymId NOT NULL` FK + backfill migration |
| `ClientActivitySummary` (planned) | Carries `gymId`, computed per-membership |
| `CoachBusinessMetric` (planned) | Carries `gymId`, computed per (gym × coach) |
| `GymFinancialAggregate` (planned) | Per-gym only, never cross-gym sum |
| `ClientCoachAssignment` (existing or new) | Carries `gymMembershipId`, not just `clientId` |
| `ProgramAssignment` (existing) | Carries `gymMembershipId` |
| `WorkoutCompletion` (existing) | **ADD** nullable `gymMembershipId` + UI/inference rule |
| `Cohort` (planned) | Per-gym (Cohort.gymId NOT NULL) |
| `Tag` (planned) | Per-gym (Tag.gymId NOT NULL) — gym-scoped vocabularies |
| Enterprise rollup queries | MUST de-duplicate explicitly (rules in §3.6) |

---

## 5. UX consequences (coach/client POV)

**Sarah (client) — at two gyms:**
- Her app shows TWO program tracks side by side, each labeled with the gym name and coach name
- Her workout calendar is unified (she sees all sessions in one timeline) but each session has a quiet gym chip
- Her "Coaches" tab shows Alice (Bellevue) and Bob (Kirkland) as separate cards
- Billing tab shows two recurring charges, two packages, two entitlement statuses
- Her data privacy promise: "What you do under one gym's program is visible only to that gym's coach and owner. Your full personal history is yours alone."

**Coach Alice (Bellevue) — Sarah is one of her clients:**
- Sarah appears in Alice's roster with a small "Also at Kirkland" indicator (yes/no — see §6 below)
- Alice sees Sarah's workouts/checkins/notes ONLY for Bellevue-scoped activity
- Alice's retention metrics for Sarah only count Bellevue activity
- Alice never sees Bob's programming, notes, or messages for Sarah

**Owner Roman (Bellevue) — Sarah is one of his members:**
- Sarah appears in Bellevue's member count (1 of 1,247)
- Sarah's MRR contribution to Bellevue = Bellevue's package price only
- If a future franchise dashboard exists, it shows "1,247 Bellevue members + 892 Kirkland members = 2,001 total memberships across 2 gyms (1,847 unique humans)" — never collapsed

---

## 6. One open sub-question (lock now)

**Sub-Q: Should Coach Alice see "Sarah is also at Kirkland"?**

**Options:**
- **(a) Hidden** — Sarah at Kirkland is invisible to Alice/Bellevue. Cleanest privacy. Mindbody's default.
- **(b) Visible chip, no detail** — Alice sees "Also a member at 1 other gym" with no name. Lets Alice know not to be territorial / not to assume Sarah's history is solely Bellevue's. Matches Linear's "shared with other workspaces" pattern.
- **(c) Visible name + gym, no data** — Alice sees "Also a member at Kirkland Fitness, coached by Coach Bob." Full transparency, zero data leakage.

**Recommendation: (a) Hidden.** Coach-to-coach data crossover is a privacy minefield. If Sarah wants Alice to know, she'll tell her. Mindbody's default. Quiet Luxury default.

**Locking (a)** unless user overrides.

---

## 7. Rollup integrity tests (must pass before any owner dashboard ships)

**T_ROLLUP_1:** Insert Sarah with memberships at gym A (purchase $200) and gym B (purchase $150). Assert gym A dashboard MRR includes $200, NOT $350. Assert gym B dashboard MRR includes $150, NOT $350.

**T_ROLLUP_2:** Sarah completes 10 workouts under A's program, 5 under B's program, 2 freelance (NULL membership). Assert A dashboard shows 10 workouts for Sarah. B shows 5. Sarah's personal history shows 17.

**T_ROLLUP_3:** Coach Alice (gym A) is fired. Termination cascade fires. Assert Sarah's gym A relationship is reassigned. Assert Sarah's gym B relationship with Coach Bob is untouched. Assert Alice loses access to Sarah's gym-A workouts within 1s.

**T_ROLLUP_4:** Sarah goes lapsed at gym A (no logs 7d) but is active at gym B. Assert gym A's lapsed-cohort includes Sarah. Assert gym B's lapsed-cohort does NOT.

**T_ROLLUP_5:** Future enterprise dashboard (mock) tries to compute "total members across franchise." Assert query uses `COUNT(DISTINCT clientId)` not `COUNT(*)` over `GymMembership`. Linting rule blocks naive `COUNT(*)`.

**T_ROLLUP_6:** Cohort defined at gym A ("Sarah, Bob, Carol") cannot be referenced by gym B. RLS denies cross-gym Cohort reads. Tag vocabulary at gym A is isolated from gym B.

---

## 8. Where this lands in build order

This addendum modifies **PR #3 (Schema + RLS migration)** specifically:
- `GymMembership` ships as drafted
- `ClientPurchase.gymId` migration added to PR #3
- All planned tables that surface to owners get `gymId` columns
- All planned coach-assignment / program-assignment tables get `gymMembershipId`
- `WorkoutCompletion.gymMembershipId` migration added (nullable)
- Cohort.gymId, Tag.gymId NOT NULL

And modifies **PR #4 (RLS live-DB test suite)**:
- Adds T_ROLLUP_1 through T_ROLLUP_6
- Adds RLS tests for cross-gym leakage of every owner-surfaced table

And modifies **PR #7 (Aggregation jobs)**:
- Every aggregation query MUST `GROUP BY gymId` and JOIN to enforce gym scoping
- Linting rule (custom ESLint or SQL fitness function) blocks aggregations over `Membership` / `Purchase` without `gymId` in GROUP BY
- Code review checklist item: "Does this rollup correctly attribute when the same client is at two gyms?"

---

## 9. Summary

**Sarah is one human with two relationships.** Every byte of data that any gym owner or coach sees attaches to the *relationship*, not to Sarah. Identity is shared; activity, revenue, programs, and metrics are scoped. This is how Mindbody, Stripe, Linear, and Notion all do it.

The bare GymMembership join table from B-Q3 alone would be insufficient. With rules §3.1–§3.10 and schema deltas §4 enforced, enterprise-grade trustworthiness is restored.

**Status: LOCKED, ADOPTED INTO PLAN B BEFORE PR #3 LANDS.**
