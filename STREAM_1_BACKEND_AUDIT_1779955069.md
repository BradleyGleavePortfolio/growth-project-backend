# Stream 1 Backend Audit — 2026-05-28T07:57Z (unix 1779955069)

## Builder PR
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/296
Branch: `agent/builder/ai-credits-backend/80f07424`

## CI / Local verification
- `npm run build`: **PASS** (nest build clean)
- `npm run lint`: **PASS** (0 errors, 21 pre-existing warnings unrelated to this PR)
- `npm test` (Stream 1 specs): **44/44 passing** in `test/ai-credits-stream1.spec.ts` + `test/ai-credits-bankers-round.spec.ts`
- `npm test` (regression — `test/ai-gateway.service.spec.ts`, `test/billing/*`): **41/41 passing**, no regressions

## Verdict
**DIRTY** — 7 P0, 8 P1, 2 P2

The CI surface is green; the spec-compliance surface is not. The build and tests pass, but the tests largely substitute file-text grep for behavioural verification (T9, T10, T11, T13 in particular), several pieces of code are dead (DormancyGuardService), one piece of code violates its own DB constraint (`grantFreeCredits`), and the Stripe path mishandles tax. Parent should route to Fixer.

---

## P0 findings (BLOCKERS — must fix before merge)

### P0-1: `grantFreeCredits` violates the `CCPP_displayed_credit_eq_paid` CHECK constraint
- File: `src/ai-credits/coach-ai-budget.service.ts:350-365` + `prisma/migrations/20260528000000_stream1_coach_ai_credits/migration.sql:92`
- 50-Failures category: **#8 "Schema rigid"** + **#36 "Errors not codes"**
- Code:
    ```ts
    // service:
    const purchase = await tx.coachCreditPackPurchase.create({
      data: {
        coach_user_id: args.coachId,
        budget_id: budget.id,
        paid_cents: 0,                                  // ← always 0 for free grants
        displayed_credit_cents: args.displayedCents,    // ← non-zero by precondition
        ...
      },
    });
    ```
    ```sql
    -- migration:
    ADD CONSTRAINT "CCPP_displayed_credit_eq_paid" CHECK ("displayed_credit_cents" = "paid_cents"),
    ```
- Issue: The CHECK constraint requires `displayed_credit_cents = paid_cents` on every row. `grantFreeCredits` deliberately creates a row with `paid_cents=0, displayed_credit_cents=<positive>`. Postgres will reject the INSERT. The admin grant endpoint will return 500 on every call in production. Tests pass because the in-memory Prisma mock does not enforce CHECK constraints.
- Suggested fix: either (a) relax the CHECK to `displayed_credit_cents >= paid_cents` (allowing free grants as a documented special case), or (b) record free grants on a separate model (`CoachAiCreditGrant`) instead of `CoachCreditPackPurchase`. Pick (a) for least disruption; document the special case.

### P0-2: Webhook credits `amount_total` (tax-inclusive) instead of the tier amount → silent over/under-credit when Stripe Tax is active
- File: `src/ai-credits/coach-ai-credit-pack.service.ts:218-251`, `src/billing/stripe-api.service.ts:187`
- 50-Failures category: **#5 "Over-specification"** + **#36 "Errors not codes"** (financial-correctness)
- Code:
    ```ts
    // stripe-api.service.ts:
    'automatic_tax[enabled]': 'true',
    // coach-ai-credit-pack.service.ts handleStripeEvent:
    const amountTotal = obj.amount_total;
    ...
    const result = await this.budget.applyCreditPack({
      coachId: coachUserId,
      paidCents: amountTotal,         // ← post-tax total, not tier amount
      ...
    });
    ```
