# B-RECUR7A-119 — recurring R1 #678 + R2 #679 fix round 7 (agent 119)

Started Sun Oct  4 12:46:27 PDT 2026. Lock taken: ops/lanes119/locks/recurring-r12.
Heads at start: #678 77bce4505b12586a0fe1080246d97217f0834f1c, #679 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca, #701 72eb096b.
Findings: Sol B-678-3, B-678-4, B-679-10 (narrowed), B-679-11. Opus lens verdict pending.

## Log
- Sun Oct  4 12:46:27 PDT 2026 start; rules + job entry + Sol/Opus reports + B-RECUR6A-118 report read.

- 12:50 operator: Opus R12-119 APPROVE #678 0/0/2, #679 0/0/1; round = Sol B-678-3, B-678-4, B-679-10, B-679-11; B-678-3 fix must cover Opus C-678-4.
- R1 fix (local b7a119/r1): 7ec88952 test, 7b0743cd fix. sendFenced locks client+coach FOR KEY SHARE (id order), alive check both (coach gone -> 'closed'), claim/read-back/bind re-prove coach_user_id. Collector: OR client/coach, key qualified by row client.
- R2 fix (local b7a119/r2): eeb23f2e (attemptSettled no-SI -> processing only; listPlans live unbounded + ended history take 50), e96786eb merge R1. #679 size 2,943 vs new R1.
- R2 tests in #701 worktree -3 (test/b-recur7a-119-r2.spec.ts, 200 lines).
- Lanes: R1 before 37229770060 (5 fail/3 pass, as designed); R1 after 37230098522; R1 probes 37230108455; R2 before 37230129006; R2 after+all probes 37230205968.
- Local: #701 tree + merged fix: test/b-recur test/checkout test/account-deletion 42 suites / 525 pass.
- 12:58 waiting for lanes.

- Lanes done: R1 after 37230098522 success 81/81; R1 probes 37230108455 2 fail (both 'minimal bodies', superseded since round 5) / 45 pass, PG fence probe passes (skipped: true); R2 before 37230129006 5 fail / 3 pass as designed; R2 after+probes 37230205968 12 fail / 268 pass (all expected: by-design evidence, accepted B-679-8 deviation, Cs C-679-3, C-678-3).
- 13:00 pushed #678 09e159d83e192e9718bef7a493aa18944022eb0b (adds reciprocal-identity test 09e159d8), #679 23d2c04c3d05cfc5a6594700152a9cf5336f3111, #701 5e8f1ceb2004a424887fb85a0ecf9dcbd18011ef (red until restack).

- 13:0x required checks green: #678 09e159d8 12 pass / 1 skipping; #679 23d2c04c 10 pass / 1 skipping; no reruns.
- FIX ROUND 7 + READY FOR AUDIT: #678 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983942447 ; #679 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5983962316 . PR bodies updated (canonical builder, T4 scan, evidence, Fix round 7 rows). Comment bodies: ops/aud-119/B-RECUR7A-119/.
- 13:14 notify/recurring.txt written. #701 @ 5e8f1ceb build-and-test red by design: exactly the 5 new-spec cases (run 37230446070) until restack.
- 13:15 cleanup: ci/B-RECUR7A-119-* deleted (0 remain), worktrees and local branches removed, lock recurring-r12 released.

## Follow-ups (C)
- Sol C-678-2: src/account-deletion/account-deletion.service.ts:455 (lockUser 'skip') and :563-569 @ 09e159d8. While a send holds a User row, the grace-period cancel and the admin path answer with irreversible or "already running" copy. Fix rule: a distinct, retryable busy answer that gives the retry time.
- Sol C-678-3: src/checkout/subscription-attempt.ts:17 (SEND_FENCE_TX_TIMEOUT_MS 30 s) @ 09e159d8. A pooled connection is held across the Stripe create. Fix rule: measure pool waits; if there is pressure, use a short lock plus a durable intent row with equal authority.
- Opus C-678-3: src/account-deletion/account-deletion.billing.ts:87-140 @ 09e159d8. A customer 404 (resource_missing) from the list throws on every nightly run. Fix rule: treat a 404 on the customer list as proven absence and keep every other error fail-closed; admin force-delete answers a coded, retryable 409/503.
- C-679-3: src/checkout/subscription-checkout.service.ts:1475-1525 (replaySecretState / canceledSetupState) @ 23d2c04c. Fix rule: on a missing SetupIntent, read the bound subscription; expire only on proven absence of both and never return a dead secret.
- Opus C-678-4 and C-679-4 are CLOSED in this round (same lines as B-678-3/4 and B-679-10).

## Operator decisions
1. A coach deleted mid-send gets 'closed', so the caller answers SUBSCRIPTION_ATTEMPT_EXPIRED (timed_out) to the client. Default: accept for now. The copy refinement ("this coach's plan is no longer available") is a C.
2. The ended history in listPlans is capped at 50 (canceled, unentitled, no trial) and live plans are uncapped. Default: accept. Add pagination later if a client ever has more than 50 ended plans.

## HANDOFF
DONE 13:15 PDT 10-04.
- #678 @ 09e159d83e192e9718bef7a493aa18944022eb0b: FIX ROUND 7, READY FOR AUDIT, required checks green. Next: fresh Opus and Sol verdicts.
- #679 @ 23d2c04c3d05cfc5a6594700152a9cf5336f3111: FIX ROUND 7, READY FOR AUDIT, required checks green. Next: fresh Opus and Sol verdicts.
- #701 @ 5e8f1ceb2004a424887fb85a0ecf9dcbd18011ef: the new spec is red until B-RECUR7B-119 restacks #680 -> #696 -> #701 onto #679 @ 23d2c04c. On a local preview merge it gave 525/525.
- Fees are not merged into #678. The operator restacks recurring onto the final fees top.
