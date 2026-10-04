# AUD-SOL-R12D-119 — recurring round-7 delta, Sol lens

## Status
IN PROGRESS; intake at 2026-10-04 13:16:09 PDT; #678 posted at 2026-10-04 13:22:38 PDT (from `TZ=America/Los_Angeles date`).

## Scope and ownership
- #678 `09e159d83e192e9718bef7a493aa18944022eb0b`, 2,594 lines; previous Sol REQUEST CHANGES `77bce4505b12586a0fe1080246d97217f0834f1c` ([prior verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983682649)).
- #679 `23d2c04c3d05cfc5a6594700152a9cf5336f3111`, 2,943 lines; previous Sol REQUEST CHANGES `8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca` ([prior verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5983707659)).
- Both exact-head Sol claims created; detached worktrees `wt/AUD-SOL-R12D-119-678` and `-679`; source untouched. Intake threads and delta patches saved under `ops/aud-119/AUD-SOL-R12D-119/`.

## Review plan
Resolve Sol B-678-3/4 and B-679-10/11 from code plus failing-before evidence; deeply audit every round-7 delta line and the lock/collector/list/trial call sites. Replay original Sol probes in CI only, read the five #701 tests as #679 proof, classify retained expected C failures honestly. Assess deleted-coach copy and ended-history limit independently.

## Executed evidence / closure
- #678 exact source + test-only `64ad1a1b` + disposable workflow, CI head `074c5ad954d648db673c1294855b4bb1e9c533a9`: **42/42, 6 suites**. Original four coach-deletion cases, two real PostgreSQL sessions, prior trial-end forms, round-6 and round-7 R1 tests all pass; `SOL_COACH_FENCE {skipped:true, creates:1, status:'pending'}` ([independent R1 replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231522343)).
- B-678-3/4 closure is supported by the exact prior failing schedule and five builder regression failures on `77bce450 + 7ec88952 + workflow`; no candidate implementation edits were present in the before run ([R1 failing-before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229770060)).
- #679 exact source + test-only `5463c44e` + disposable workflow, CI head `61b69cd4cb18aca4795a38dcdcee4ffd7110fe86`: **98 pass / 1 failed, 8 suites**. All retained B-679-10, B-679-11, original/adapted admission/replay/authority and eight #701 round-7 cases pass; sole failure is explicitly retained C-679-3, not infra ([independent R2 replay](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231523863)).
- B-679-10/11 closure is supported by the five builder failures on `8bbf4a41 + 806b10cb + workflow` (three controls pass); exact #701 test blob was imported into this independent lane, not later source ([R2 failing-before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230129006)).
- Supplementary >50 live-list, canceled-trial-history and cancellation-between-two-list-reads evidence plus actual round-5/6/current checkout suites are running on test-only `ca00a0e6` over #679 ([list-boundary lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231647290)).

## Posted verdicts
- #678 `09e159d83e192e9718bef7a493aa18944022eb0b`: **APPROVE, A/B/C = 0/0/2**, after live-head reread immediately before posting ([fresh Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5984029294)).
- #679: final verdict pending supplementary lane; draft APPROVE, 0/0/4, saved locally.

## Follow-ups (C)
- C-678-2 carried: `src/account-deletion/account-deletion.service.ts:455–460,563–569`; contention on the checkout send's User lock is reported as irreversible/running deletion. Distinct retryable busy copy, with working retry action ([prior Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983682649)).
- C-678-3 carried: `src/checkout/subscription-attempt.ts:17,54–113`; connection held across bounded Stripe send. Measure pool/lock waits before replacing with a durable intent that preserves shared authority ([prior Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983682649)).
- C-679-3 carried: `src/checkout/subscription-checkout.service.ts:1475–1504`; missing SetupIntent still returns dead stored secret on same-key trial replay. Reconcile bound subscription on resource absence; proven absent/ended expires, transient read remains retryable ([executed retained failure](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231523863)).
- Optional list-snapshot race and operator-decision copy/pagination Cs pending final evidence classification.

## HANDOFF
#678 is posted APPROVE at the exact candidate; #679 remains pending the supplementary lane. All four prior Bs pass independent acceptance, with retained C explicit. Next: collect supplementary list lane and post #679 after live-head reread. A merge-only restack onto final fees top must preserve both-identity deterministic locking, complete payer/payee uncertain-create cancellation, attempt-owned trial consent and guarded trial-end lifting, one-object reuse, complete live-plan discovery and fail-closed provider lists; inspect conflict hunks, compare recurring blobs, and re-evaluate exact-head CI/main-only checks.
