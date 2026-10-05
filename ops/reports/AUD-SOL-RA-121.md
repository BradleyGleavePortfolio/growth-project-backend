# AUD-SOL-RA-121 — agent 121 independent Sol lens

## Mandate and exact heads
- Backend #667 A1: `bacd83e10ff0e00dc5165dd223da8b4745e3c82a`; base main at `d23fa31773f2e7f14781d243db35067d949f421a`. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667).
- Backend #665 A2: `eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5`; base #667 at `bacd83e10ff0e00dc5165dd223da8b4745e3c82a`. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665).
- Claimed both exact heads in lanes121; independent of the current Opus lens, whose current notes/comments were not read.
- Both opened before the new 1,500-line limit; sizes 1,832 / 2,282 and within grandfathered 3,000 ceilings. [A1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667), [A2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665).
- Full cumulative first review completed; no reused approval, no current-round Opus notes/comment read. [A1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969), [A2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).

## Posted verdicts
- **#667: REQUEST CHANGES, A/B/C = 0/3/1**, exact head `bacd83e10ff0e00dc5165dd223da8b4745e3c82a`. [Sol comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969).
- **#665: REQUEST CHANGES, A/B/C = 0/4/1**, exact head `eb7cb7a81e86d2a9113b3b65b7f9d011950c3ba5`. [Sol comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- Both heads were reread immediately before posting and remained unchanged. [A1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667), [A2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665).

## Must-fix findings (source-traced, independent probes queued)
### #667 A1
- **B-667-1** `src/roman/context/roman-consultation.source.ts:60-77`: the real coach-view projection forwards consultation B2 as the exact formatted DOB; fake intake canaries miss this production path. Fix: Roman-specific projection drops B2 or reduces it to whole age only, without weakening the authorized coach view. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969).
- **B-667-2** `roman-consultation.source.ts:85-88`: `.some` declares a single-negative-answer draft a completed seven-question screen. Fix: completion requires all required screening answers; retain available partial positives and conservative clearance. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969).
- **B-667-3** `roman-client-context.renderer.ts:150-169,200-215`: final output has no hard-cap check after exhausting truncations; escaped bounded strings exceed 3,500 estimates while flagged answers/profile fields survive. Fix: escaped-length budget and final fail-closed bound preserving safety flag/answers, valid JSON and hash/disclosure consistency. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969).
### #665 A2
- **B-665-1** `roman-client-context.service.ts:551-562,1198-1219`: provider-agnostic reads sum competing providers, so one 480-minute night becomes 16 hours. Fix: reuse canonical per-metric preferred/fallback provider resolution before aggregation. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- **B-665-2** `roman-client-context.service.ts:551-562,1195-1268`: newest 600 raw rows are represented as complete days/averages; 1,000 one-step intervals publish 600 with no truncation flag. Fix: complete bounded-window aggregates/paging, or explicitly unknown/truncated affected metrics instead of partial authoritative values. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- **B-665-3** `roman-client-context.service.ts:413,1066-1089,1103-1118`: UTC `ymdOf` mislabels timestamped assignments (Oct 1 02:00Z is Sep 30 19:00 PT). Fix: local labels and timezone-aware instant query bounds for assignments, preserving UTC-midnight semantics only for real Date columns. Production assignment writers preserve ISO timestamp times. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- **B-665-4** `roman-client-context.service.ts:409-416,1066-1076,1095-1129`: ascending first-40 combined past/future rows can hide a real next/today workout. Fix: independently authoritative today/next/completeness-aware adherence, with bounded display history and explicit remaining truncation. [Finding and verification recipe](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).

