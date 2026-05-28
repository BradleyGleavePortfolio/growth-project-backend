# Stream 1 Backend Audit — Round 2 (2026-05-28T08:42Z, unix 1779957755)

## Fixer PR
https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/297
Branch: `agent/fixer/ai-credits-backend/facb686b`
Round-1 audit verified: `audits/STREAM_1_BACKEND_AUDIT_1779955069.md`

## CI / Local verification
- `npm run build`: **PASS** (nest build clean)
- `npm run lint`: **PASS** (0 errors, 21 pre-existing warnings unrelated to this PR)
- `npm test`: **3233 passed, 20 skipped (4 new it.skip from fixer), 5 todo, 0 failed across 271 suites** (3258 total in 180s) — matches the fixer's claim exactly
- R4 commit author: **PASS** — `git log origin/main..HEAD --format='%an <%ae>' | sort -u` yields only `Dynasia G <dynasia@trygrowthproject.com>`
- R4 no Co-Authored-By / Generated-with: **PASS** — `git log origin/main..HEAD --grep='Co-Authored-By\|Generated with'` returns empty
- All 3 fixer commits (`d405b696`, `0e7402e6`, `696cd62d`) authored by Dynasia G

---

## Verifying Round-1 Findings

### P0-1: VERIFIED FIXED
- New migration at `prisma/migrations/20260528120000_stream1_round1_fixes/migration.sql` drops `CCPP_displayed_credit_eq_paid`, replaces with `CCPP_displayed_credit_ge_paid` (`>=`), adds `is_free_grant` BOOLEAN + invariant `CCPP_free_grant_paid_zero` + partial index `CoachCreditPackPurchase_free_grants_idx`.
- `src/ai-credits/coach-ai-budget.service.ts:416` — `grantFreeCredits` sets `is_free_grant: true`.
- `prisma/schema.prisma:4548` — schema column added.
- Behavioural test at `test/ai-credits-round1-fixes.spec.ts:213-251` asserts paid=0/displayed>0/is_free_grant=true. The mock enforces both new CHECK constraints (line 122-129) so regressions trip clearly.

### P0-2 + P0-3 + P0-5 (Stripe tax / amount_total drift): VERIFIED FIXED
- `src/billing/stripe-api.service.ts:214` — `'automatic_tax[enabled]': 'false'` on credit-pack Checkout Sessions only (scoped, verified by grep — Connect storefront still uses `automatic_tax: true` in `src/connect/stripe-connect-api.service.ts:443`).
- `src/ai-credits/coach-ai-credit-pack.service.ts:289-293` — `applyCreditPack` is called with `paidCents: existing.paid_cents` (tier face-value), NOT `obj.amount_total`.
- Lines 273-287 — structured `COACH_AI_PACK_AMOUNT_TOTAL_DIVERGENCE` warn log if Stripe's amount_total differs from CCPP.paid_cents (defensive future-proofing).
- Behavioural test at `test/ai-credits-round1-fixes.spec.ts:259-301` asserts: webhook with `amount_total=2706` against CCPP `paid_cents=2500` credits exactly 2500, AND the divergence warn log fires. Inverse test: stray webhook with no pending CCPP returns `no_pending_purchase`.

### P0-4: VERIFIED FIXED (dormancy guard wired into weekly insight cron)
- `src/ai/coach/weekly-insight.cron.ts:5,28,49` — `DormancyGuardService` imported, injected, and called per-coach in the loop.
- Skipped coaches emit `WEEKLY_INSIGHT_SKIPPED_DORMANT` structured log (line 51-54), and `WEEKLY_INSIGHT_COMPLETE` final tally includes `skippedDormant` count (line 70-72).
- DI resolution OK because `AiCreditsModule` is `@Global` and exports `DormancyGuardService` (`src/ai-credits/ai-credits.module.ts:25,40`).

