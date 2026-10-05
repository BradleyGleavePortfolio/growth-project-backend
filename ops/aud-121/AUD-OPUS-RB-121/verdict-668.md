AUDIT Claude Opus 5.5 — growth-project-backend#668 @ fabc2268ffde1e6dca3ea1a18d6bff49c69f7b6f — VERDICT: REQUEST CHANGES

AUD-OPUS-RB-121, agent 121. First full T4 review of C1 (live-turn wiring: AI egress, spend, crisis routing, health copy). **A/B/C = 0/1/4.**

I read all 15 files of `fabc2268` line by line: `roman.service.ts`, `roman.controller.ts`, `roman.module.ts`, `roman.prompts.ts`, `roman.constants.ts`, `anthropic-client.provider.ts`, `env-validation.ts`, `.env.example` and the 7 spec files. The guardrail code it wires is reviewed in my #666 verdict (B-666-1/2/3 apply here once wired).

### What holds
- **Order of gates per turn:**
  - feature flag;
  - SafetyRouter on the same `dto.content` the controller classified;
  - crisis template (no provider, no consent, no spend; rate limit, consent and capacity skipped for crisis only, `roman.controller.ts:112-139`);
  - `egress.assertMaySend` before any client data or reservation (`roman.service.ts:975`);
  - reservation;
  - one grounding bundle (degraded mode on failure, sanitized logs);
  - buffered reply;
  - post-check;
  - persist once;
  - emit.

  No unchecked text is streamed or stored (A-R4-4). Disconnect forwards the abort upstream.
- **Crisis exemption.** The crisis exemption (rate limit, consent and cap skipped) depends entirely on `isSafetyShortCircuit`. So my #666 A-666-1 (acute anaphylaxis and overdose phrasing classified `normal`) shows up on this path as a consent 403 for a client in crisis. It is counted once, on #666.
- **Wiring.** `RomanModule` registers `RomanClientContextService`, the real consultation source and `GET /roman/context/me` (JwtAuthGuard, RolesGuard, RomanFeatureGuard, students only). AuditService resolves through the @Global AuditModule. The model id matches the coach AI (`claude-sonnet-4-6`). `ROMAN_DAILY_COST_CAP_USD` is registered in ENV_RULES (optional; default and invalid both mean 25).
- **Client daily cap (day-1 requirement).** It is present per client: 429 `ROMAN_RATE_LIMIT`, 50 user turns per rolling 24 h for every student (`ROMAN_RATE_LIMIT_FREE_PER_DAY`, a constant, not an env). Students never have a CoachSubscription row, so they are always on the free tier. Erased chats still count, and crisis turns are exempt. `ROMAN_CAPACITY_REACHED` (503) is a separate platform-wide spend breaker (see the INFO below).
- **CI: unstable, red by design.** 10 of 11 checks are green. `build-and-test` fails only `test/roman/roman-launch-hardening.spec.ts` › "FR1-651-3 the single per-session exclamation is spent once" (Expected "Nice work! Keep it up.", Received "Nice work. Keep it up."; 1 failed / 12,472 passed; [run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148285365/job/111276620397)). The cause is #666's B-651-9 scrub. #669 (6386c00b) replaces that describe with "B-651-9 (supersedes FR1-651-3)". Nothing else is red. This is the by-design red that #669 carries.
- **Carried findings, owned by #669 (C2) and not counted here:**
  - B-651-1: `?? 0` settles at `:1057/:1096/:1102`.
  - B-651-4: fixed 24,000-token reservation at `:1231`.
  - B-651-5: non-atomic create-then-aggregate at `:1234-1252`.
  - OR-115-1 turn path: `:946-956` still writes `roman.safety_emergency` / `roman.safety_self_harm` and logs `router=`. My probe CARRIED-668 confirms this at this head.
  - B-651-9 dead allowance wiring at `:1074/:1090`.

  #669 is tests-only at 6386c00b; its fix commit is not written yet. C1 and C2 land as one.

### B-668-1: no live Roman turn checks or debits the coach's AI credit pool (CoachAIBudget), and there is no pool-empty code (owner 11:40-11:41, A6.4: "Roman must debit the pool on every turn")
- **Evidence:**
  - `src/roman/**` has no reference to `CoachAIBudgetService`, `canCharge` or `recordUsage` at any head #667-#670 (`git grep` over pr667..pr670).
  - Roman calls Anthropic through its own egress path (`roman.service.ts:1014`), not the AI gateway. The gateway is what does the pre-check and the debit (`src/ai/gateway/ai-gateway.service.ts:244-262` `canCharge`, `:350-372` `recordUsage`).
  - Result: clients and coaches use Roman without drawing down the coach's monthly pool. An empty pool never stops Roman, and the mobile app gets no distinct pool-empty code.
- **Probe** (`test/roman/audit-opus-rb121.probe.spec.ts` › B-668-1):
  - A paid client turn through the real `RomanService` reaches the provider once and touches only `aiRequestAudit`, `romanMessage`, `romanSession` and `$transaction`. It never touches `coachAIBudget`.
  - A source scan of `src/roman` finds no `CoachAIBudgetService`, `.canCharge(` or `.recordUsage(`.
