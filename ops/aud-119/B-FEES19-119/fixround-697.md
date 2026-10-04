FIX ROUND 19 (B-FEES19-119, agent 119) — growth-project-backend#697 @ be7efc09d8a2caa2252b7ac51081e5ed6b8fa214

Builder B-FEES19-119 (Claude Opus 5.5, T4). Tests for #684 round 19 (B-684-12 both lenses, Sol B-684-3) and C-697-3 (Opus + Sol), plus the merge of #684 `c1a07d9c` (f70234ff). Size: 2,791 changed lines (this round +515, one new spec file), under the 3,000 grandfathered ceiling.

## Findings -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| C-697-3 (Opus: add L0-L3 with the #684 CAS; Sol: the three executed adversarial cases) | new `test/s-fee-r19-refund-cas-send-window.spec.ts` (13 cases). Status race: succeeded writer paused between its read and its SQL while failed (`refund.updated`) or canceled (`charge.refund.updated`, Stripe list succeeded at the stale read = Opus L2) completes; `charge.refunded` snapshot vs failed (L3); reverse order and insert race (P2002) controls; stale pending vs succeeded; bounded contention; legacy writer. L0 (sequential failed after succeeded) stays in r17 `applied, then failed`. Send window: email-attempt write crossing the deadline, attempt number taken by another worker, the real `NotificationsService.pushToUser` token read crossing the claim, the real `EmailService` send-log insert crossing the claim, and the signal itself | afe59a5d, 57972e21 (types/format), be7efc09 (no casts) | failing-before [run 37234800001](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37234800001) on unfixed `c2585c97`: 11 of 13 r19 cases fail (2 controls pass), with Opus L1-L3 and Sol's 3 residual cases; passing-after [run 37234844023](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37234844023) 394/394 across 31 suites incl. every prior probe of both lenses |

## Proof
- PR CI at this head: build-and-test green [run 37235200091](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37235200091); required checks pass=10, skipping=1.
- R75 `b644198b..be7efc09` OK (as any -14; as unknown as, as never, empty-catch net 0). The new spec reads the typed fake tables directly (no casts).
- Scratch fees top + main full suite: [run 37235329330](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37235329330) green (748 suites, 12,880 passed, 0 failed; tree `e4f86d6e931495a4a229311fdf19c8443d427b99`).

## Prior probes replayed
Every Opus and Sol probe for #684/#697 (FL-119, F4-119, F34-117, F34-116, prior-116/budget/opus/refunds) passes unchanged in run 37234844023; table on #684 FIX ROUND 19.

## Money self-check
Covered by the #684 FIX ROUND 19 (this piece is tests only): both writer orders, insert race, stale pending, contention fail-closed, deadline after every await up to the provider, attempt-number CAS, no false attempt exhaustion, next-run single delivery.

READY FOR AUDIT
