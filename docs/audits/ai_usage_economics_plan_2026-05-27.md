# AI Usage Economics — Canonical Plan

**Date:** 2026-05-27 (operator override applied 2026-05-28)
**Author:** Dynasia G
**Status:** Locked — drives all upcoming AI-bug-sweep PRs (AI-1 through AI-5) and the Credits follow-up PRs (Credits-1, Credits-2-Mobile, Credits-3-Admin).
**Supersedes:** Any earlier scratch numbers in chat. The locked numbers in `canonical_docs/STREAM_1_AI_CREDITS_SPEC.md` are authoritative.

---

## 2026-05-28 OPERATOR OVERRIDE (LOCKED — supersedes any older number in this doc)

| Knob | Old (this doc, 2026-05-27) | **NEW — LOCKED 2026-05-28** |
|---|---|---|
| Hard actual ceiling | $40 / coach / month | **$40 / coach / month** (unchanged) |
| Value multiplier | 5.0× | **3.125×** |
| Displayed allowance | $200 | **$125** |
| Credit pack tiers | $25 / $50 / $99 / Custom | **$10 / $25 / $99 / Custom** |
| Custom pack bounds | min $10, max $500 | **min $10, max $500** (unchanged) |
| TGP gross margin per pack | ~80% | **68%** (= 1 − 1/3.125) |
| `COACH_AI_MAX_ACTUAL_CENTS` | 4000 | **4000** (unchanged) |
| `COACH_AI_VALUE_MULTIPLIER` | 5.0 | **3.125** |

The prose/margin math below uses the pre-override 5.0× / $200 numbers. Treat
every appearance of "5×", "$200", "$50 pack", or "80% margin" in the body of
this doc as historical context — the override above is what we ship.

---

This document consolidates every AI-cost / budget / credit-pack / dormancy decision made during the 2026-05-27 session. Companion docs:

- [`ai_credit_marketplace_2026-05-27.md`](./ai_credit_marketplace_2026-05-27.md) — Credit-pack marketplace spec (Stripe wiring, schema, API surface)
- [`issue_register_28_findings_2026-05-26.md`](./issue_register_28_findings_2026-05-26.md) Part 3 + PRODUCT-1/2 — Source bug findings
- [`bug_register_round3_open_hunt_2026-05-27.md`](./bug_register_round3_open_hunt_2026-05-27.md) — BUG-S3 (AIDraft GDPR omission)
- [`codebase_hygiene_findings.md`](./codebase_hygiene_findings.md) — PR sequencing rationale

---

## TL;DR — The Locked Numbers

| Lever | Value | Env var / file |
|---|---|---|
| **Base hard cap** | **$40 actual Anthropic spend / coach / month** (combined coach + ALL his clients) | `COACH_AI_MAX_ACTUAL_CENTS=4000` |
| **Value multiplier** | **3.125×** (was 5.0×) | `COACH_AI_VALUE_MULTIPLIER=3.125` |
| **Displayed allowance** | **$125 / coach / month** (was $200) | (computed: actual × multiplier) |
| **Credit-pack pricing** | **Face value — pay $X, get $X displayed credit** | (TGP cost = $X / 3.125) |
| **Available packs** | **$10 / $25 / $99 / Custom** (was $25 / $50 / $99 / Custom; min $10, max $500) | Stripe SKUs: `small` / `medium` / `large` / `custom` |
| **TGP margin on packs** | **68% gross** (was ~80%; = 1 − 1/3.125) | — |
| **Brief dormancy guard** | **Skip auto-generation if last 3 daily briefs went unread** | `CoachBrief.read_at` |
| **80% warn threshold** | Dynamic walkthrough → "Top up credits" CTA | `GET /coach/ai/budget` polled by mobile |
| **100% block behavior** | Hard pause until period rollover OR coach buys credit pack | 402 `AI_BUDGET_EXHAUSTED` |

---

## Why These Numbers — Margin Math At 2% Take Rate

TGP's revenue model: **2% of the coach's monthly processed Stripe volume.**
A coach running $5,000/mo through TGP → TGP earns **$100/coach/mo**, NOT $5,000.

### Cost stack per coach (combined envelope covers all of the below)

