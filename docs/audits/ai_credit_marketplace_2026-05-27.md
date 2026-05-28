# AI Credit Marketplace — Per-Coach Cap + Paid Credit Packs

**Date:** 2026-05-27 (operator override applied 2026-05-28)
**Author:** Dynasia G
**Status:** Specification — awaiting build PR
**Sequencing:** Builds on PR AI-1 (per-coach budget envelope). Treat this doc as the "buy more credits" follow-up audit referenced by `ai_bugs_sweep_plan.md`.

---

## 2026-05-28 OPERATOR OVERRIDE (LOCKED — supersedes any older number in this doc)

| Knob | Old (this doc, 2026-05-27) | **NEW — LOCKED 2026-05-28** |
|---|---|---|
| Value multiplier | 5.0× | **3.125×** |
| Displayed allowance | $200 | **$125** |
| Credit pack tiers | $25 / $50 / $99 / Custom | **$10 / $25 / $99 / Custom** |
| TGP gross margin per pack | ~80% | **68%** (= 1 − 1/3.125) |
| `COACH_AI_VALUE_MULTIPLIER` | 5.0 | **3.125** |

Authoritative spec: `canonical_docs/STREAM_1_AI_CREDITS_SPEC.md`. The prose
below that references "5×", "$200", "$50 pack", or "80% margin" is
historical context — the override above is what we ship.

---

---

## Why This Exists

PR AI-1 introduces a single combined per-coach AI budget envelope that covers BOTH the coach's manual generations AND all of his clients' `/ai/chat` usage. The cap protects TGP's gross margin under the 2% revenue-share model (TGP takes 2% of the coach's monthly processed revenue).

Without a cap, a single client in a reconnect loop (or a malicious chat replay attack) could burn ~$950/coach/mo on Anthropic spend against ~$100 of TGP revenue — a catastrophic loss.

With a fixed cap alone, engaged power coaches with chatty rosters get throttled and the product feels broken. The credit-pack marketplace closes the loop: heavy users PAY for the headroom they consume, the cap-hit moment becomes a revenue event rather than a churn risk.

---

## Margin Math at 2% Take Rate

| Coach revenue (monthly processed) | TGP revenue (2%) | Default cap | Actual cost worst case | Gross margin |
|---|---|---|---|---|
| $5,000 | $100 | $40 | $40 | $60 / 60% |
| $5,000 | $100 | $40 (no cap) | ~$55 | $45 / 45% |
| $5,000 | $100 | $40 (adversarial loop) | ~$950 | -$850 / -850% |

**Target floor:** 60% gross margin at the default cap. Paid credit packs sit above this.

---

## Default Cap (Built in PR AI-1)

- **Hard cap actual Anthropic spend:** **$40 / coach / month** (combined coach + all his clients)
- **VALUE_MULTIPLIER:** **3.125×** (operator override 2026-05-28; was 5.0×)
- **Displayed allowance to coach:** **$125 / month** (operator override 2026-05-28; was $200)
- **Env vars:**
  - `COACH_AI_MAX_ACTUAL_CENTS=4000`
  - `COACH_AI_VALUE_MULTIPLIER=3.125`

The cap is server-side. The displayed value is what the coach sees. The displayed value never exceeds the multiplied actual.

---

## Dynamic Warning UI (Built into Mobile)

The mobile client polls `GET /coach/ai/budget` and displays an in-app banner / walkthrough at three thresholds:

| Threshold | UI | Message |
|---|---|---|
| **60% used** | Subtle progress chip on Coach Home | "AI Usage: 60%" (no CTA) |
| **80% used** | Walkthrough card with tactile entry animation | "You and your clients have used 80% of this month's $200 AI allowance. Top up to keep your team's AI features running smoothly." [Buy Credits] |
| **95% used** | Persistent banner + push notification | "Last 10% remaining — top up now to avoid downtime." [Buy Credits] |
| **100% used** | Full-screen modal on next AI action | "Allowance hit. AI generations and client chats pause until midnight UTC on the 1st OR top up now." [Buy Credits] [See Schedule] |

The 80% walkthrough is the marquee Stillwater-Standard moment: tactile feedback on the progress bar, smooth cutscene transition explaining the shared coach+client envelope, single primary action button.

---

## Credit Packs (face-value pricing — you pay $X, you get $X displayed credit)

**Pricing model (locked 2026-05-27 12:53 PDT, per user direction):**
- Coach pays $X → Coach gets exactly $X added to displayed allowance.
- TGP's actual Anthropic cost = $X / 5 (multiplier baked into base subsidy is removed for packs).
- **TGP gross margin per pack: 80%** (before Stripe fees ~3% → effective ~77% net).

Stripe products defined as both one-shot and recurring options. Buyer = Coach (the head coach paying for the team).