### P0-5 (CoachBrief.read_at writer): VERIFIED FIXED with one partial-coverage caveat
- New endpoint `POST /coach/brief/:id/read` at `src/coach/brief/coach-brief.controller.ts:157-175`.
- Auth posture: class-level `@UseGuards(CoachBriefEnabledGuard, CoachGuard)` + `@Roles('coach')` (line 55-58) — JwtAuthGuard is global. UUID validated by `ParseUUIDPipe`. Tenant scope enforced at service layer.
- `src/coach/brief/coach-brief.service.ts:1800-1834` — `markBriefRead` does an atomic conditional UPDATE (`WHERE id = $id AND coach_id = $coach AND read_at IS NULL`) and returns `already_read: true` on retry. Idempotent. NotFoundException raised via `BriefNotFoundError` sentinel.
- **Test gap (P2-N1):** the audit asked for an integration test stitching `markBriefRead → DormancyGuardService.shouldSkipCoach` end-to-end. The fixer covers the two halves separately (T6 verifies `shouldSkipCoach` with seeded `read_at` values; new round-1 spec verifies `markBriefRead`). The chained flow (call `markBriefRead`, then call `shouldSkipCoach`, observe `false`) is not directly asserted. Not a blocker — both halves are correct individually — but the contract surface between them is not pinned by a test. See NEW-P2-1 below.

### P0-6: VERIFIED FIXED (tx propagation)
- `applyCreditPack`, `grantFreeCredits`, `refundPack` all accept `outerTx?: Prisma.TransactionClient` (`src/ai-credits/coach-ai-budget.service.ts:305, 385, 448`). Each method runs `work(outerTx)` when supplied, otherwise opens its own `$transaction`.
- `handleStripeEvent` accepts `outerTx?: Prisma.TransactionClient` (`src/ai-credits/coach-ai-credit-pack.service.ts:184`) and threads it into the existing/CCPP read AND into `applyCreditPack(args, outerTx)` (line 299).
- `BillingService.handleEvent` passes its outer `tx` (`src/billing/billing.service.ts:212` — `await this.coachAiPacks.handleStripeEvent(event, tx)`).
- Tests at `test/ai-credits-round1-fixes.spec.ts:342-401` assert: (a) when `outerTx` is supplied, `$transaction` is NOT called; (b) when omitted, `$transaction` IS called. **Test gap:** no test asserts the inner credit-apply rolls back when the outer tx fails — the mock can't simulate true Prisma transactional rollback (real-Postgres rig needed). The structural fix is correct; the test coverage of the runtime rollback semantics is owed to the Postgres rig backlog.

### P0-7 (fake test coverage): VERIFIED FIXED
- T9, T10, T11 properly marked `it.skip(... [needs Postgres rig])` at lines 588, 630, 637 of `test/ai-credits-stream1.spec.ts` — verified in Jest output as **20 skipped** (4 of which are these new round-1 skips + 1 round-1 T3 skip).
- The lightweight migration-string drift checks remain as `T10s`/`T11s` so a future migration that deletes a policy still trips.
- T13 replaced with a real behavioural test (`test/ai-credits-stream1.spec.ts:712-797`): subclasses StripeApiService with a fetchImpl that hangs until the AbortSignal aborts; asserts `StripeApiError(504, request_timeout, api_connection_error)`. T13b verifies the structured envelope shape.
- Real timeout impl at `src/billing/stripe-api.service.ts:415` (`AbortSignal.timeout(resolveStripeApiTimeoutMs())`) with `STRIPE_API_TIMEOUT_MS` env var (default 10000ms, clamped min 1000ms).

### P1-1 (race fake concurrency): VERIFIED SKIPPED-WITH-CLEAR-TODO
- `test/ai-credits-stream1.spec.ts:380` — `it.skip('T3: 10 truly concurrent recordUsage at 95% — total <= cap [needs Postgres rig]', ...)`. Inline TODO comment cites testcontainers Postgres requirement.
- The logical-overshoot behaviour is still covered by T3b (sequential through the mock).

### P1-2 (Stripe outbound timeout): VERIFIED FIXED for the `post()` path. **NEW issue surfaced** — see NEW-P2-2 below for `cancelSubscription` + `deleteSubscriptionItem` gaps.

### P1-3 (rollover off calendar): VERIFIED FIXED
- `src/ai-credits/coach-ai-budget.service.ts:570` — `startOfNextMonth(d)` helper added; uses `new Date(Date.UTC(yyyy, mm+1, 1))` which handles year boundary via Date object math.
- Used in both `getOrCreateCurrentPeriodTx` (line 151) and `rolloverDueBudgets` (line 503).
- Old `PERIOD_MS = 30 * 24 * 60 * 60 * 1000` constant removed.
- Tests at `test/ai-credits-round1-fixes.spec.ts:408-454` assert Feb→Mar 1, Jan→Feb 1, Dec 2026→Jan 1 2027 boundaries using `jest.useFakeTimers` + `jest.setSystemTime`.