## Prior Sol findings in scope
- B-651-10: closed in stated scope by coded transient 503/unexpected 500, actionable copy, sanitized diagnostics, existing actual-filter regressions; replay is queued, not claimed as newly passed. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- C-651-4: materially closed by bounded memo/lazy expiry and generation-fence pruning; newly observed 501-versus-500 optional edge is C-665-1, not the old unbounded defect. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- C-651-7: closed in service header for narrow own-booking safe-select; stale A1 docs carried as C-667-1. [Disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- Other parent findings belong to guardrails/live-turn pieces, not A1/A2. [Split map](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665).

## CI
- At initial verification all emitted check-runs for both candidates are completed successfully except deploy-readiness-gate skipped by design; A2 stacked checks omit main-only gates. [A1 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37147605975), [A2 checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148283242).
- No local npm/jest/tsc/eslint/build executed.
- A1-only lane 37365469363 was canceled when the one-in-flight limit arrived; no execution results claimed. [Superseded run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365469363).
- Combined current lane **37365675214**, workflow head `b81cc748ca1da8a1f26223b12c9f717c5aac8648`, test-only parent `b91ce5d8`: **queued** at final observation 12:51:28 PDT, not executed. [Combined lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365675214).
- Four queued specs: independent `audit-sol-ra121-core.spec.ts` and `audit-sol-ra121-service.spec.ts`, plus `roman-client-context.spec.ts` / `roman-context-round2.spec.ts`. A1 relevant source files are byte-identical at exact A2 head (empty diff verified), so combined A2 lane preserves relevant A1 inputs. [Combined evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365675214).
- Independent core has 3 B regressions and 3 positive controls; service has 4 B regressions, C edge, and 3 positive controls. These are saved/designed probes, **not a claim of failed/passed execution**. [A1 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969), [A2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- No wait-for-20-minute fallback was used: audit was complete before that queue allowance, and wall clock takes priority over sitting idle.

## Day-1 budget cross-stack check (not an A1/A2 blocker)
- Read-only context check of #670 tree finds no `recordUsage`/CoachAIBudget in RomanService; controller calls `assertDailyCapacity`, which references `AiRequestAudit`, not the existing coach-pool service. Missing coach debit belongs to the live-turn owner. [Live-turn piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668), [Later turn tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669).
- Both `assertDailyCapacity` and `reserveDailySpend` aggregate only capability and UTC day, with **no caller/requester filter**, so the implemented daily cap is global, not per client. [Live-turn owner](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668).
- Binding day-1 requirement: coordinate a turn-path B with RB/C2 owner; do not place an unrelated B on inert context pieces.
- Operator notice saved at `ops/lanes121/notify/AUD-SOL-RA-121-budget-boundary.md`. Recommended default: live-turn owner implements atomic layered per-client admission and coach-pool debit, conservative interrupted usage settlement, distinct pool-empty/daily-cap codes/copy. [Live-turn piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668), [Fix/test piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/669).

## Follow-ups (C)
- **C-667-1** `docs/roman-client-context.md:1,15,29-31,55-56`: stale version/source/booking/disclosure description. Fix rule: document ctx-v3, real intake, narrow own-booking select (not private notes) and actual structured controller response. Do not fix during the A/B freeze unless the operator changes the mandate. [Optional finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969).
- **C-665-1** `roman-client-context.service.ts:248-257,293-299`: memo reaches 501 after insertion against its documented hard 500. Fix rule: bound immediately after insertion / reserve headroom, preserving invalidation fences. [Optional finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).

## Evidence saved
- `ops/aud-121/AUD-SOL-RA-121/667-core.spec.ts`.
- `ops/aud-121/AUD-SOL-RA-121/665-service.spec.ts`.
- `ops/aud-121/AUD-SOL-RA-121/667-verdict.md` and `665-verdict.md`: exact outbound verdict bodies.
- Probe-only worktree commits: `05450a406a1cd2da0f2f3c0ae0431f509ef04841` (A1 superseded) and `b91ce5d89fbf21ab71ebc14c7a7a6d7e71c4f69b` (combined source tests); queued CI head above is workflow-only child.
- All meaningful evidence files and local worktrees are preserved for the parent under the higher-priority workspace-preservation rule.
- Cleanup at 12:52:53 PDT: both owned remote/local `audit/AUD-SOL-RA-121/*` branches deleted; evidence-bearing worktrees left clean and detached at the probe commits, not removed because workspace files must be preserved.

## HANDOFF
- **Completed.** #667 and #665 exact heads unchanged, Sol REQUEST CHANGES comments posted, seven B findings and two optional C items; fresh builder fixes A/B only and fresh independent lenses audit the new heads. [A1 comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6001851969), [A2 comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6001852378).
- Worktrees preserved, clean and detached: `/home/user/workspace/wt/AUD-SOL-RA-121-667` and `...-665`; only independent test additions, no candidate source edit; own audit branches deleted.
- Operator can collect queued lane 37365675214 when runners recover; if it remains queued for 20 minutes after its 12:47:34 PDT push, a fresh lens may use the item-11 single-spec heavy.sh fallback, naming it accurately. Shared backend deps were READY during final audit.
- Operator recommended default: assign missing monthly coach-pool debit and global-versus-per-client daily cap to live-turn owner #668/#669 before activation; these are outside A1/A2 verdict counts. [Turn-path owner](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668).
