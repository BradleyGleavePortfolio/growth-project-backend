# AUD-SOL-INV5-122 — independent GPT-6.1 Sol lens, agent 122

AUDIT GPT-6.1 Sol — growth-project-backend#658 @ 4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d — VERDICT: APPROVE

## State
- Started Monday 2026-10-05 16:36:32 PDT; 20-minute delta review of backend #658 at `4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d`, claimed as Sol. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658)
- Read the common brief in full, only the assigned JOBS122 entry, the updated Source of Truth A1/A2 overrides/A5 rules 11–12, prior own review and builder FIX ROUND 2; no current-round Opus notes/comment/report read.
- APPROVE posted at 16:40:56 PDT after immediate exact-head verification; A/B/C = 0/0/4, no new A/B/C. [Published Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005619662)

## B-658-9 closure
- Normal-user consequence before the fix: a team sub-coach creating a signup code could attach the head coach's paid package as free/prepaid and give it to new clients for $0 without the head coach's authority. [Prior-round counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6002144885)
- `coach-code-tools.service.ts:254–263` now rejects any package/grant request from an active sub-coach with `403 code_package_head_coach_only` before replay (`:265–274`), package lookup (`:302–309`), INSERT (`:312–329`) or audit (`:342–372`); `scopeOf():723–726` uses the existing active-team attribution helper, not body-supplied tenancy. [Exact-head service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d/src/invite-codes/coach-code-tools.service.ts)
- `test/coach-code-tools.service.spec.ts:594–659` preserves the plain sub-coach's head-tenant attribution, visibility/mutation/counting checks and head-coach binding; the committed P1 regression covers free, prepaid, package-only and grant-only requests with zero code/team-audit rows. [Exact-head tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d/test/coach-code-tools.service.spec.ts)
- P1 passes in the independently inspected required-CI service suite; the builder's before-fix failure is recorded as builder evidence, not an independently executed before-fix run by this lens. [Build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388407331/job/112027377718) [Builder fix/failure record](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005531674)
- P3's original sub-coach code creation is now refused, so its old "$0 grant created" positive result is intentionally no longer expected; original P3 was not independently rerun. [Guard](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d/src/invite-codes/coach-code-tools.service.ts) [Original P3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6002144885)

## Merge and CI evidence
- Automatic merge tree of `4de7a6dccaabd8ead5aabbfa276ebcf847a114c0` and `5cde6253f941112f2d9afbcf572a4da838dbb16a` equals the actual merge `8f6a8493ee5220df76d67e367d49b9b6f2c7ae5c` tree `bcbac54b9270aee109b1ee375530b77686c5259f`; no conflict-resolution source changes. [Merge/fix record](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005531674)
- Main's six overlapping PR files add other-feature schema/erasure/CI/env/flag content; invite/grant source, code-tools migration and relevant tests are byte-identical across that merge, and the sole non-main commit contains only the guard, README and unit changes. [Fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005531674)
- Prior Sol B-658-1/-6/-7 closures and evidence apply to unchanged code; no fresh edge-case investigation was performed. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6001758071)
- Tested PR-merge `06832080fd542f59268f34a6ce1459a862a7da43` and candidate both have tree `adcad744da3d491b1a923c42ee2647e844671133`; required-CI logs explicitly check out that merge of this candidate into main. [Build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388407331/job/112027377718)
- Independently downloaded CI logs: lint/type-check/build succeeded, code-tools service/controller and attach-ledger suites passed, full suite 810 passed/28 skipped with 13,795 tests passed/293 skipped/5 todo. [Build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388407331/job/112027377718)
- Community live job included `test/invite-codes/coach-code-tools.live.spec.ts` and passed 12 suites/120 tests with no skips. [Community live](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37388407331/job/112027377753)
- Size independently counted 2,918 additions + 72 deletions = 2,990/3,000; all 20 observed check successes plus the intentional deploy-readiness skip, PR mergeable state clean. [Candidate checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658/checks)

## Saved evidence and constraints
- Notes/logs: `/home/user/workspace/ops/aud-122/AUD-SOL-INV5-122/`.
- Saved `pr.json`, `check-runs.json`, `fix-delta.patch`, `pr-paths.txt`, `tree-proof.txt`, both required-CI job logs, `verdict.md` and `comment-url.txt`; the posted comment was read back and its exact first line verified. [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005619662)
- No local npm/Jest/tsc/eslint/build, probe pushes, candidate-source edits, production actions, merge or deploy by this lens.
- Clean read-only detached worktree retained at `/home/user/workspace/wt/AUD-SOL-INV5-122-658` under the higher-priority workspace no-delete instruction; no own branches or CI lane runs were created.
- Claim released by moving it into saved evidence as `released-claim-backend-658-4bb177c7-sol`; no workspace evidence deleted.
- C (edge, deferred to 10k clients): inherited C-658-3/-4/-5/-8, not re-investigated; no new delta C. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6001758071)

## HANDOFF
DONE 16:41:15 PDT. APPROVE at `4bb177c751b7f8f3d34b5b675a846fe7f8cefc7d`, A/B/C = 0/0/4; B-658-9 closed and required CI green. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6005619662)

No new operator decision. Optional Cs stay out of this 2,990-line grandfathered PR; preserve the previously accepted #657/#658 second-landing lifecycle mapping during integration. [Prior Sol integration note](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-6001758071)

Worktree is clean but retained for parent consumption, claim released, no probe runs/branches pending; all findings and evidence are saved at the paths above.