### P1-4 (402 integration test): VERIFIED FIXED
- New `test/ai-credits-gateway-402.spec.ts` (194 lines). Two cases:
  - **Exhausted**: mock budget reports `allowed: false, actual_used_cents: 4000, total_actual_available_cents: 4000`. Asserts `svc.invoke()` rejects with `CoachAiBudgetExhaustedException`, `getStatus() === 402`, structured body has `code: 'COACH_AI_BUDGET_EXHAUSTED'`, `pack_options_cents: [1000, 2500, 9900]`, custom bounds, `remaining_displayed_cents: 0`.
  - **Headroom**: `allowed: true` — `invoke()` resolves with `enabled: true`, and `budget.recordUsage` was called (post-call atomic write verified).
- Uses real `AiGatewayService`, real `AiGatewayConfig`, real Provider Registry with a fake-but-realistic Anthropic adapter; `process.env` is restored.

### P1-5 (banker's rounding generative tests): VERIFIED FIXED
- `package.json:68` — `fast-check@^3.23.2` added to devDependencies.
- `test/ai-credits-bankers-round.spec.ts:81-150` — five fast-check property tests:
  - Ratio accuracy: `|bankersRound(p/3.125) - p/3.125| <= 0.5 + 1e-9` for all `p in [0, 500_000]` (1000 runs).
  - Half-to-even at even-k ties: `bankersRound(2k + 0.5) === 2k` (500 runs).
  - Half-to-even at odd-k ties: `bankersRound((2k+1) + 0.5) === 2(k+1)` (500 runs).
  - Monotonicity under random pairs (1000 runs).
  - Result is always a non-negative integer for non-negative input (500 runs across mixed multipliers).

### P1-6 (rollover/recordUsage coupling): VERIFIED FIXED
- `src/ai-credits/coach-ai-budget.service.ts:216` — `period_end: { gt: now }` added to the `updateMany` WHERE clause in `recordUsage`. A debit on an already-rolled period now returns `recorded: false`.
- The `COACH_AI_BUDGET_RACE_OVERSHOOT` warn log includes `periodEnd` (line 226) so post-rollover overshoot is observably distinct from cap-exhaustion overshoot.
- Test at `test/ai-credits-round1-fixes.spec.ts:460-481` confirms a debit on an already-rolled budget returns `recorded: false`.

