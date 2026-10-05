FIX ROUND 2 (B-LOCK2-120, agent 120) — growth-project-mobile#352 @ c89f719cd8f5863c4150af1da5b96e273df319d6

Main `cc4ceeed` merged first (merge commit `40706529`, clean, PR files byte-identical), then one fix commit `c89f719c`. Size: +2580 / -6 = 2,586 changed lines vs main (grandfathered cap 3,000).

Contract followed: backend D2c #705 @ `279ec167` (read only) answers a dispute with `reason: 'dispute_paused'`, `access_ended`, `billing_paused`, `restart_by: 'coach'` and no lock date, card or cancel route. Today's production has no dunning routes, so nothing here shows there (unchanged, `BILLING_ROUTE_NOT_AVAILABLE`). Older dispute envelopes with no `reason` get the same ruling copy.

| Finding | Change | Commit | Test (fails before -> passes after) |
|---|---|---|---|
| B-352-2 (Sol) mixed paid + disputed promised "Your plan updates within a few minutes"; dispute-only save lacked the three facts | `disputePauseFacts(coach, scope)` is the one R-DISPUTE-PAUSE sentence: "access has ended and billing is paused. Your coach, X, decides whether to restart it. It does not restart on its own or with a new card." `disputeNotSettledLine` (name kept for probe imports) = what the bank did + that sentence, per plan or plans, amounts per currency. With a disputed plan open, the access news in paid / in_progress / processing outcomes is scoped to "The plan you paid for" / "The plan it pays for"; paid title "Payment received" (not "Payment received, updating your plan"). | c89f719c | `dunningL1Contract.test.ts` "B-352-2 / B-352-7 / C-352-5" (6) |
| B-352-7 (Opus) "Email support to sort it out" / "settle" in card and end-plan outcomes | No support fix, no "settle", no restore wording. `cancelOutcomeCopy(r, { dispute })`: "Your bank had reversed a payment on this plan, so its access had already ended and its billing was paused. Only your coach can restart it." | c89f719c | same block, "ending a disputed plan" |
| Contract (job) D2c status | `normalizeDunningStatus` reads `reason` ('dispute_paused' / 'payment_failed' / null); a dispute pause is a dispute whatever `kind` says; a dispute never keeps a lock date (an older envelope's grace date is dropped); a failed payment keeps its date. | c89f719c | "R-DISPUTE-PAUSE status contract" (2) |
| B-352-3 (Sol) initStripe -> initPaymentSheet without an owner check; retired A could replace B's sheet | Owner re-checked between `initStripe` and `initPaymentSheet`, plus a module-wide newest-session latch (the SDK has one sheet per app): only the newest live update may initialize or present it; a retired or superseded update returns `retired` without touching it. | c89f719c | "B-352-3" (3): retired during initStripe, A-late vs B, newer supersedes older |

Failing-before (tests only, on `40706529`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342797540 (11 failed, 7 passed: every finding test fails, controls pass). After, at `c89f719c` + both lenses' probes: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342847558 (43/44, see probe 1 below). Same probes at the #353 head: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344434190.

Probe replay (both lenses, at `c89f719c`):
| Probe | Lens run | Now |
|---|---|---|
| Sol 119 `auditSol119Boundaries` 1 mixed paid/disputed | fail | substantive checks pass ("$150.00 went through" kept, no "Your plan updates within a few minutes"); its `toContain('Saving a card does not settle that')` anchor fails by design: Opus B-352-7 forbids "settle"; the ruling sentence replaces it. Operator decision D1 below |
| Sol 119 2 dispute-only save: billing paused, access ended, coach restarts | fail | pass |
| Sol 119 3 retired during initStripe: no initPaymentSheet | fail | pass |
| Sol 119 4 CONTROL non-disputed partial keeps "Your plan updates within a few minutes" | pass | pass |
| Sol 119 5 retired A cannot replace B's sheet | fail | pass |
| Sol 117 `auditSol117DunningIdentity` (2 CONTROL + 2 B-352-1) | pass | pass (4/4) |
| Opus 119 `aud119OpusL12_352` CONTROL no dispute, no line | pass | pass |
| Opus 119 dispute line: coach decides, no support fix | fail | pass |
| Opus 119 dispute line: billing paused, access ended | fail | pass |
| Opus 119 ending a disputed plan: coach restart rule | fail | pass |
| Opus 119 card saved during a dispute: no support fix | fail | pass |

Money list:
- Webhook order and redelivery: mobile handles no webhooks; state comes only from the status read or a current-generation 403. A closed dispute changes nothing in the app (the server keeps reporting the pause until the coach restarts).
- Concurrency and lock order: no client locks. The native sheet is owned by the newest live update; auth-generation ownership unchanged.
- Terminal states: dispute = access ended, billing paused, coach restarts; never a lock date, card fix or support fix. Canceled (2A) and voluntary copy unchanged.
- Pagination and fail-closed completeness: quote and status normalisers still fail closed; dispute flags from confirm plans and the quote are never dropped.
- Currency and minor units: integer minor units; disputed amounts summed per currency only.
- Copy truth: only server-decided facts; no first person, no exclamation marks, no emoji; true on today's production (nothing shown).

Checks at `c89f719c`: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285154); Analyze (javascript-typescript) and Analyze (actions) pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344285354).

Follow-up Cs (frozen, in ops/reports/B-LOCK2-120.md): C-352-1, C-352-2, C-352-3, C-352-6, C-352-8.

Operator decision D1: accept the ruling sentence over Sol 119's "does not settle" anchor (recommended default: accept; the lens re-pins the anchor).

READY FOR AUDIT