| Workload | Volume (typical) | $/call | Monthly $ |
|---|---|---|---|
| Coach daily brief (post-dormancy-guard, ~25/mo) | 25 | $0.024 | $0.60 |
| Coach manual generations (workout / meal plan / insight) | 80 | $0.035 | $2.80 |
| Weekly insight cron (30 clients × 4 weeks) | 120 | $0.018 | $2.16 |
| Student `/ai/chat` turns (30 clients × 2 turns/day × 30 days) | 1,800 | $0.011 | $19.80 |
| **Subtotal — typical engaged roster** | | | **~$25.36** |

At $100 revenue, ~$25 cost = **74.6% gross margin**.

### Stress case — power roster (30 clients × 5 chats/day)

- Student turns: 4,500/mo × $0.011 = **$49.50**
- + coach side: ~$5.56
- **Total: ~$55.06/mo cost vs $100 revenue = 44.9% margin → BELOW SaaS floor**

The $40 cap engages here. Coach hits the wall around day 24, sees the 80% walkthrough at day 19, and either:
1. **Buys a credit pack** ($50 pack adds $50 displayed / $10 actual cost). TGP nets $40/pack → margin recovers to ~74%.
2. **Lets it ride** until period rollover at midnight UTC on the 1st of the next month.

### Adversarial case — one student in a reconnect loop

- 2,880 turns/day × 30 days × $0.011 = **$950/coach/mo from one bug**
- With the $40 cap: capped at $40 of cost. **Saves ~$910/coach/mo worst case.**

### Pricing model — why face-value credit packs

The base $40 allowance gives coaches a **5× headroom subsidy** ($40 actual → $200 displayed). That's a deliberate onboarding gift to make the platform feel generous.

Credit packs go the other way: **the coach pays face value, the multiplier subsidy is removed**. A $50 pack adds exactly $50 of displayed credit (= $10 of actual cost) → **80% TGP gross margin per pack**.

The mental model exposed to the coach is dead simple: **"$50 buys $50 more AI."** No multiplier math, no fine print. The asymmetry between the base subsidy and pack pricing is hidden behind the displayed-allowance abstraction.

---

## Combined Per-Coach Envelope — What's In It

A **single shared budget** covers ALL of the following on a per-coach basis:

1. **Coach manual generations** — `POST /coach/ai/programs` (workout), `/meal-plans`, `/insights`
2. **Coach daily brief** — auto-generated by `coach-brief.scheduler.ts` and on-demand via `getOrGenerateTodaysBrief()`
3. **Weekly insight cron** — `weekly-insight.cron.ts` running over all the coach's active clients
4. **Coach gateway calls** — `POST /ai/gateway/invoke`
5. **ALL students' `/ai/chat` turns** — every chat from every client of this coach charges back to the coach's envelope

**Rationale:** A coach with 30 students chatting all day costs the same per-call as a coach generating 80 workouts. They should share one ceiling. Splitting them creates two-bucket complexity for no real protection benefit.

**Edge case — sub-coach assignments:** When a head coach has sub-coaches, all of the head coach's clients' AI spend (regardless of which sub-coach owns them via `SubCoachAssignment`) deducts from the **head coach's** envelope. Head coach is the billing entity.

---

## Daily Brief Cost Optimisation — Dormancy Guard

**Decision (2026-05-27 12:47 PDT):** Keep proactive generation. Add ONE dormancy short-circuit:

- **Skip generation if previous 3 daily briefs went unread** (`CoachBrief.read_at IS NULL` for the 3 most recent prior `brief_date` rows).

When the guard engages, the brief is deferred to "tap-in mode" — the coach sees a "Generate today's brief" CTA when they open the coach home, and the brief is built on-demand. The push notification still fires (with generic copy: "Your brief is ready — tap to view"), but no Anthropic call is made until the coach actually taps.

Once the coach reads a brief, the next 3 days return to proactive generation. Three more unread → guard re-engages.

**Why this is the right shape:**
- Active coaches never see a UX regression (their briefs always pre-generate).
- Dormant coaches stop costing money but the feature still works on tap.
- It's symmetric and observable — `CoachBrief.read_at` is already in the schema; the guard is a single `WHERE` check.