- Issue: `automatic_tax: true` is set on every Checkout Session. When a customer is in a taxable jurisdiction, Stripe adds tax and `amount_total` = `unit_amount + tax`. The webhook then credits the budget with `amount_total` (tax-inclusive). The pre-recorded `CoachCreditPackPurchase.paid_cents` was the tier amount (no tax). Result: `CoachAIBudget.pack_displayed_cents` diverges from `Σ CCPP.displayed_credit_cents` by the tax total. The mobile UI ("$25 buys $25 of AI") becomes a lie — a coach in California pays $27.06 and gets $27.06 of displayed credit, breaking the "face-value" promise that's the whole point of the operator override.
- Suggested fix: in `handleStripeEvent`, look up the matching CCPP row by `stripe_checkout_session_id` BEFORE calling `applyCreditPack`, and pass `paidCents: existing.paid_cents` (the tier amount we recorded at mint). Alternatively, drop `automatic_tax: true` for credit-pack sessions (B2B carve-out — tax not collected because we're not selling a taxable good in most jurisdictions). The B2B carve-out is mentioned in the mobile spec; backend should respect it.

### P0-3: `applyCreditPack` overwrites `CoachAIBudget.pack_displayed_cents` with webhook `amount_total`, leaving CCPP and budget rows inconsistent
- File: `src/ai-credits/coach-ai-budget.service.ts:300-306`
- 50-Failures category: **#28 "Race conditions"** (state-divergence variant)
- Code:
    ```ts
    await tx.coachAIBudget.update({
      where: { id: budget.id },
      data: {
        pack_paid_cents: { increment: args.paidCents },        // amount_total
        pack_displayed_cents: { increment: args.paidCents },   // amount_total
      },
    });
    ```
- Issue: same root as P0-2 — the budget is mutated using `args.paidCents` (from webhook), while the CCPP row still carries the originally-recorded `paid_cents` and `displayed_credit_cents` set at session-mint. The schema's `displayed_credit_cents = paid_cents` CHECK is satisfied on CCPP because applyCreditPack does NOT touch those fields. But the BUDGET diverges from the sum of CCPP rows. Refunds will pull the budget further out of sync.
- Suggested fix: pass `existing.paid_cents` (already loaded from CCPP) to the budget update, and also update CCPP.paid_cents/displayed_credit_cents if you intend to keep them aligned with the actual Stripe charge. Pick one source of truth.

### P0-4: DormancyGuardService is dead code — not wired into the weekly-insight cron
- File: `src/ai-credits/dormancy-guard.service.ts` (defined), `src/ai/coach/weekly-insight.cron.ts` (does NOT import it)
- 50-Failures category: **#2 "Skin-deep solutions"**
- Code: grep across the repo for callers of `shouldSkipCoach` returns only the service file and the test file. `weekly-insight.cron.ts` has no reference to dormancy.
- Issue: Spec §1 item 12 says "Dormancy-guard: weekly-insight cron skips coach if `CoachBrief.read_at` null for last 3 briefs (existing audit-doc rule, **must be live before cron caps activate** to prevent dormant-coach overspend)." The guard exists as an injectable service but no caller invokes it. The cost-protection rule the operator stipulated is not enforced in production.
- Suggested fix: inject `DormancyGuardService` into `WeeklyInsightCron` (or wherever the weekly-insight scheduler lives) and short-circuit per-coach iteration via `if (await dormancy.shouldSkipCoach(coachId)) continue;`. Mirror the same wiring in the coach-brief auto-generation path if applicable.

### P0-5: `CoachBrief.read_at` is added but never written → dormancy guard would skip every coach forever once 3 briefs accumulate (if it were wired)
- File: `src/ai-credits/dormancy-guard.service.ts:44-58`; no setter anywhere in `src/coach/brief/*` or `src/ai/coach/*`
- 50-Failures category: **#2 "Skin-deep solutions"** + **#8 "Schema rigid"**
- Code:
    ```sql
    -- migration: ADD COLUMN ... ALTER TABLE "CoachBrief" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);
    ```
    Search across `src/`: no `coachBrief.update({ ... read_at: ... })` or equivalent SQL ever sets the field.
- Issue: The dormancy guard reads `coachBrief.read_at` to decide skip. If/when the guard is wired (P0-4), it will see all `read_at = null` for any coach with ≥3 briefs and skip every coach forever — inverting the intent. A "compose a brief-read endpoint" item is missing.
- Suggested fix: add a brief-read endpoint (`POST /coach/brief/:id/read` or fold into the existing brief fetch path) that sets `read_at = now()` when the coach opens a brief. Tie the mobile client's brief render to call it. Add an integration test that exercises read → no-skip and unread × 3 → skip.

### P0-6: `applyCreditPack`'s nested `$transaction` runs OUTSIDE the dedup `$transaction` in `BillingService.handleEvent`
- File: `src/billing/billing.service.ts:198-211`, `src/ai-credits/coach-ai-budget.service.ts:266-322`
- 50-Failures category: **#28 "Race conditions"** + **#29 "Idempotency at API only"**
- Code:
    ```ts
    // billing.service.ts inside this.prisma.$transaction(async (tx) => { ... }):
    if (this.coachAiPacks) {
      const result = await this.coachAiPacks.handleStripeEvent(event);   // opens its OWN tx
      claimedByAiPack = !!result.claimed;
    }
    ```
    ```ts
    // coach-ai-budget.service.ts applyCreditPack uses this.prisma.$transaction NOT the parent tx:
    return this.prisma.$transaction(async (tx) => { ... });
    ```
- Issue: The builder's own comment acknowledges this is "OUTSIDE this $transaction." Prisma does not nest transactions — the inner `$transaction` opens a fresh connection-scoped transaction that commits independently. Failure modes:
  1. Inner commits, outer fails → credit applied, dedup row missing. Stripe retries, sees CCPP.status='paid' → returns `already_applied` and the outer transaction re-runs the dedup insert on retry. Eventually consistent but ack-before-commit semantics.
  2. Inner commits, outer SUCCEEDS but a sibling handler in the outer switch throws → outer rolls back → dedup row gone → inner credit still applied → Stripe retries → idempotent path kicks in. Same as (1).
  3. Real risk: a future handler added to the outer switch may write state that depends on credit having been applied, then fail. Now the dependent state is rolled back but the credit is permanent.
- Suggested fix: refactor `applyCreditPack` to accept an optional `Prisma.TransactionClient` and use the caller's tx when supplied (the builder already follows this pattern in `getOrCreateCurrentPeriodTx`). Thread `tx` from `BillingService.handleEvent` → `handleStripeEvent` → `applyCreditPack`. Pattern is documented in the same file at the `getOrCreateCurrentPeriodTx` definition.

### P0-7: Tests claim to cover RLS and signature verification but only string-match the migration / source file
- File: `test/ai-credits-stream1.spec.ts:540-613` (T9, T10, T11), `test/ai-credits-stream1.spec.ts:494-510` (T13)
- 50-Failures category: **#34 "Logs not telemetry"** (test-as-telemetry variant) — fake coverage
- Code:
    ```ts
    // T9:
    expect(src).not.toMatch(/stripe-signature/);
    // T10/T11:
    expect(migration).toMatch(/ALTER TABLE "CoachAIBudget" ENABLE ROW LEVEL SECURITY/);
    // T13:
    expect(src).toMatch(/createCreditPackCheckoutSession[\s\S]+?return this\.post</);
    ```
- Issue: Spec §7 requires:
  - T10: "coach A cannot **read** coach B's budget"
  - T11: "coach **cannot directly INSERT/UPDATE** CoachCreditPackPurchase"
  - T13: "All new external API calls have **timeout config**"

  None of these are verified. T10/T11 ensure migration syntax exists but cannot detect: missing `app.current_user_id()` helper in this environment, the table-owner exemption from FORCE RLS in any future migration that adds the role, or a missing `WITH CHECK` clause. T13 verifies that the method calls `this.post` — `this.post` has NO timeout (no AbortController, no `signal`, no per-request deadline). The "boundary" the builder asserts is a single mock point, not a real timeout. Failing the timeout check would simply mean Stripe could hang the request indefinitely under upstream slowness.

- Suggested fix: add an integration spec that boots a real Postgres (via docker-compose or testcontainers) and exercises a coach-scoped INSERT on CoachCreditPackPurchase under `set_config('app.current_user_id', '<coach-id>', true)` — expect Postgres to reject. For T13: add an AbortController-driven timeout to `StripeApiService.post` (e.g. 10s default, env-tunable) and assert the AbortController fires after that delay using `jest.useFakeTimers`.

---

## P1 findings (BLOCKERS — must fix before merge)

### P1-1: Race-condition test (T3) uses a synchronous in-memory mock — does NOT actually test concurrency
- File: `test/ai-credits-stream1.spec.ts:340-371`
- 50-Failures category: **#28 "Race conditions"**
- Code:
    ```ts
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.recordUsage({ coachId: 'coach-r', actualCostCents: 50, capability: 'client_chat' }),
      ),
    );
    ```
- Issue: The `makePrismaMock` is a Map-backed in-memory store. JS is single-threaded and the mock's `updateMany` is synchronous mutation. `Promise.all` of 10 calls just sequences them through the event loop — each `await` resolves before the next iteration starts a new one. There is no actual concurrent SQL UPDATE racing against the WHERE-clause guard. The test verifies the LOGICAL behaviour of the guard (charges that overshoot the running counter are rejected) but does NOT verify the Postgres-level atomicity that the spec calls out (`WHERE actual_used_cents <= ceiling - cost`). The test would pass even if the implementation used a read-modify-write pattern that races in production.
- Suggested fix: use the integration test rig (testcontainers Postgres) and dispatch 10 parallel `Promise.all` of true SQL connections. Verify (a) total never exceeds cap, (b) `count===0` is observed at least once. Alternative: mark T3 as `it.todo()` + add an integration-only spec gated by an env flag.

### P1-2: Stripe outbound (`StripeApiService.post`) has no timeout
- File: `src/billing/stripe-api.service.ts:339-388` (the `post` helper)
- 50-Failures category: **#35 "Missing timeouts on external API calls"**
- Code:
    ```ts
    const res = await this.fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body,
    });
    ```
- Issue: No `AbortSignal`, no `signal: AbortSignal.timeout(N)`, no per-call deadline. `fetch` waits indefinitely by default in Node 22+. A hung Stripe API call will hold the request handler open until the upstream Node HTTP timeout (which is also unconfigured) or the load balancer cuts the connection. This is a P1 because Stripe outbound from the credit-pack-checkout endpoint is now a user-visible synchronous round-trip — a slow Stripe degrades the entire AI-credits purchase flow without any deterministic failure surface.
- Suggested fix: thread an `AbortSignal.timeout(parseInt(process.env.STRIPE_API_TIMEOUT_MS ?? '10000', 10))` into the fetch call. Add T13 to actually verify the abort fires under fake timers.

### P1-3: Period rollover drifts off the calendar month (uses `start_of_month + 30 days`)
- File: `src/ai-credits/coach-ai-budget.service.ts:43`, `:123-125`, `:449-450`, `:514-516`
- 50-Failures category: **#5 "Over-specification"** (constants don't match the domain)
- Code:
    ```ts
    const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
    function startOfCurrentPeriod(now: Date): Date {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    }
    // ... periodEnd = periodStart + PERIOD_MS
    ```
- Issue: `period_start` is first-of-month UTC but `period_end` is `start + 30 days`. For Jan (31 days), `period_end = Jan 31 00:00 UTC` — the coach loses Jan 31 of quota; rollover fires one day early. For Feb (28 days), `period_end = Mar 3 00:00 UTC` — the new period starts on Mar 3 instead of Mar 1, the coach gets two free days of overlap with March's budget allowance. For April (30 days), correct. The audit doc and the spec say "monthly rollover"; the implementation is "every 30 days from the 1st of the month". Over a year these drifts cumulate and the period boundaries de-sync from the calendar.
- Suggested fix: `period_end = startOfNextMonth(period_start)` = `new Date(Date.UTC(yyyy, mm+1, 1))`. Update both the create path (line 125) and the rollover path (line 450). Add a test that asserts `period_end` matches the first of the following calendar month.

### P1-4: 402-on-budget-exhaust is unit-tested only — no integration verifying `AiGatewayService.invoke` actually throws on exhaustion
- File: `test/ai-credits-stream1.spec.ts:374-405` (T4)
- 50-Failures category: **#36 "Errors not codes"** (test variant)
- Code:
    ```ts
    const err = new CoachAiBudgetExhaustedException({ ... });
    expect(err.getStatus()).toBe(402);
    ```
- Issue: T4 in the spec demands "Integration: budget exhaustion blocks new AI calls (returns 402)". The shipped test constructs an exception instance and inspects its shape. It does NOT verify that the gateway's `invoke` actually throws this exception when `canCharge` reports zero remaining. A regression in the gateway's gate condition (`actual_used_cents >= total_actual_available_cents` line in ai-gateway.service.ts:121) would not be caught.
- Suggested fix: add a unit test that constructs `AiGatewayService` with a mock budget service whose `canCharge` returns `{ allowed: false, budget: { actual_used_cents: 4000, total_actual_available_cents: 4000, ... } }` and asserts that `invoke()` rejects with `CoachAiBudgetExhaustedException`.

### P1-5: Hand-rolled banker's rounding — property tests are example-based, not generative
- File: `src/ai-credits/bankers-round.util.ts`, `test/ai-credits-bankers-round.spec.ts`
- 50-Failures category: **#41 "Vanilla Style"**
- Code: rounding implementation is hand-written; tests are `it.each([...])` tables + a fixed-step loop, not generative property tests (`fast-check` / `jsverify`).
- Issue: The Builder Brief explicitly allows "use a tested utility OR write a util with property-based tests". The shipped tests are example-based + a few invariant checks (monotonicity, ratio bound). They cover the locked tier examples and a stride sample but not random inputs in `[0, 2^31)` or the IEEE-754 boundary cases. The implementation has an `EPS = 1e-9` hand-tuned epsilon that the tests do not stress.
- Suggested fix: either (a) swap to `bignumber.js` (already transitively a dep of some packages) for the division step and use its `ROUND_HALF_EVEN` mode, or (b) add a `fast-check` property test that random-samples paidCents in `[0, 500_000]` and asserts `Math.abs(bankersRoundPaidToActual(p, 3.125) - p/3.125) < 0.5 + EPS` AND that successive ties alternate parity (`bankersRound(2k + 0.5) === 2k` for all integer k).

### P1-6: `recordUsage` reads `budget.id` then issues a separate UPDATE — a concurrent `rolloverDueBudgets` can change `period_end` between the read and the update
- File: `src/ai-credits/coach-ai-budget.service.ts:178-190` and `:443-471`
- 50-Failures category: **#28 "Race conditions"**
- Code:
    ```ts
    // recordUsage:
    const budget = await this.getOrCreateCurrentPeriod(args.coachId);
    const ceilingCents = budget.total_actual_available_cents;
    const result = await this.prisma.coachAIBudget.updateMany({
      where: { id: budget.id, actual_used_cents: { lte: ceilingCents - args.actualCostCents } },
      ...
    });
    ```
- Issue: There is no `period_end` clause in the WHERE — if the rollover cron runs between the snapshot read and the update, `actual_used_cents` was reset to 0 server-side. The update's `lte` still succeeds and the charge applies to the NEW period — the right outcome here, accidentally. But the snapshot's `total_actual_available_cents` was computed from the OLD pack_paid_cents. The rollover preserves packs, so the ceiling is unchanged across the rollover. Hidden coupling. Document and pin a `period_end >= now` check in the WHERE to make the rollover/recordUsage interaction explicit.
- Suggested fix: add `period_end: { gt: new Date() }` to the WHERE clause to ensure we never debit an already-rolled period.

### P1-7: Sub-coach resolution uses `findFirst` ordered by `created_at: 'asc'` — silently breaks if the policy ever allows 2 head coaches
- File: `src/ai-credits/coach-ai-budget.service.ts:89-100`
- 50-Failures category: **#5 "Over-specification"** + **#28 "Race conditions"**
- Code:
    ```ts
    const assignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: userId, archived_at: null },
      orderBy: { created_at: 'asc' },
      select: { head_coach_id: true },
    });
    ```
- Issue: A sub-coach assigned to two head coaches (the schema explicitly permits up to 2) has their AI usage attributed to whichever assignment is OLDER. If the older one is later archived and a new one created, the head_coach attribution silently swings. There's no audit log for the swing. The DTO returned by `GET /coach/ai/budget` for the sub-coach also silently changes which head-coach's envelope is displayed.
- Suggested fix: either (a) explicitly document that sub-coaches always debit the FIRST (oldest non-archived) head coach and emit a structured log when the resolution swings, or (b) split the sub-coach's chat traffic 50/50 across both heads when 2 assignments exist (matches the audit-doc "shared envelope" wording more cleanly).

### P1-8: `total_actual_available_cents` rounds at read-time — drifts from sum of per-pack rounded `actual_credit_cents`
- File: `src/ai-credits/coach-ai-budget.service.ts:489-505`
- 50-Failures category: **#41 "Vanilla Style"** (financial-rounding variant)
- Code:
    ```ts
    const packActualCents = bankersRoundPaidToActual(row.pack_paid_cents, multiplier);
    ...
    total_actual_available_cents: row.base_actual_cents + packActualCents,
    ```
- Issue: `pack_paid_cents` is the cumulative sum of `paidCents` across all packs this period. The above rounds the SUM, not the per-row already-rounded values. For multiplier 3.125, the difference is at most 1 cent per pack (banker's rounding is unbiased), but a heavy coach with 50 packs could see total_actual_available diverge from `Σ CCPP.actual_credit_cents` by up to 25 cents. That is the difference between "we credit you 50 actual cents per pack" (recorded on CCPP) and "we credit you (50×paid)/3.125 in aggregate" (used by recordUsage). Functionally the coach is at most 25¢ better-or-worse off than the receipts say.
- Suggested fix: track `total_pack_actual_cents` as a column on `CoachAIBudget` and increment it by `actual_credit_cents` (the per-pack already-rounded value) inside `applyCreditPack`. Read directly without re-rounding.

---

## P2 findings (SHOULD FIX — not blockers but noted)

### P2-1: Spec §1 deliverable 5 names `getRemainingDisplayed(coachId)` as a public method; builder exposes the value inside `getBudgetDto` instead
- File: `src/ai-credits/coach-ai-budget.service.ts:214-243`
- 50-Failures category: **#5 "Over-specification"**
- Issue: The DTO carries `remaining_displayed_cents` so the value is available, but no standalone method named `getRemainingDisplayed` exists. A consumer (e.g. an internal admin script) that follows the spec verbatim would import nothing.
- Suggested fix: add a one-line `getRemainingDisplayed(coachId)` that calls `getBudgetDto(coachId).remaining_displayed_cents` so the API surface matches the spec.

### P2-2: Spec §1 deliverable 10 names the webhook event `invoice.payment_succeeded`; builder routed `checkout.session.completed`
- File: `src/ai-credits/coach-ai-credit-pack.service.ts:167-212`
- 50-Failures category: **#5 "Over-specification"**
- Issue: For one-time `mode: 'payment'` Checkout Sessions, Stripe does NOT fire `invoice.payment_succeeded` (there's no invoice). `checkout.session.completed` is the correct event. The spec's choice of event name appears to assume a subscription-style pack model. Builder's deviation is functionally right but unmarked. Update the spec or add a comment in the handler explicitly noting the divergence.

---

## P3 findings (advisory)

- **P3-1**: The audit-doc body in `docs/audits/ai_*_2026-05-27.md` still references the pre-override numbers (5.0× / $200 / 80%) below the OPERATOR OVERRIDE block. The builder explicitly kept this as "historical context", which is defensible, but a careless reader could quote the wrong number. Consider stamping `<!-- STALE -->` markers next to the pre-override prose.

- **P3-2**: Anthropic adapter has no fetch timeout either (not in this PR's scope). The metering on the AI gateway can now hit Anthropic from many code paths; an upstream Anthropic outage will tie up Node workers. Track separately.

- **P3-3**: `recordUsage` cost estimation in `ai-gateway.service.ts:319-345` uses Sonnet 4.5 pricing (`$3/MTok in, $15/MTok out`) hardcoded. The audit docs cite Sonnet pricing assumptions; encapsulate as a config constant so a price change is one diff, not a code search.

---

## Spec Compliance Checklist (§1 deliverables 1-15)

| # | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Update committed audit docs | ✅ | OVERRIDE block + tables updated; pre-override prose left as historical |
| 2 | Prisma model `CoachAIBudget` | ✅ | Schema matches spec §2 (Decimal(6,3), 4000/12500/3.125 defaults) |
| 3 | Prisma model `CoachCreditPackPurchase` | ✅ | @unique on session_id present; CHECK constraints added |
| 4 | Migration with RLS in same migration | ⚠️ | RLS present (ENABLE+FORCE); but no coach-scoped UPDATE policy — coaches can SELECT only. Spec §2 example shows separate `tenant_update` policy. Repo precedent supports the builder's no-update-policy approach via service-role BYPASSRLS, so functionally OK |
| 5 | `CoachAIBudgetService` (4 methods) | ⚠️ | `getOrCreateCurrentPeriod` ✅, `recordUsage` (WHERE-clause guard) ✅, `applyCreditPack` (banker's round) ✅. `getRemainingDisplayed` ❌ — value present in DTO but no standalone method (P2-1) |
| 6 | `GET /coach/ai/budget` endpoint | ✅ | DTO matches spec §5 shape, multiplier as string |
| 7 | AI gateway pre-check + post-record | ⚠️ | Both implemented but pre-check uses `>=` not the full charge cost (spec also does this — see P1-5 in spec comment block) |
| 8 | Stripe products + prices for $10/$25/$99/Custom | ✅ | Inline `price_data` per session; no static Prices needed |
| 9 | `POST /coach/ai/credit-packs/checkout` | ✅ | Throttled at 5/min via new bucket |
| 10 | `invoice.payment_succeeded` → applyCreditPack | ⚠️ | Routed via `checkout.session.completed` instead. Functionally correct for `mode: 'payment'` but spec language not followed (P2-2) |
| 11 | Monthly rollover cron | ⚠️ | Hourly cron at :05; preserves packs ✅; period_end is 30-day window not calendar month (P1-3) |
| 12 | Dormancy guard | ❌ | Service shipped but NOT wired into the weekly-insight cron, AND `CoachBrief.read_at` is never SET anywhere → guard is dead code (P0-4 + P0-5) |
| 13 | Throttle bucket `COACH_AI_CREDIT_PACK_CHECKOUT` | ✅ | Default 5/min, env-tunable |
| 14 | Admin endpoints (grant / refund / list) | ⚠️ | All three present and owner-guarded; grant-credits VIOLATES the CCPP CHECK constraint in production (P0-1) |
| 15 | Tests | ⚠️ | All 15 IDs present but T9/T10/T11/T13 substitute file-text grep for behavioural verification (P0-7); T3 doesn't actually test concurrency (P1-1); T4 doesn't actually invoke the gateway (P1-4) |

## Spec §7 Test Matrix (T1-T15)

| T | Spec requirement | Shipped | Verdict |
|---|---|---|---|
| T1 | `applyCreditPack($10) → 320 actual cents` | ✅ asserted | ✅ pass |
| T2 | Stripe webhook idempotency | ✅ asserted with mock | ✅ pass (logical) |
| T3 | 10 concurrent recordUsage at 95% | ⚠️ async-not-concurrent (P1-1) | ⚠️ fake concurrency |
| T4 | Budget exhausted → 402 | ⚠️ constructs exception only (P1-4) | ⚠️ shape only |
| T5 | Monthly rollover expires base, preserves packs | ✅ asserted | ✅ pass |
| T6 | Dormancy guard skips 3-unread | ✅ asserted at service level | ✅ (but unwired in cron — P0-4) |
| T7 | Sub-coach charges head coach | ✅ asserted | ✅ pass |
| T8 | GET /coach/ai/budget DTO shape | ✅ asserted | ✅ pass |
| T9 | Stripe signature rejects tampered | ⚠️ grep src for absence of HMAC (P0-7) | ⚠️ fake |
| T10 | Coach A cannot read coach B's budget | ⚠️ grep migration text (P0-7) | ⚠️ fake |
| T11 | Coach cannot INSERT/UPDATE CCPP | ⚠️ grep migration text (P0-7) | ⚠️ fake |
| T12 | Admin grant blocked for non-owner | ⚠️ grep controller decorators | ⚠️ static |
| T13 | All new external APIs have timeout | ⚠️ grep that method calls this.post (P0-7) | ⚠️ fake — no timeout exists |
| T14 | No console.log shipped | ✅ grep src/ai-credits/* | ✅ pass |
| T15 | Scheduler emits structured tick log | ✅ asserted | ✅ pass |

---

## Rule Compliance

- **R4 commit author**: ✅ PASS — `git log origin/main..HEAD --format="%an <%ae>" | sort -u` yields only `Dynasia G <dynasia@trygrowthproject.com>`
- **R4 no Co-Authored-By**: ✅ PASS — `git log origin/main..HEAD --grep="Co-Authored-By"` returns nothing
- **R56 worktree isolation**: ✅ PASS — builder worked in `backend-ai-credits-build`, auditor in `backend-ai-credits-audit`
- **R14 latest plumbing**: ⚠️ Stripe SDK intentionally not used (REST-over-fetch convention from repo). `prisma@^6.19.3` and `@nestjs/*@^11` are current. Acceptable. The `STRIPE_API_VERSION` pinned to `2024-09-30.acacia` is over a year old as of audit date — repo-wide concern not introduced by this PR.

---

## Spot-Check Results (from auditor brief's 10 P0 items)

| # | Spot-check | Result |
|---|---|---|
| 1 | RLS on BOTH tables in same migration | ✅ |
| 2 | WHERE-clause guard prevents overshoot | ⚠️ — implementation correct, test doesn't exercise concurrency (P1-1) |
| 3 | Stripe webhook signature not bypassed in prod | ✅ — verification owned by existing `StripeWebhookController` |
| 4 | `stripe_checkout_session_id` @unique | ✅ |
| 5 | `applyCreditPack` in `prisma.$transaction` | ✅ technically — but nested OUTSIDE outer dedup tx (P0-6) |
| 6 | Admin endpoints have role guards | ✅ — `OwnerGuard` + `@Roles('owner')` per handler |
| 7 | Banker's rounding has property tests | ⚠️ example-based, not generative (P1-5) |
| 8 | No `console.log` shipped | ✅ — grep clean across `src/ai-credits/*` |
| 9 | Stripe/Anthropic explicit timeout | ❌ — neither has timeout config (P1-2 + P3-2) |
| 10 | Money fields Decimal(14,2) NOT Float | ✅ — `Decimal(6,3)` on multiplier per spec §2; cents stored as Int |

---

## Notes for Fixer (if dirty)

Fix order (P0 first, then P1):

1. **P0-1** (grantFreeCredits CHECK violation): change the migration's `CCPP_displayed_credit_eq_paid` to `CHECK (displayed_credit_cents >= paid_cents)` AND add an explicit `is_free_grant` boolean column on CCPP for reporting clarity. Do this in a NEW migration (do not edit the merged one).
2. **P0-2 + P0-3 + P0-5** (Stripe tax / amount_total mismatch): in `handleStripeEvent`, look up the existing CCPP row by `stripe_checkout_session_id`, use `existing.paid_cents` (not `obj.amount_total`) when calling `applyCreditPack`. Optionally drop `automatic_tax` for credit-pack sessions if the legal review confirms the B2B carve-out from the mobile spec applies. Add a test that exercises a webhook event with `amount_total > existing.paid_cents` and asserts the credit equals `paid_cents`.
3. **P0-4 + P0-5** (dormancy not wired + read_at never set): wire `DormancyGuardService.shouldSkipCoach` into `src/ai/coach/weekly-insight.cron.ts` per-coach iteration. Add a `POST /coach/brief/:id/read` endpoint (or fold into the brief-fetch path) that sets `read_at = now()`. Add an integration test: 3 briefs unread → guard returns true, after reading any one → guard returns false.
4. **P0-6** (nested transactions): refactor `applyCreditPack(args)` → `applyCreditPack(args, tx?)`. When `tx` is provided, use it; otherwise open a new transaction. Thread the outer `tx` from `BillingService.handleEvent` through `handleStripeEvent` into `applyCreditPack`.
5. **P0-7** (fake test coverage): replace the migration-grep RLS tests with integration tests using `testcontainers` / docker-compose Postgres. Add a real timeout to `StripeApiService.post` (AbortSignal.timeout) and test the abort.
6. **P1-1** (race test): either upgrade T3 to a real-Postgres integration test or mark as `it.todo` with a separate Postgres-backed spec.
7. **P1-2** (Stripe timeout): add `AbortSignal.timeout(parseInt(process.env.STRIPE_API_TIMEOUT_MS ?? '10000', 10))` to the `fetch` call in `post()`.
8. **P1-3** (rollover off calendar): replace `start + 30 days` with `startOfNextMonth(start)`.
9. **P1-4** (402 not integration-tested): add a gateway-level test asserting the budget-exhausted exception path.
10. **P1-5** (banker's rounding): add `fast-check` property tests across `[0, 500_000]`.
11. **P1-6** (rollover/recordUsage coupling): add `period_end > now` to the WHERE clause.
12. **P1-7** (sub-coach silent reattribution): emit structured log on resolution swings.
13. **P1-8** (rounding aggregation drift): track `total_pack_actual_cents` as a stored column.

P2 / P3 items are advisory — fix at fixer's discretion but not blocking.

---

End of audit. I do NOT mark this PR clean. Parent decides.
