FIX ROUND 1 (B-LOCK-118, agent 118) — growth-project-mobile#352 @ ac244d22e107e93209a5e1d206d2951d3392fe38

Main merged first (merge commit `fe2fa580`, main `7fdb629a`, clean; #315 touched `src/services/README.md`, unchanged by this round). Then one fix commit `ac244d22`. Size: +2335 / -6 = 2,341 changed lines vs main (1,500-3,000 band: operator SIZE ASSESSMENT needed). Flag stays off; nothing here is used by a screen until #353.

| Finding | Change | Commit | Test (fails before -> passes after) |
|---|---|---|---|
| B-352-1 (Sol) lockout signal not owned by the account / auth generation | `dunningLockoutStore`: auth `generation`, `retire()` (clears signal + reference), `currentGeneration()`, `clear(forGeneration)`; retired on `authEvents` 'logout' and 'login' and in `resetUserScopedStores`. `api.ts` request interceptor stamps the generation before the token await; the 403 handler passes it and a retired generation's 403 is dropped (unstamped = generation 0, so fail closed after any boundary). Same-account token refresh keeps the generation. | ac244d22 | `api.lockedDunning.test.ts` "B-352-1" block (4), `authActions.signOut.test.ts` "retires the payment lockout" |
| C-352-4 (same lines) | 403 message no longer promises a card fix (true for a reversed payment too): `LOCKED_DUNNING_MESSAGE`. | ac244d22 | `api.lockedDunning.test.ts` "C-352-4" |
| Job: truthful vs production 643817b3 | `machineCode()`: only a SCREAMING_SNAKE `error` counts as a code. Production's `{ error: 'Not Found' }` 404 for the missing card/cancel routes now reads BILLING_ROUTE_NOT_AVAILABLE ("not available yet, so nothing was charged", not reported) instead of UNKNOWN + Sentry; a bare 503 reason phrase on confirm reads RESULT_NOT_CONFIRMED, never "nothing changed". | ac244d22 | `dunningL1Contract.test.ts` "today's production backend" (3) |
| B-353-2 / C-352-5 (L1 half) dispute facts dropped | `CardUpdateResponse.disputes` from confirm `plans[].dispute_open` merged with quote disputes (`QuoteDispute` now carries currency + amount); outcome copy keeps "Your bank reversed an earlier payment of X. Saving a card does not settle that." and a dispute-only save says "There was no open invoice to pay, so nothing was charged."; `cancelOutcomeCopy(r, { dispute })` keeps the backend limitation. | ac244d22 | `dunningL1Contract.test.ts` "dispute facts" (4) |
| B-353-2 (Sol) port | `runNativeCardUpdate` / `confirmWithBank` take `isCurrent`; new `retired` result; checked before and after every request and native step (setup, init, present, each confirm attempt, handleNextAction). Retirement claims nothing about requests already sent. | ac244d22 | `dunningL1Contract.test.ts` "retired screen" (3 + CONTROL) |

Failing-before (tests only on `fe2fa580`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220096264 (17 failed, 10 passed: every finding test fails, controls pass). After, at ac244d22 + Sol probe: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220787955 (27/27 pass).

Probe replay (both lenses, at ac244d22):
| Probe | Before (lens run) | Now |
|---|---|---|
| Sol `auditSol117DunningIdentity.test.ts` CONTROL current-account 403 sets signal | pass | pass |
| Sol CONTROL unrelated 403 | pass | pass |
| Sol B-352-1 logout retires prior account signal | fail | pass |
| Sol B-352-1 delayed account-A 403 cannot lock B | fail | pass |
| Opus #352 (APPROVE 0/0/6) | no probes | n/a |

Money list:
- Webhook order and redelivery: mobile handles no webhooks; lock state comes only from the server status read or a current-generation 403; confirm re-asks reuse the same SetupIntent and approval (backend idempotent).
- Concurrency: requests stamped per auth generation; a retired generation never writes; the native flow stops at every checkpoint once its owner is retired. No client-side locks, so no lock order.
- Terminal states: disputed: copy never promises a card fix and ending the plan says it does not settle the reversal; canceled (2A) and voluntary (option A) copy unchanged; deleted account / sign-out retire the signal.
- List completeness: quote normalizer still fails closed (complete, consistent totals); confirm dispute flags are never dropped, even from incomplete plan entries.
- Currency: integer minor units from the server; disputed amounts summed per currency only, never across currencies.
- Copy truth: no lock the server did not decide; route-absent copy is true on today's production (nothing was sent to the payment provider); no first person, no exclamation marks.

Checks at ac244d22: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220131133); CodeQL pass.

Follow-up Cs (frozen, in ops/reports/B-LOCK-118.md): C-352-1, C-352-2, C-352-3, C-352-6.

READY FOR AUDIT