| Pack | Coach pays | Displayed credit added | Actual headroom (TGP cost) | TGP margin | One-shot | Recurring |
|---|---|---|---|---|---|---|
| **Small** | $10 | +$10 displayed | +$3.20 actual | $6.80 / 68% | ✓ | ✓ |
| **Medium** | $25 | +$25 displayed | +$8.00 actual | $17.00 / 68% | ✓ | ✓ |
| **Large** | $99 | +$99 displayed | +$31.68 actual | $67.32 / 68% | ✓ | ✓ |
| **Custom** | $X (min $10, max $500) | +$X displayed | +$X/3.125 actual | 68% | ✓ | One-shot only |

**Mental model:** Coach sees "$50 buys $50 more AI" — no multiplier math exposed.

**Asymmetry note (for UI):** The base allowance gives coaches a 5× headroom subsidy ($40 actual = $200 displayed). Credit packs at face value give them 1× headroom ($50 = $50). That's deliberate — the base is a generous onboarding gift, packs are commercial pricing. Hide the multiplier math entirely from the coach. Display every credit-pack option as a single number per side ("$50 → $50 of AI").

---

## Schema Additions

```prisma
model CoachAIBudget {
  id                       String   @id @default(cuid())
  coach_id                 String   @unique
  period_start             DateTime @db.Date
  period_end               DateTime @db.Date

  // Base allowance — set from env at period start
  base_actual_cents        Int      @default(4000)   // 4000 = $40

  // Purchased headroom from credit packs. Reset to 0 at period rollover
  // for one-shot packs. Recurring packs replenish via Stripe webhook
  // on each successful invoice.
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

model CoachCreditPackPurchase {
  id                       String   @id @default(cuid())
  coach_id                 String
  stripe_invoice_id        String   @unique
  pack_sku                 String   // 'small' | 'medium' | 'large' | 'custom'
  price_paid_cents         Int      // 2500 | 5000 | 9900 | custom (1000– 50000)
  actual_headroom_cents    Int      // price_paid_cents / 5
  display_added_cents      Int      // == price_paid_cents (face value)
  is_recurring             Boolean
  applied_to_period        DateTime @db.Date
  created_at               DateTime @default(now())

  @@index([coach_id, applied_to_period])
}
```

---

## API Surface

### `GET /coach/ai/budget` (built in PR AI-1)
Returns:
```json
{
  "allowance_cents": 20000,
  "used_display_cents": 16000,
  "remaining_display_cents": 4000,
  "pct_used": 80,
  "period_end": "2026-06-01T00:00:00.000Z",
  "purchased_extras_cents": 0,
  "warn_threshold": 80,
  "block_threshold": 100
}
```

### `GET /coach/ai/packs` (new — credits marketplace)
Returns the four available pack SKUs with prices, headroom added, and Stripe price IDs.

### `POST /coach/ai/packs/:sku/checkout` (new)
Creates a Stripe Checkout Session for a one-shot pack purchase. Returns `{ url }`.

### `POST /coach/ai/packs/:sku/subscribe` (new)
Creates a Stripe Subscription line item for the recurring pack add-on. Returns `{ url }`.

### Stripe webhook handler (new)
`invoice.payment_succeeded` for credit-pack SKUs → write `CoachCreditPackPurchase` row + increment `CoachAIBudget.purchased_actual_cents`.

### Period rollover cron (new)
Runs at UTC 00:00 on the 1st of each month. For each `CoachAIBudget`:
1. Archive period totals to `CoachAIBudgetHistory`
2. Reset `consumed_actual_cents = 0`
3. Reset `purchased_actual_cents = 0` (one-shot packs expire)
4. Re-apply any active recurring pack additions for the new period
5. Bump `period_start` and `period_end`

---

## Implementation Sequencing

This doc is the spec. The implementation breaks into:

1. **PR AI-1 (current sweep)** — base envelope + `GET /coach/ai/budget` + cap enforcement. NO credit packs yet, NO Stripe wiring.
2. **PR Credits-1 (follow-up)** — `CoachCreditPackPurchase` table + Stripe products + checkout endpoints + webhook handler + period rollover cron.
3. **PR Credits-2-Mobile (follow-up)** — dynamic warning UI / 80% walkthrough / top-up flow in the mobile client.
4. **PR Credits-3-Admin (follow-up)** — admin dashboard for credit pack sales, refunds, grant-free-credits override.

---

## Open Questions for Future Sessions

- Should sub-coaches share the head coach's envelope or get their own? Default: **share** (head coach pays).
- Should there be a "free trial credits" grant when a coach onboards? Default: $5 actual / $25 displayed for first 30 days.
- Should unused base allowance roll over (vs. expire)? Default: **expire** to keep usage patterns honest and protect against revenue cliffs.
- Should we offer annual credit packs at a discount? Defer to product team after first 90 days of pack sales data.