**Rejected:** "Skip generation if `coach.last_login_at > 14 days ago`" — too coarse, would fire on coaches who use mobile-only and never trigger the web `last_login_at` write. Read-state on briefs is the right signal.

---

## API Surface — Built in PR AI-1

### `GET /coach/ai/budget`

```json
{
  "allowance_cents": 20000,
  "used_display_cents": 16000,
  "remaining_display_cents": 4000,
  "pct_used": 80,
  "period_end": "2026-06-01T00:00:00.000Z",
  "purchased_extras_cents": 0,
  "warn_threshold": 80,
  "block_threshold": 100,
  "base_actual_cap_cents": 4000,
  "value_multiplier": 5.0
}
```

The mobile client polls this every 60s while on Coach Home and renders progress UI at the warn/block thresholds.

### `checkCoachAIBudget(coach_id)` middleware

Runs before every chargeable AI call (manual gen, brief, weekly cron, student chat). Returns one of:

- `{ ok: true, pct_used }` — proceed with call
- `{ ok: true, pct_used, warn: true }` — proceed but signal mobile to render warn UI
- `{ ok: false, error: 'AI_BUDGET_EXHAUSTED' }` — caller throws 402

The check sums `AICallLog.costCents` where `coach_id = X AND created_at BETWEEN period_start AND period_end`, multiplied by `value_multiplier`, against the `base + purchased` allowance.

### Period rollover

Cron runs at UTC 00:00 on the 1st of each month:
1. Archive period totals to `CoachAIBudgetHistory` (for analytics + dispute resolution).
2. Reset `consumed_actual_cents = 0`.
3. Reset `purchased_actual_cents = 0` for one-shot packs (recurring packs replenish via Stripe webhook).
4. Bump `period_start` and `period_end`.

---

## Threshold UI Behavior — Built in Credits-2-Mobile

| % Used | UI Surface | Copy | CTA |
|---|---|---|---|
| <60% | None | — | — |
| 60–79% | Subtle progress chip on Coach Home header | "AI Usage: $X / $200" | (none) |
| **80–94%** | **Walkthrough card with tactile entry animation** | **"You and your clients have used 80% of this month's $200 AI allowance. Top up to keep your team's AI features running smoothly."** | **[Buy Credits]** |
| 95–99% | Persistent banner + 1× push notification | "Last 10% of AI allowance remaining — top up now to avoid downtime." | [Buy Credits] |
| 100% | Full-screen modal on next AI action | "Allowance hit. AI generations and client chats pause until midnight UTC on the 1st OR top up now." | [Buy Credits] [See Schedule] |

The **80% walkthrough** is the marquee Stillwater-Standard moment — tactile feedback on the progress bar, smooth cutscene transition explaining the shared coach+client envelope, single primary action button.

The 95% banner is the only push notification this system fires — designed to land in the coach's lock screen during their commute or evening wind-down so they top up before downtime.

---

## PR Sequencing — Single-Track Execution

Per session rule (2026-05-27): **No parallel work touching AI code.** PRs ship sequentially, each gets Opus exhaustive audit, must hit CLEAN (CI GREEN + zero P0/P1/P2) before the next opens.

| # | PR | Findings | Status |
|---|---|---|---|
| **AI-3** | feat: approval-loop capability materialiser | PRODUCT-1 (P0 silent failure) | 🔄 In flight |
| **AI-1** | feat: combined coach+client spend envelope + GatewayInvokeDto + ChatMessageDto + cron caps + brief unread-guard + `GET /coach/ai/budget` | A1, A2, A6, A9 + PRODUCT-2 FM2 + dormancy guard | Queued |
| **AI-2** | feat: prompt-injection hardening + named throttle buckets + opaque `ai_engine` field + `/ai/context` throttle | A3, A5, A7, A8 | Queued |
| **AI-4** | feat: brief numeric reconciliation + cursor pagination on brief history + `generated_at` surfaced in response | A4 + PRODUCT-2 FM1 + PRODUCT-2 FM3 | Queued |
| **AI-5** | feat: GDPR export — add `AIDraft` (+ other BUG-S3 models TBD: `Bloodwork`, `ClientPurchase`, `ClientSession`, etc.) | BUG-S3 (GDPR-AIDraft) | Queued |
| **Credits-1** | feat: AI credit packs — Stripe products + checkout endpoints + webhook handler + period rollover cron | `ai_credit_marketplace_2026-05-27.md` | Follow-up after AI-5 |
| **Credits-2-Mobile** | feat: 80% walkthrough + progress chip + top-up flow in mobile app | `ai_credit_marketplace_2026-05-27.md` | Follow-up after Credits-1 |
| **Credits-3-Admin** | feat: credit-pack admin dashboard (sales, refunds, grant-free-credits override) | `ai_credit_marketplace_2026-05-27.md` | Follow-up |

