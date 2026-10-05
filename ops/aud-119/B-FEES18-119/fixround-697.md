FIX ROUND 18 (B-FEES18-119, agent 119) — growth-project-backend#697 @ c2585c97e013ffbcd5c826d9547a686302e0bae6

Builder B-FEES18-119 (Claude Opus 5.5, T4). Tests for #684 FIX ROUND 17 (fixes are in #684 @ 9fb9c48f). Prior Opus verdict at 88c72200 was APPROVE 0/0/1 (5983739415); its C-697-2 is closed here. Size 2,276 changed lines (+2,276/-0, tests only, no `src` file): 1,831 before + 445 for the new spec. Commits: a5816328 (new spec), merges fac83858 and c2585c97 bring in #684 (merge-only, own-diff patch-id `bf28b41136bf`; the earlier own diff only gained the new spec file).

## Findings -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| Opus C-697-2 (refund-status tests never went through the webhook router) | new `test/s-fee-r17-refund-routing-status-notice-boundaries.spec.ts` drives `CheckoutWebhookHandler.handle` for `refund.updated` and `charge.refund.updated` | a5816328 | 4 router cases: succeeded claimed + 4,630 back once + notice; in-tx handoff `deferredPayoutNoticeChargeId`; both events apply once; failed moves nothing |
| Sol B-684-5 (#684) | 5 entitlement cases | a5816328 | full revoke + drops canceled; failed / canceled keep access; partial then completing partial; renewal 4,900 below plan 9,900; unreadable list -> `SFEE_REFUND_STATE_UNAVAILABLE`, nothing moved |
| Opus B-684-8 (#684) | 5 order cases | a5816328 | failed then late succeeded; late snapshot; stale pending; failure written while the apply waits for the lock; one alert + flag |
| Sol B-684-3 (#684) | 5 notice-boundary cases | a5816328 | claim/read budget; slow push gate; slow address read; push row kept; second worker on a later batch row |
| Sol C-697-1 | covered by the router, entitlement, delayed address-read and two-worker cases above | a5816328 | as above |

## Proof
- Failing-before on the unfixed stack (88c72200 + this spec): [run 37230855089](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230855089): 17 failed / 2 passed (controls: both events apply once; failed or canceled keeps access).
- Passing-after (spec + every prior probe of both lenses, unchanged): [run 37230897422](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230897422) green.
- PR CI at this head: build-and-test green [run 37231460271](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231460271); every required check passes.
- R75 `b644198b..c2585c97`: OK, no positive token change.

## Prior probes replayed
Sol AUD-SOL-F4-119 acceptance 7/7 and prior-116 / prior-budget / prior-opus / prior-refunds: pass. Opus AUD-OPUS-F4-119 R0-R2, S1-S5: pass. Opus AUD-OPUS-F34-117 #684, Sol AUD-SOL-F34-117 #684, Sol AUD-SOL-F34-116 #684: pass. Existing #697 suites (r13, r11, charge-settlement, settlement-sweep): pass.

## Money self-check
- Webhook order and redelivery: tested both event names, both orders, redelivery after failed, late snapshot.
- Concurrency (two workers, lock order): failure written while the apply waits for the lock (lock spy); second worker on a claimed notice row.
- Terminal states: refunded (access ends), failed / canceled (terminal, access kept); disputed and deleted account unchanged in this round.
- List pagination and completeness: an unreadable refund list fails closed before money and access.
- Currency: exact presentment minor units (4,900 charge, 172 fee, 4,630 coach net; 2,000 + 2,900 partials).
- Copy truth: no copy in this PR.

READY FOR AUDIT