- **Fix rule** (fits under the 3,000 ceiling: about 840 lines of headroom):
  1. Inject `CoachAIBudgetService` into `RomanService`. `AiCreditsModule` is @Global.
  2. Resolve the budget coach:
     - student: `User.coach_id`, then `resolveHeadCoachId`;
     - coach: `resolveHeadCoachId(self)`;
     - owner: none.
  3. Pre-check: in the controller, next to `assertDailyCapacity` (`roman.controller.ts:139`), before the user turn is stored. Re-check in the service before the provider call.
  4. Pool exhausted: return 402 `COACH_AI_BUDGET_EXHAUSTED` (the `CoachAiBudgetExhaustedException` body), with client and coach copy distinct from the daily-cap copy.
  5. Debit after every settle path that spent tokens (ok, interrupted, session_gone, persist_failed, model_error with usage): `recordUsage({ coachId, capability: 'roman.chat', actualCostCents: ceil(costUsd*100), contextId: requestId })`, using the same token numbers as `settleSpend`. When usage is unknown, use the reservation values (B-651-1).
  6. Crisis templates stay exempt (no spend).
- **How to verify:**
  - a debit happens on ok and interrupted turns;
  - with the pool exhausted, the 402 comes before any provider call and before the user turn is stored;
  - a crisis turn with an exhausted pool is still answered;
  - a sub-coach's client debits the head coach;
  - the B-668-1 probe tests go green (adjust the access probe if the debit goes through the service rather than raw Prisma).

### C (follow-ups, not blocking)
- **C-668-2:** coach-surface crisis. `classifySafety` runs on every surface (`roman.service.ts:936`). A coach asking "My client told me she wants to kill herself, how do I respond?" gets the client-voiced 988 template, and a crisis audit row is written with the coach as actor. Fix: a coach-facing template on the coach surface (how to point the client to 911/988), or the model with a hint.
- **C-668-3** (outside this diff, pre-existing): `roman.controller.ts:166` uses `req.on('close')`. Since Node 16 that event means the request completed, not that the client disconnected. Fix: use `res.on('close')` with `!res.writableFinished`. B-651-1's interrupted path depends on it.
- **C-668-4:** `romanErrorTag`, `romanSanitizedError` and `ROMAN_LOGGABLE_ERROR_NAMES` are duplicated in `roman.service.ts:1355-1408` and in A's `src/roman/roman-error-tag.ts`. The C2 recipe dedupes them; keep one copy.
- **C-668-5:** `postCheckContextOf` (`roman.service.ts:1327-1345`) pools meal-plan slot kcal, wearable active kcal and every last-7-day kcal into `extra_kcal_facts`. `kcalFacts` uses that pool for both the intake and burned families (`roman-post-check.ts:224-229`). So "You have logged 450 kcal today" passes when any meal-plan slot is 450. Fix: keep facts per family.

### INFO for the operator (not a finding on this PR)
The probe INFO-668 shows that `assertDailyCapacity` / `reserveDailySpend` aggregate every requester (no `requester_id` filter). With $27 spent by other users, a client who has used nothing today gets 503 `ROMAN_CAPACITY_REACHED` ("Roman has reached his limit of conversations for today…").
- This is a platform-wide breaker (`ROMAN_DAILY_COST_CAP_USD`, default 25 USD per UTC day). It is not the per-client cap.
- The owner's pop-up "You've used your maximum AI allotment today." therefore belongs on 429 `ROMAN_RATE_LIMIT` (and `AI_DAILY_QUOTA_EXCEEDED` for other AI features), never on `ROMAN_CAPACITY_REACHED`.

### Evidence
- **Probe spec** (audit only, never pushed to a PR branch): branch `audit/AUD-OPUS-RB-121/668-p2`, cut from this exact head with the spec only.
- **CI lane:** run [37369679248](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37369679248) (still queued at posting, 13:28 PDT; GitHub runner incident). The first lane, 37366931338, was queued for 20 minutes and then cancelled after a type fix to the spec.
- **Local run, per the operator's 20-minute rule:** `ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/audit-opus-rb121.probe.spec.ts` gives **26 failed / 12 passed**. For this PR:
  - B-668-1: both tests fail. Models touched were `aiRequestAudit`, `romanMessage` and `$transaction`, with 1 provider call.
  - INFO-668 passes: the aggregate `where` is `{"capability":"roman.chat","created_at":{"gte":"2026-10-05T00:00:00.000Z"}}`, and the response code is `ROMAN_CAPACITY_REACHED`.
  - CARRIED-668 fails as expected: the action is `roman.safety_emergency`.
  - "B-666-4 at #668" fails, showing the A-666-1 consequence on this turn path.
- **Evidence reuse:** none; my lens never approved #651.

No push to this branch, merge, dispatch or production action by this lens. Head re-read before posting: unchanged.