### P1-7 (sub-coach silent reattribution): VERIFIED FIXED
- `src/ai-credits/coach-ai-budget.service.ts:81` — `private headCoachAttributionCache = new Map<string, string>()` (process-local cache).
- Line 111-122 — `resolveHeadCoachId` checks cache against newly-resolved head; emits `SUB_COACH_HEAD_REATTRIBUTED` structured log with `subCoachId`, `oldHeadCoachId`, `newHeadCoachId` when they differ. Cache writes happen only when assignment exists (head-coaches don't bloat the cache).
- First-resolution does NOT log (no previous value to swing from).
- Test at `test/ai-credits-round1-fixes.spec.ts:484-525` asserts log fires on swap-from-head-A-to-head-B; does NOT fire on first resolution.

### P1-8 (rounding aggregation drift): VERIFIED FIXED
- New `total_pack_actual_cents` column on `CoachAIBudget` (`prisma/schema.prisma:4486`, `migration.sql:55`) with `NOT NULL DEFAULT 0` + nonneg CHECK constraint.
- Migration backfill at `migration.sql:68-71` for any pre-existing `pack_paid_cents > 0` rows (likely none in production at first deploy since this ships together with the round-0 tables).
- `applyCreditPack` increments by per-pack already-rounded `actual_credit_cents` (line 347). `grantFreeCredits` also increments it (line 404). `refundPack` decrements it (line 463). Rollover preserves it (line 516 comment + omission from the update payload).
- `toSnapshot` reads it directly (`src/ai-credits/coach-ai-budget.service.ts:555`) — no round-the-sum drift.
- Test at `test/ai-credits-round1-fixes.spec.ts:530-562` creates three $25 packs, applies each, asserts `total_pack_actual_cents === 3 * 800 = 2400` and `total_actual_available_cents === 4000 + 2400`.

### P2-1 bonus (`getRemainingDisplayed`): VERIFIED FIXED
- `src/ai-credits/coach-ai-budget.service.ts:275-278` — public one-line method matching spec §1 item 5 verbatim.

---

## NEW issues introduced by (or surfaced during) fix commits

### NEW-P2-1: end-to-end mark-read → dormancy guard chain is not directly tested
- File: `test/ai-credits-round1-fixes.spec.ts` (would be added)
- 50-Failures category: **#34 "Logs not telemetry"** (test-as-telemetry variant — partial)
- Issue: The audit asked for a test "3 briefs unread → guard returns true; after reading one → guard returns false." The fixer covers the two halves separately:
  - T6 verifies `shouldSkipCoach` returns true on `[null, null, null]` and false when most-recent is non-null.
  - New P0-1 test verifies `markBriefRead` sets `read_at` correctly via the mock.
  - The CHAIN (`markBriefRead` → `shouldSkipCoach` returns false) is not directly asserted in a single test.
- Severity: **P2 advisory.** Both halves are correct individually and Postgres-level integration is owed to the Postgres-rig backlog anyway. A unit test of the chain through the existing mock would be cheap to add (use the same `briefs` Map already in the store) but isn't a blocker.
- Suggested fix (low priority): add a test in `test/ai-credits-round1-fixes.spec.ts` that seeds 3 unread briefs, asserts `shouldSkipCoach=true`, calls `markBriefRead` on one, asserts `shouldSkipCoach=false`. Roughly 20 lines.

### NEW-P2-2: `cancelSubscription` and `deleteSubscriptionItem` still have unprotected `fetchImpl` calls
- File: `src/billing/stripe-api.service.ts:302, 310, 365`
- 50-Failures category: **#35 "Missing timeouts on external API calls"**
- Code:
    ```ts
    // line 302 (cancelSubscription DELETE)
    const res = await this.fetchImpl(
      `${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
      { method: 'DELETE', headers },                         // ← no signal
    );
    // line 310 (cancelSubscription cancel_at_period_end POST)
    const res = await this.fetchImpl(..., {
      method: 'POST', headers, body: ...,                    // ← no signal
    });
    // line 365 (deleteSubscriptionItem DELETE)
    const res = await this.fetchImpl(..., { method: 'DELETE', headers }); // ← no signal
    ```
- Issue: The Round-1 audit (P1-2) explicitly scoped the finding to `StripeApiService.post`. The fixer added `AbortSignal.timeout` to `post()` correctly, but the SAME file has three other `fetchImpl` call sites (cancelSubscription's DELETE/POST + deleteSubscriptionItem's DELETE) which remain timeout-less. These are pre-existing methods called from the existing SaaS-subscription billing flow, NOT introduced by the AI credits PR — but the spirit of P1-2 (no hung Stripe call ever holds a request handler open) is unfulfilled.
- Severity: **P2 advisory.** Out of strict P1-2 scope (which named `post()` only) and not introduced by this PR. But the next round of work should extend the timeout pattern to all four Stripe-outbound paths. The fixer's `resolveStripeApiTimeoutMs()` helper is already in place — applying it requires three near-identical edits.
- Suggested fix: factor the post-style `signal + try/catch DOMException→StripeApiError` block into a shared helper used by all four fetchImpl callers. Or inline the same three lines into each call site.

### NEW-P3-1: migration backfill comment about Postgres ROUND() is factually wrong
- File: `prisma/migrations/20260528120000_stream1_round1_fixes/migration.sql:64-67`
- 50-Failures category: **#34 "Logs not telemetry"** (documentation accuracy variant)
- Code:
    ```sql
    -- Banker's rounding is approximated
    -- here by Postgres ROUND() which uses half-to-even by default for
    -- NUMERIC. (Banker's rounding for NUMERIC in Postgres ≥9.x is the
    -- documented behaviour.)
    UPDATE "CoachAIBudget"
    SET "total_pack_actual_cents" =
      ROUND("pack_paid_cents"::numeric / "value_multiplier")::int
    WHERE "pack_paid_cents" > 0;
    ```
- Issue: Postgres docs (https://www.postgresql.org/docs/current/functions-math.html) state that `round(numeric)` uses **half-away-from-zero**, NOT half-to-even. Only `round(double precision)` uses banker's rounding ("round to nearest, ties to even"). The comment claims the opposite. For .5 boundary inputs the backfill will round UP where the service's runtime banker's-rounding would round DOWN (or vice versa) when the truncated value is even.
- Real-world impact: bounded. Production deploy ships round-0 + round-1 migrations together with no `pack_paid_cents > 0` rows in existence, so the backfill is a no-op at deploy. For any future migration replay against a populated DB, the worst case is 1 cent of drift per row that lands on an exact .5 boundary.
- Severity: **P3 advisory.** Not a correctness bug today; could be a correctness bug if the migration is ever replayed against populated data. Either correct the comment or change the SQL to use `round((pack_paid_cents::numeric / value_multiplier)::double precision)` for true banker's rounding.

---

## Verdict
**DIRTY (0 P0, 0 P1, 2 P2, 1 P3 — borderline)**

All 7 Round-1 P0 findings are VERIFIED FIXED or properly SKIPPED-WITH-CLEAR-TODO.
All 8 Round-1 P1 findings are VERIFIED FIXED (P1-1 properly `it.skip`, the rest implemented + tested).
Test surface is honest: skipped tests are actually `it.skip` (not silently-passing fakes) with clear TODOs.

**However**, two P2 issues remain:
- NEW-P2-1: partial test coverage on the mark-read → dormancy guard chain (audit asked for a direct integration test; fixer covered halves separately).
- NEW-P2-2: three pre-existing Stripe outbound paths (`cancelSubscription` DELETE/POST, `deleteSubscriptionItem` DELETE) still have no timeout. Pre-existing, out of strict P1-2 scope, but worth tracking.

Per the CLEAN bar in `AUDITOR_BRIEF.md`: "ZERO new P0 or P1 introduced by fix commits" — that bar is met. "0 P0 + 0 P1 + 0 P2" — NOT met (two P2 findings).

**Per the brief's strict reading, verdict is DIRTY.** However the P2s are both genuinely advisory:
- NEW-P2-1 is a ~20-line test gap, not a correctness bug.
- NEW-P2-2 is pre-existing surface in an unrelated billing method (out of the AI credits PR diff entirely except as a pattern-extension opportunity).

A reasonable parent agent may decide to MERGE this PR and track the two P2s as follow-up tickets, OR spin a Round-2 Fixer to clear them. Either path is defensible. I do NOT mark CLEAN per R32 — that decision is the parent's.

---

## Notes for Round-2 Fixer (if dispatched)

Two-line fix queue:

1. **NEW-P2-1 (mark-read integration test):** add to `test/ai-credits-round1-fixes.spec.ts` a `describe('Round1 P0-5 — markBriefRead flips dormancy')` block. Seed 3 unread briefs in the store; assert `DormancyGuardService.shouldSkipCoach` returns true; call `markBriefRead` on the most-recent brief (and have the mock set `read_at` on the matching row in `store.briefs`); assert `shouldSkipCoach` returns false. Roughly 25 lines, matches existing test patterns. The mock's `coachBrief` already supports `findMany`; add `updateMany` support if not present.

2. **NEW-P2-2 (Stripe timeout coverage):** factor the post-style timeout block into a private helper on `StripeApiService` and call it from all four `fetchImpl` callers (lines 302, 310, 365, 418). A diff of ~20 lines net plus a new test that exercises one of the previously-uncovered paths the same way T13 exercises `post()`.

## Notes for Parent

- The audit explicitly told the fixer to mark Postgres-rig-blocked tests as `it.skip` — the fixer did exactly this. The skip count went from 0 → 4 (T3 race, T9 signature, T10 RLS read, T11 RLS write). All carry `[needs Postgres rig]` markers and TODO comments. Round-2 audit chain should plan a testcontainers Postgres rig as Stream-1 Round-2 follow-up work — not a re-fix of this PR.
- The Mobile PR is separate per the spec; this audit covers Backend only.
- The audit doc body in `docs/audits/ai_*_2026-05-27.md` was flagged as P3 by Round-1 (pre-override prose remains as "historical context"). The fixer correctly DEFERRED this per round-1 advisory. No regression.
- R3-2 (Anthropic adapter timeout) was explicitly out of round-1 scope; the new-issues scan did not turn up regressions in the AI gateway path.

End of audit. I do NOT mark this PR clean. Parent decides.
