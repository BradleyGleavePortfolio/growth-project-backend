## Tier header

**Tier:** T4. This is stacked piece A of 3 of the #651 split. It is inert on its own.
**Why:** It adds the code that reads client data for Roman's grounding: plan, logs, safety-screen answers, coach thread and bookings. Because that is health and PII read code, it stays T4 even though nothing calls it until piece C.
**T4 trigger scan:** health/PII read paths (src/roman/context/*): yes. Auth: no new route is registered. RLS/migrations: none. Payments: none. Production config: none.
**T3 trigger scan:** one shared write-path hook (`src/ai/client-ai-context.service.ts` calls `romanContextInvalidate`; with no listener registered it does nothing). New copy appears only in the context route's error envelope.
**Bounded T1:** docs/roman-client-context.md.
**Builder-owner:** B-SCHED-ROMAN (agent 115, Claude Opus 5.5 builder). Code is carried from #651, whose earlier builders were agents 112, 113 and 114. Not self-audited.
**Acceptance evidence:** described below. The failing-before run on `ci/B-SCHED-ROMAN-A-before` is red at the tests-only commit `400808da`, and PR CI is green at the head.
**Promotion triggers:** none. Registering the controller or the providers in RomanModule happens only in piece C.

## What this is

This is stacked piece **A** (client context / grounding), split from #651 on the operator's ruling (11:08 PDT, owner PR-size doctrine). It is based on `main`. Piece B stacks on this branch, and piece C stacks on B.

1. `020b965d`: carries `src/roman/context/*`, the invalidation hook, docs, the persona fixtures and the builder tests verbatim from #651 @ `a8fa651c`. The injection tests that drive `RomanService` move to piece C with the wiring.
2. `400808da`: tests only. They fail before the fix.
3. `9d54333a`: the round-2 fixes for this piece's findings.

**Inert:** nothing registers `RomanClientContextService`, `RomanConsultationIntakeSource` or `RomanContextController` in a module, so no route or live turn changes until C. The invalidation hook has no listener until then.

**Size:** 4,113 changed lines. Non-test source plus docs is 2,212 lines, and the context builder alone is one 1,217-line class. That is above the OR-115-6 guide for new PRs. The operator split assigns all of `src/roman/context` to this piece, and splitting the class further would be a refactor, which FINISH MODE rules out. I am asking for an operator SIZE ASSESSMENT.

## Fix round (this piece's findings)

| Finding | Change | Commit | Failing-before test |
|---|---|---|---|
| B-651-10 (Sol B) | `GET /roman/context/me` now maps a transient read failure (Prisma P1001/P1002/P1008/P1017/P2024/P2034, initialization error, dropped transport) to a coded **503 `ROMAN_CONTEXT_UNAVAILABLE`** with specific retry copy. Any other failure becomes a coded **500 `ROMAN_CONTEXT_FAILED`** whose copy points to support with the request reference (`request_id` from the filter). Logs and Sentry carry the closed class/code tag only. `romanErrorTag` moved to `src/roman/roman-error-tag.ts` so the route and the service share it. | `9d54333a` | `test/roman/roman-context-round2.spec.ts`: Sol probe P2024 through the production `HttpExceptionFilter`, expecting 503 + code + copy rules + no canary. A second case expects an unexpected error to give 500 + code + support path + `request_id`. |
| C-651-4 (Opus + Sol C) | Expired memo entries are evicted on every lookup, the memo is capped at 500 entries, and the generation fence exists only while a build for that user is in flight (pruned when it settles). The stale-build fence still holds. | `9d54333a` | Same spec: 20 users then one later lookup leaves 1 entry; 50 invalidations leave 0 fences; control: a write during an in-flight build still keeps the stale bundle out. |
| C-651-7 (Opus + Sol C) | The header comment now describes the narrow `CoachingSession` booking select. | `9d54333a` | Comment only. |

### #651 finding -> stacked PR (operator split 11:08 PDT, owner PR-size doctrine)

Every open Opus (5964857917) and Sol (5964898255) finding from #651 @ `a8fa651c` maps to exactly one piece. Each is fixed there, with a failing-before test.

| Finding | Lens | What | Piece |
|---|---|---|---|
| B-651-1 | Opus + Sol | unknown provider usage settled as zero | **C** (live turns) |
| B-651-2 | Opus + Sol | rowing/swim "stroke" and past fainting routed to 911 | **B** (guardrails) |
| B-651-3 | Opus + Sol | treat / dose / negated starvation rewritten | **B** |
| B-651-4 (was C-651-6) | Sol (Opus C) | fixed reservation not an upper bound of the payload | **C** |
| B-651-5 | Sol | spend admission not atomic | **C** |
| B-651-6 | Sol | below-floor daily directive ("Eat 900 kcal per day", full-width digits) ships | **B** |
| B-651-7 | Sol | remaining/logged value validates a false target | **B** |
| B-651-8 | Sol | earlier rewrite skips medical/injury enforcement | **B** |
| B-651-9 | Sol | one exclamation per session still ships | **B** (post-check: zero marks; C drops the dead allowance wiring and prompt text) |
| B-651-10 | Sol | context route returns generic 500 | **A** (context) |
| C-651-4 | Opus + Sol | memo / generation maps never evicted | **A** |
| C-651-5 -> OR-115-1 | Opus + Sol | crisis words in audit action, ledger, logs | **B** (neutral `roman.safety_route` action + closed reason code + restricted read; C writes it from the turn path and drops router class/guardrail names from the ledger and logs) |
| C-651-7 | Opus + Sol | stale "CoachingSession is never read" comment | **A** |
| FR1-651-7 -> OR-115-2 | operator | keep: crisis 911/988 templates answer without box-2 consent; nothing reaches the provider | **B** (rule and templates), tested end to end in **C** |


## Checks
- r75: `node scripts/check-r75.js --mode=range --base=origin/main --head=HEAD` reports no positive token change.
- eslint: changed files have 0 errors. The 1 warning (unused `RomanConsultationSummary` import) is carried from #651.
- Copy: no "we/us/our", no exclamation marks, no generic error text.
- Logs: ids and closed codes only.

