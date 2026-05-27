# AI Credit Marketplace — Per-Coach Cap + Paid Credit Packs

**Date:** 2026-05-27
**Author:** Dynasia G
**Status:** Specification — awaiting build PR
**Sequencing:** Builds on PR AI-1 (per-coach budget envelope). Treat this doc as the "buy more credits" follow-up audit referenced by `ai_bugs_sweep_plan.md`.

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
- **VALUE_MULTIPLIER:** **5.0×**
- **Displayed allowance to coach:** **$200 / month**
- **Env vars:**
  - `COACH_AI_MAX_ACTUAL_CENTS=4000`
  - `COACH_AI_VALUE_MULTIPLIER=5.0`

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

## Credit Packs

Stripe products defined as both one-shot and recurring options. Buyer = Coach (the head coach paying for the team).

| Pack | Price | Actual headroom added | Displayed | One-shot | Recurring |
|---|---|---|---|---|---|
| **Boost** | $19.99 | +$10 actual | +$50 displayed | ✓ | ✓ |
| **Pro** | $49.99 | +$20 actual | +$100 displayed | ✓ | ✓ |
| **Power** | $129.99 | +$50 actual | +$250 displayed | ✓ | ✓ |
| **Team** | $249.99 | +$100 actual | +$500 displayed | ✓ | ✓ |

Margin on credit packs: 50% gross (i.e. Pack price = 2× actual Anthropic ceiling added). Stripe fees (~3%) come off the top → ~47% effective margin per pack.

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
  pack_sku                 String   // 'boost' | 'pro' | 'power' | 'team'
  price_paid_cents         Int
  actual_headroom_cents    Int      // 1000 | 2000 | 5000 | 10000
  display_added_cents      Int      // 5000 | 10000 | 25000 | 50000
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
