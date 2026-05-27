# Codebase Hygiene Findings — R1 Bar Violations

**Source:** User-provided observations, 2026-05-26 (two batches: 8 controller-hygiene + 9 billing/AI)
**Repo:** `growth-project-backend`
**Status:** TRACKED — to address after CNAME / Dunning / Nudge train completes
**R1 reference:** "Does this raise the bar of quality OR hold the bar at decacorn quality?"

**Batches:**
- Batch 1 (Findings #1-#8): Controller hygiene — @Roles, throttle parity, cursor pagination, DTO validation, guard hoisting, dead routes, Swagger
- Batch 2 (Findings #9-#17): Billing + AI — duplicated controllers, missing throttles on Stripe/LLM mints, no cost caps, prompt injection, offset pagination

---

## Ranking Methodology

Each finding is scored on three R1-relevant axes:
- **Security/safety blast radius** — can this leak data, expose admin actions, or be enumerated?
- **Operational rot** — how fast does this become a load-bearing wart that compounds?
- **Decacorn-grade visible quality** — would Stripe/Notion ship this? Does an external auditor / new operator see this and lose trust?

**Severity tiers:**
- **P1 — Active R1 violation, ship-blocker quality**: security gap or correctness gap visible from outside
- **P2 — Holds the bar back, must fix before scale**: silent fragility or known gap with no SLA
- **P3 — Documentation/polish debt**: doesn't fail, but a decacorn wouldn't have it

---

## Ranked Findings (Worst R1 Breakage First)

### #1 — P1 — Missing `@Roles` on coach-messaging (Security gap)
**File:** `src/messaging/coach-messaging.controller.ts:31-32`
**Why this is the worst:** It's a *known* gap explicitly documented in code (line 25 comment says it was skipped to avoid regressions during the C1-C6 hardening pass). The `roles-enforced.spec.ts` allowlist confirms the gap is institutionalized. This is the textbook R1 failure: a security invariant deliberately left broken with a comment. Decacorns close these *before* moving on — they don't ship "we know it's broken, here's why" as the final state. Every other controller has explicit `@Roles` metadata; this one being the exception means the next person touching authz code has to remember a special case forever.
**Fix:** Add explicit `@Roles(Role.COACH)` (or appropriate set) to the class and/or each handler. Remove from `roles-enforced.spec.ts` allowlist. Verify behavior is identical to the implicit `CoachGuard` path.

---

### #2 — P1 — IP-only throttle on storefront GET (Enumeration vector)
**File:** `src/storefront/storefront-public.controller.ts:55`
**Why:** A5-P1-5 hardened the POST but missed the GET on the same controller. Token scanners can still enumerate 60/min/IP through the GET — exact same primitive the POST fix was meant to close. Half-applied security fix is an R1 violation because it tells anyone reading the diff "we fixed the visible thing and stopped." Decacorns finish the hardening pass; they don't leave the matching GET unprotected.
**Fix:** Apply the same composite `(share_token, IP)` throttle key from the POST to the GET. Add a regression test that asserts both endpoints share the throttle namespace.

---

### #3 — P1 — Admin list endpoints unbounded / no cursor pagination
**File:** `src/admin/admin.controller.ts:65-86` (`GET /admin/coaches`, `GET /admin/users`)
**Why:** Your *own codebase* already has the correct pattern at `checkout.controller.ts:133-145` (`{items, hasMore, next_cursor}`). The admin endpoints diverge from your own internal convention. As scale grows this becomes either an unbounded DB scan or a silently truncating list — both are wire-into-prod hazards. R1 fails the moment the same primitive has two implementations in one repo; the codebase is the contract.
**Fix:** Migrate both endpoints to cursor-based pagination matching `listPurchases`. Add e2e tests for `next_cursor` round-trip.

---

### #4 — P2 — Raw `parseInt` without DTO validation
**File:** `src/admin/admin.controller.ts:59, 84, 123, 138, 147, 168, 202, 289`
**Why:** Scattered `parseInt(limitRaw, 10)` across 8 handler bodies is the textbook "no validation layer" smell. `"0"`, `"-1"`, `"NaN"`, `"99999999"` all produce silent divergent fallback logic per handler. Inconsistent input handling is an R1 violation because every handler now has its own private contract — there is no single source of truth for "what is a valid limit." Same controller as #3, so the fragility compounds.
**Fix:** Introduce `PaginationQueryDto` with `@IsOptional() @IsInt() @Min(1) @Max(200) limit?: number` (plus `cursor?: string`). Use it on every paginated list endpoint repo-wide. Add lint rule or grep test that fails if a handler calls `parseInt` on a query param.

---

### #5 — P2 — `@UseGuards` repeated per handler on real-meal-plans
**File:** `src/real-meal-plans/real-meal-plans.controller.ts:37, 44, 50, 56, 66, 78, 85, 91, 97, 107, 113, 125`
**Why:** Repeating `@UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)` on 12 handlers is the classic "ships unguarded the day someone adds handler 13" footgun. `checkout.controller.ts:82` already shows the right pattern (class-level). This is a latent security regression — not broken today, but the contract is that the *next* route added to this controller is unprotected.
**Fix:** Lift the three guards to a single class-level `@UseGuards()` at line 33. Verify with a roles/auth regression test that every handler still rejects unauthenticated/non-coach/no-sub callers.

---

### #6 — P2 — Dead 410 endpoint with no SLA
**File:** `src/users/users.controller.ts:75-87` (`GET /users/me/badges`)
**Why:** `// TODO: remove route entirely after one mobile release window` with no issue number, no date, no owner. This is the canonical "permanent temporary" — every codebase has them and they're R1 violations because they prove the team doesn't enforce closure. The route lives forever, eventually someone reuses the path, and the GoneException becomes a wart.
**Fix:** Either (a) delete now if the mobile window has passed, or (b) tag with a concrete removal date + GitHub issue link. Add a CI check that fails on `TODO:` comments without an issue reference.

---

### #7 — P3 — Zero `@ApiOperation` on `admin.controller.ts` (27 endpoints)
**File:** `src/admin/admin.controller.ts` (all endpoints, esp. `POST /admin/gdpr/scrub` line 279, `POST /admin/users/:id/promote` line 88)
**Why:** Documentation debt — but on the *most sensitive surface in the app*. GDPR scrub triggers, user promotion, federation reads, finance health, all opaque in OpenAPI. R1 violation rationale: a decacorn ships machine-readable contracts for admin tooling because operators / SREs / compliance auditors live in OpenAPI. Ranked below the security/correctness items but above the other Swagger gap because of the *content sensitivity*.
**Fix:** Add `@ApiOperation({ summary, description })` to all 27 endpoints. Start with highest-risk: GDPR scrub, user promotion, federation, finance health. Add lint rule: `@Controller('admin')` requires `@ApiOperation` on every handler.

---

### #8 — P3 — Zero `@ApiOperation` on `payment-ops.controller.ts` (29 endpoints)
**File:** `src/checkout/payment-ops.controller.ts` (all 29 endpoints, starting line 69)
**Why:** Same class of bug as #7 — your most complex controller has blank auto-generated docs. `scheduling.controller.ts:69-235` is the correct in-repo pattern. Ranked below #7 because payment-ops is operator-facing internal surface, not the GDPR/promote blast radius, but it's the larger volume of undocumented endpoints.
**Fix:** Add `@ApiOperation` per endpoint, mirroring `scheduling.controller.ts` style. Same lint rule as #7.

---

---

# Batch 2 — Billing + AI Findings (#9–#17)

User-provided 2026-05-26 post-batch-1. Ranked into the master ordering at the end.

---

## #9 (P1) — No per-coach AI cumulative spend cap (A2)
**File:** `src/ai/coach/coach-ai.service.ts:366-378` records cost but never reads sum. Controllers `src/ai/coach/coach-ai.controller.ts:68, 81, 94`.
**Why this is one of the worst:** Per-hour rate limits (5-10/hr) bound *request count* but not *dollar cost*. At Sonnet-class pricing, a single coach burning their hourly quota = ~$2-5/hr/coach. 1,000 coaches × hostile pattern × 24h = real money. There is no kill switch at the dollar level. R1 violation: a decacorn never ships an LLM endpoint without a server-side dollar cap because LLM cost is the only line item on the P&L that can hockey-stick without a feature change.
**Fix:** Add `checkCoachAIBudget(coachId)` before each generation call. Sum `costCents` for rolling 24h window. Throw 402 `BUDGET_EXCEEDED` above configurable ceiling. Default ceiling ~$5/day/coach to start; tune from data.

---

## #10 (P1) — Prompt injection via unvalidated `conversation_history` (A3)
**File:** `src/ai/gateway/ai-gateway.controller.ts:62-69, 83`
**Why:** `conversation_history` is TypeScript-typed only — at runtime, callers can inject `role: 'system'` messages inside the array. Some providers treat in-history system messages differently from top-level system prompts, opening prompt injection. Combined with #11 (no length cap), this is a controllable adversarial surface.
**Fix:** Introduce `GatewayInvokeDto` with class-validator: `@IsArray() @ArrayMaxSize(50) conversation_history`, each item validated for `role IN ('user','assistant')` (no `system`), `@MaxLength(500)` on content. Strip/reject any `system`-role entries server-side regardless of throttle.

---

## #11 (P1) — `ai-gateway` body is inline type, no class-validator (A1)
**File:** `src/ai/gateway/ai-gateway.controller.ts:62-69`
**Why:** Same class as Batch 1 #4 but on the AI gateway, where the blast radius is dollars not just data quality. Inline `@Body()` types are not validated by `ValidationPipe` — `whitelist: true` does nothing for them. 1,000-item conversation arrays are accepted today, only the 20/hr throttle saves you. Doubles as the #10 vector. `checkout.controller.ts:43-60` already shows the right DTO pattern with `@MaxLength(512)`.
**Fix:** Replace with full DTO class. `@MaxLength(2000)` on top-level `message`, array + per-item caps on `conversation_history`. Required for #10 to work.

---

## #12 (P1) — `OwnerBillingController` no throttle + no @ApiOperation (B3)
**File:** `src/billing/owner-billing.controller.ts:49-58, 69`
**Why:** `POST /v1/admin/coaches/:id/start-subscription` calls `stripeApi.createCustomer` + `stripeApi.createSubscription` with zero throttle. A misbehaving client burns real Stripe API quota *and* creates real Stripe customers. This is the same class as Batch 1 #2 (half-applied throttle) but on a higher-cost surface — Stripe customer creation has billing/auditability consequences your storefront enumeration does not.
**Fix:** Class-level `@Throttle({ default: { ttl: 60_000, limit: 5 } })` per owner. Add `@ApiOperation` per endpoint (matches the Batch 1 #7 pattern).

---

## #13 (P1) — `start-subscription` `plan` field unvalidated (B4)
**File:** `src/billing/owner-billing.controller.ts:73, 166`
**Why:** `@Body() body: { plan?: 'flat_300'; trialDays?: number } = {}` is an inline TS type. `ValidationPipe` ignores it. The `plan` string flows untouched into `subscription.metadata` at line 166. Adversary submits `plan: 'enterprise_hack'`, you store it on a real Stripe subscription's metadata. Worse, `trialDays` has *manual* validation at line 116 — proving the team knows DTOs are needed and just didn't write one. Half-validated = R1 violation.
**Fix:** Proper DTO with `@IsIn(['flat_300'])` on plan, `@IsInt() @Min(0) @Max(90)` on trialDays. Remove the manual line-116 check (DTO replaces it).

---

## #14 (P1) — `portal-session` minting has no throttle (B2)
**File:** `src/billing/coach-billing.controller.ts:54, mobile-coach-billing.controller.ts:88`
**Why:** Stripe Billing Portal session mint = live Stripe API call. No throttle on either route. Same primitive as Batch 1 #2 (storefront GET) — calling a paid/rate-limited downstream without throttle = R1 violation. `checkout.controller.ts:100-107` already shows the right pattern with `THROTTLER_NAMES.CHECKOUT_MINT`. Two unprotected callsites = adversary picks whichever has the smaller throttle. Here, neither does.
**Fix:** Introduce `THROTTLER_NAMES.BILLING_PORTAL_MINT` (e.g. 10/hour/coach). Apply to both controllers. Required to share via #15 below.

---

## #15 (P2) — Portal-session duplicated across two controllers (B1)
**File:** `src/billing/coach-billing.controller.ts:54-115` vs `mobile-coach-billing.controller.ts:88-141`
**Why:** Two near-identical 60-line implementations. Diff = ~6 lines of comments + route name. If the customer-id fallback chain ever gains a third source, two places to update — guaranteed drift. Same primitive, two contracts = R1 violation (see Batch 1 #3 admin lists for the parallel).
**Fix:** Extract `BillingService.resolvePortalSession(coachId)`. Both controllers become thin pass-throughs. Single throttle decorator at each route + shared error mapping.

---

## #16 (P2) — `coach-ai` throttles share the default bucket (A5)
**File:** `src/ai/coach/coach-ai.controller.ts:68, 81, 94`
**Why:** Using `@Throttle({ default: ... })` means AI generation competes with every other default-bucket route. Normal browsing eats into AI quota and vice versa. Worse, you can't independently *observe* AI throttle health in metrics — it's commingled with chat, check-ins, everything. `messaging/coach-messaging.controller.ts:49` already shows the named-bucket pattern (`THROTTLER_NAMES.COACH_MESSAGES`).
**Fix:** Add `THROTTLER_NAMES.COACH_AI_GENERATION` in `throttler.config.ts`. Switch all 3 generation endpoints. Now AI spend envelope is independently observable + tunable from config.

---

## #17 (P2) — `coach-brief/history` uses offset pagination (A4)
**File:** `src/coach/brief/coach-brief.controller.ts:72-82`
**Why:** Classic `page/limit` pagination. New brief generated between page 1 and 2 = row shifts, page 2 skips a brief silently. Every other post-audit list surface uses cursor (keyset). Same class as Batch 1 #3 (admin list pagination divergence) — but on a smaller blast radius because brief volume is per-coach not platform-wide.
**Fix:** Replace with `before` cursor on `brief_date` or `id`. Match `checkout.controller.ts:133-145` shape exactly.

---

# Master Ranking (Both Batches Combined, Worst → Least)

| # | Finding | Sev | Primitive | Blast radius |
|---|---|---|---|---|
| **1** | Batch1 #1 — coach-messaging missing `@Roles` | **P1** | Security — RBAC | Auth bypass, known + commented |
| **2** | Batch2 #9 — No per-coach AI cumulative spend cap | **P1** | $$$ — LLM cost | Direct P&L hit, no kill switch |
| **3** | Batch2 #10 — Prompt injection via `conversation_history` | **P1** | Security — prompt injection | Model behavior hijack |
| **4** | Batch1 #2 — storefront GET IP-only throttle | **P1** | Security — enumeration | Half-applied A5-P1-5 |
| **5** | Batch2 #12 — OwnerBilling no throttle on Stripe mint | **P1** | $$$ — Stripe API + real customer rows | Real customers created on hostile loop |
| **6** | Batch2 #13 — start-subscription `plan` unvalidated | **P1** | Data integrity — Stripe metadata | Arbitrary strings on real subs |
| **7** | Batch2 #14 — portal-session mint no throttle (×2 controllers) | **P1** | $$$ — Stripe API | Half-applied; mirror of #4 |
| **8** | Batch2 #11 — ai-gateway body inline type, no validator | **P1** | Security + $$$ — prereq for #10 fix | Enables #10 |
| **9** | Batch1 #3 — Admin list endpoints unbounded (no cursor) | **P1** | Correctness + scale | Diverges from own pattern |
| **10** | Batch1 #4 — Raw `parseInt` on admin (×8 sites) | **P2** | Input validation | 8 private contracts |
| **11** | Batch2 #15 — Portal-session logic duplicated ×2 | **P2** | Drift — two implementations | Future-bug guarantee |
| **12** | Batch2 #16 — coach-ai throttles share default bucket | **P2** | Observability + isolation | Can't tune AI envelope independently |
| **13** | Batch1 #5 — real-meal-plans per-handler `@UseGuards` ×12 | **P2** | Footgun — guard hoisting | Next handler unguarded |
| **14** | Batch2 #17 — coach-brief offset pagination | **P2** | Correctness — list integrity | Per-coach blast radius |
| **15** | Batch1 #6 — Dead 410 with no SLA | **P2** | Closure discipline | Permanent-temporary |
| **16** | Batch1 #7 — admin.controller zero @ApiOperation | **P3** | Doc — GDPR/promote/finance opaque | Highest-sensitivity surface |
| **17** | Batch1 #8 — payment-ops zero @ApiOperation | **P3** | Doc — 29 endpoints blank | Operator surface |

---

## Cross-Cutting Patterns (Updated)

1. **`admin.controller.ts` appears in 3 findings** (Batch1 #3, #4, #7). Highest-debt file. Dedicated sweep PR.
2. **Half-applied security/throttle fixes recur**: Batch1 #2 (storefront GET), Batch2 #12 (OwnerBilling), Batch2 #14 (portal-session ×2). Every fix to a security primitive must check sibling endpoints/controllers before closure. **New audit rule needed: "when fixing a throttle/auth/validation primitive, grep the whole repo for siblings using the same primitive and fix all or document the gap."**
3. **Inline `@Body()` types are systematically broken** (Batch1 #4 admin parseInt, Batch2 #11 ai-gateway, Batch2 #13 owner-billing plan). `ValidationPipe` cannot do its job. **Lint rule: any `@Body()` parameter must be a class — fail CI on inline type annotations.**
4. **LLM cost is unbounded** (Batch2 #9 + #10 + #11 + #16). This is the most expensive omission in the repo — one bad actor or buggy client = direct dollar burn. **Dedicated AI hardening PR is the single highest-leverage cleanup; bundle #9-#11 + #16.**
5. **Duplicated controllers / shared logic in two places** (Batch2 #15 portal-session, similar pattern with checkout vs mobile-checkout). Pattern: extract to service, controllers become thin pass-throughs.
6. **No CI enforcement of conventions** still true and now stronger:
   - `@Controller()` paginated list → must use `PaginationQueryDto` / cursor (covers Batch1 #3, Batch2 #17)
   - `@Controller('admin')` → `@ApiOperation` required (Batch1 #7-#8)
   - `TODO:` without issue ref fails (Batch1 #6)
   - `@UseGuards` repeated on >2 handlers warning (Batch1 #5)
   - **NEW:** Any `@Body()` must be a class, not inline (Batch1 #4, Batch2 #11, #13)
   - **NEW:** Any controller method that calls `stripeApi.*` or AI provider client must have a `@Throttle` decorator (Batch1 #2, Batch2 #12, #14)
   - **NEW:** `THROTTLER_NAMES.*` must be used (no `default` bucket on cost-bearing routes) (Batch2 #16)

---

## Suggested Sequencing (post CNAME / Dunning / Nudge train)

**Recommended grouping into 4 focused PRs** (smaller PRs = friendlier audits):

| PR | Scope | Findings | Effort | Why grouped |
|---|---|---|---|---|
| **PR-A: AI cost + security hardening** | Add cumulative spend cap + `GatewayInvokeDto` + dedicated throttle bucket + reject in-history system role | #9, #10, #11, #16 | M | Single subsystem, all interlock |
| **PR-B: Stripe/Billing hardening** | Portal-session throttle + service extraction + OwnerBilling throttle/Swagger + start-subscription DTO | #12, #13, #14, #15 | M | Single subsystem |
| **PR-C: Security parity sweep** | coach-messaging @Roles + storefront GET throttle + real-meal-plans guard lift | #1, #4 (Batch1), #5 (Batch1) | S | All P1/P2 security parity fixes |
| **PR-D: Admin controller cleanup** | Cursor pagination + PaginationQueryDto + Swagger across admin.controller + coach-brief offset → cursor + dead-410 cleanup | #3, #4 (Batch1), #6, #7, #17 | M | Single-file majority + matching pagination |
| **PR-E: payment-ops Swagger pass** | Annotate all 29 payment-ops endpoints | #8 | M | Isolated annotation work |
| **PR-F: CI lint rules** | All conventions encoded as failing-CI checks | (covers all batches) | M | Last — prevents future regressions |

**Total: 6 PRs.** Sequence A → B → C → D → E → F. A first because LLM cost is the actively bleeding edge.

## Total estimate
~6 small/medium PRs. ~3-5 day full sweep at sustained pace with audit cycles between each.
