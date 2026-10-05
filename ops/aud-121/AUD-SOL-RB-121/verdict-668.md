AUDIT GPT-6.1 Sol — growth-project-backend#668 @ fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f — VERDICT: REQUEST CHANGES

Job AUD-SOL-RB-121; agent 121. Independent full T4 review. **A/B/C = 0/3/1.**

Read every changed source line and all changed/new specs, traced the provider/consent dependency and coach-budget API, and read the historical parent Sol verdict and C2 ownership disclosures; no current-round other-lens evidence was read. No approved-parent evidence is reused: parent #651 was [REQUEST CHANGES](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/651#issuecomment-5964898255).

## Evidence status

New probes and the affected existing Roman specs were submitted together to the [one GitHub CI lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365650631), based on this exact head plus probe-only commits. The lane remained queued during review because runners had not been assigned; **new probe results are not claimed as executed**. The concrete findings below follow directly from the reviewed code and have regression assertions in `test/roman/audit-sol-rb121-live-turns.spec.ts`; no local npm/Jest/tsc/build was run.

At handoff, GitHub accepted cancellation of that unstarted lane under the operator's queue-discipline rule; its audit branch and disposable worktrees were removed, and both probe files are preserved in `/home/user/workspace/ops/aud-121/AUD-SOL-RB-121/` for the fixing builder's failing-before/after runs. No local fallback was used.

## B — new findings owned here, fix before merge

**B-668-1 — Paid Roman turns bypass the coach's monthly AI pool.**

`src/roman/roman.service.ts:187-202,973-1025,1092-1113` has no coach-budget dependency, coach attribution, pre-call pool gate or `recordUsage` debit: it calls the consent-only `anthropicMessagesStream` directly and updates only the global `AiRequestAudit` spend ledger. `roman.module.ts:20-47` also wires no coach-budget integration, so no complete/partial/interrupted Roman generation debits `CoachAIBudget` and an exhausted coach pool cannot return its own budget code. ([Live-turn implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts), [Module wiring](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.module.ts))

The binding day-1 requirement assigns this missing debit to #668, not to the context pieces or the already disclosed C2 fixes.

Probes: successful generation asserts `CoachAIBudgetService.recordUsage` for the client's coach; a denied `canCharge` asserts zero provider calls and `COACH_AI_BUDGET_EXHAUSTED` (queued lane above). Minimal fix: resolve the current head-coach pool for client/coach callers, gate every paid attempt before dispatch, and meter every billed completed/partial/interrupted result through `recordUsage` with safe concurrency, period and minor-unit handling; return the dedicated pool-empty code. Do not charge a deterministic no-model crisis template.

**B-668-2 — The per-client daily cap does not emit either binding daily-quota code.**

`roman.controller.ts:112-139` checks `assertWithinRateLimit` for every ordinary request; `roman.service.ts:789-847` scopes that actual 50/500-turn rolling-24h quota to the caller but emits `ROMAN_RATE_LIMIT`. In contrast, `assertDailyCapacity:1183-1215` emits `ROMAN_CAPACITY_REACHED` for an all-user, all-role UTC-day cost sum with no `requester_id`/`subject_user_id` predicate, so that code does not signal exhaustion of this client's daily allotment. ([Controller gates](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.controller.ts), [Quota and global capacity](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts), [Limits and codes](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.constants.ts))

Probe: a free client's own count is 50 and its erased count is zero; assert the refusal uses `ROMAN_CAPACITY_REACHED` or `AI_DAILY_QUOTA_EXCEEDED` (queued lane above). Minimal fix: expose the specified client-daily-quota code on the client-scoped gate, retain reset/retry data, keep the pool-empty code distinct, and distinguish the optional global safety cap from personal-allotment exhaustion. The current per-user caps are 50/free and 500/pro-or-enterprise, hard-coded rather than env-configured; `ROMAN_DAILY_COST_CAP_USD` defaults to 25 for the global USD cap, not the client quota. ([Configured limits](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.constants.ts), [Cap implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts))

**B-668-3 — Live context conversion destroys kcal field/date provenance.**

`src/roman/roman.service.ts:1327-1343` pools today's individual food kcal, every wearable-day burned kcal, the wearable average, meal-plan slot kcal and prior days' intake into one `extra_kcal_facts` array. The lower piece then accepts that same array for both intake and burned families, allowing “You have logged 2500 kcal today.” when 2500 is burned energy and actual intake is 780, “You have logged 1850 kcal today.” when 1850 is yesterday's intake, and “You burned 200 kcal today.” when 200 is a meal. ([Live context conversion](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts), [Post-check fact consumption](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/0ec835ca1cc9697bde71e6c67ed627ea3a000691/src%2Froman%2Fguardrails%2Froman-post-check.ts))

Probe: `converter retains semantic field/date provenance` (three assertions, queued lane above). Minimal fix: preserve family, date and aggregation level through conversion and post-check comparison; validate today's total only against today's total, burned energy against matching burned-energy facts, and explicit historical/meal claims against their own facts. Keep useful meal/wearable facts rather than merely removing all grounding support.

## Previously disclosed C2-owned findings — still OPEN, not duplicated in this count

B-651-1 (unknown usage settled as zero), B-651-4 (fixed 24,000-token reservation before assembling the actual payload), B-651-5 (nonatomic reservation admission), OR-115-1's class-bearing audit/log/ledger turn-path application, and the obsolete exclamation prompt/tracking remain in the carried code. Their fixes are expressly assigned to #669, which remains tests-only at `6386c00b2bdbb2c120a5f173dea4753574d415e8`; they are not treated as cleared merely because #668 stays flag-gated. ([Carried live-turn code](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts), [C2 fix owner](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669))

The lane includes independent C2 counterexample assertions for unknown partial-stream usage, the neutral crisis audit action, concurrent admission and payload-bound reservation. The deterministic crisis path itself precedes consent/provider/spend checks and is retained per OR-115-2; ordinary turns are consent-gated before grounding and again at egress, and raw provider text is buffered before the post-check/persistence/emit. ([Turn ordering](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.service.ts))

## CI — exact failure attributed, not called a flake

At this exact head, the only failing returned check is [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148285365/job/111276620397). Its full REST log reports **1 failed / 12,472 passed**; `roman-launch-hardening.spec.ts:723` expected `Nice work! Keep it up.` and received the now-correct `Nice work. Keep it up.` ([Exact-head CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148285365/job/111276620397))

That obsolete one-exclamation assertion is specifically replaced by the no-exclamation assertion carried in #669; the other known C2 defects are not all detected by #668's existing suite, so this single red is **by-design stack skew**, not evidence that the rest of those defects are fixed. ([C2 test ownership](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669), [Obsolete assertion](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/test%2Froman%2Froman-launch-hardening.spec.ts))

Size is 2,159 changed lines, within the grandfathered 3,000 ceiling; stacked-base main-only checks still require normal operator evaluation after retargeting. ([PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668))

## C — separate follow-up

**C-668-4 (outside this diff):** `roman.controller.ts:166,182` attaches disconnect handling to request `close`; add a real HTTP integration test distinguishing completed request bodies from response disconnects, and move to the response lifecycle if that test shows the existing hook does not track the active SSE client. This predates the reviewed change and is not promoted to a new B here. ([Existing close hook](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f/src%2Froman%2Froman.controller.ts))

No PR branch changed, local test/build, merge, deployment, production/flag access or spend by this lens. Recommended default: fix these three owned Bs, complete #669's disclosed repairs, land/evaluate the stack together, and keep Roman flags unchanged until dual approvals and required checks support activation.