---

## Schema Additions — Built in PR AI-1 + Credits-1

```prisma
model CoachAIBudget {
  id                       String   @id @default(cuid())
  coach_id                 String   @unique
  period_start             DateTime @db.Date
  period_end               DateTime @db.Date

  // Base allowance — set from env at period start
  base_actual_cents        Int      @default(4000)   // 4000 = $40

  // Purchased headroom from credit packs. Reset to 0 at rollover
  // for one-shot packs. Recurring packs replenish via Stripe webhook.
  purchased_actual_cents   Int      @default(0)

  // Running total of actual Anthropic spend this period — read by
  // checkCoachAIBudget(coach_id) before every gen call.
  consumed_actual_cents    Int      @default(0)

  // Multiplier used to compute displayed allowance from actual ceiling.
  value_multiplier         Float    @default(5.0)

  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  @@index([period_end])
}

model CoachAIBudgetHistory {
  id                       String   @id @default(cuid())
  coach_id                 String
  period_start             DateTime @db.Date
  period_end               DateTime @db.Date
  base_actual_cents        Int
  purchased_actual_cents   Int
  consumed_actual_cents    Int
  value_multiplier         Float
  archived_at              DateTime @default(now())

  @@index([coach_id, period_start])
}

model CoachCreditPackPurchase {
  id                       String   @id @default(cuid())
  coach_id                 String
  stripe_invoice_id        String   @unique
  pack_sku                 String   // 'small' | 'medium' | 'large' | 'custom'
  price_paid_cents         Int      // 2500 | 5000 | 9900 | custom (1000–50000)
  actual_headroom_cents    Int      // price_paid_cents / 5
  display_added_cents      Int      // == price_paid_cents (face value)
  is_recurring             Boolean
  applied_to_period        DateTime @db.Date
  created_at               DateTime @default(now())

  @@index([coach_id, applied_to_period])
}
```

---

## Open Decisions Deferred to Future Sessions

| Question | Default | Defer until |
|---|---|---|
| Should sub-coaches share head coach's envelope? | **Share** (head coach pays) | First sub-coach billing complaint |
| Free trial credits at onboarding? | **$5 actual / $25 displayed for first 30 days** | Credits-1 build |
| Should unused base allowance roll over? | **Expire** (protects against revenue cliffs) | First 90 days of usage data |
| Annual credit-pack discounts? | None at launch | After 90 days of pack sales data |
| Per-tier multiplier overrides (Pro / Elite plans)? | **Single 5× for all tiers at launch** | After product team finalises tier-to-feature mapping |

---

## Audit-Doc Cross-References

| Finding | Source Doc | Section |
|---|---|---|
| A1 — Gateway DTO size limits | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A2 — Per-coach spend cap (THIS doc's core) | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A3 — `conversation_history` sanitiser | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A4 — Brief history cursor pagination | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A5 — Named throttle buckets | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A6 — `/ai/chat` DTO + token estimation | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A7 — Opaque `ai_engine` field | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A8 — `/ai/context` throttle + cache | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| A9 — Chat history `role` validation | `issue_register_28_findings_2026-05-26.md` | Part 3 |
| PRODUCT-1 — Approval-loop materialiser | `issue_register_28_findings_2026-05-26.md` | PRODUCT-1 |
| PRODUCT-2 FM1/FM2/FM3 — Brief reconciliation + cron cap + staleness | `issue_register_28_findings_2026-05-26.md` | PRODUCT-2 |
| BUG-S3 — GDPR export missing AIDraft | `bug_register_round3_open_hunt_2026-05-27.md` | BUG-S3 |
| Credit-pack marketplace | `ai_credit_marketplace_2026-05-27.md` | (this companion doc) |
