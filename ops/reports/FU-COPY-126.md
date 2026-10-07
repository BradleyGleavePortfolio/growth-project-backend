# FU-COPY-126 — dead rows and errors

Worker: GPT-6.1 Sol, agent 126. Started Tue Oct 6 18:03:36 PDT 2026 (clock from `TZ=America/Los_Angeles date`).
Fresh worktree: `/home/user/workspace/wt/FU-COPY-126-mobile-fresh`; branch `agent126/fu-copy-126-fresh`; baseline `950689af`.
The earlier stopped branch `agent126/fu-copy-126` is not reused.
Scope: exactly FU-COPY-126 in JOBS126, with OWNER 18:03 OVERRIDE; T2 mobile only, no auth/money/PII changes.

## Scope traced (screens + routes)

- Traced coach Settings -> BulkInvite, CoachInvites and InviteCodes/CoachCodes -> GET /coach/codes, GET /coach/invite-codes/:id/redeemers -> InviteCodesController -> listRedeemersForCoach -> Prisma inviteCode/inviteRedemption/user. ([InviteCodesService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/invite-codes/invite-codes.service.ts))
- Traced both bulk-invite screen errors -> POST /coach/invite-codes/bulk and /bulk/parse -> InviteCodesController -> bulkInvite/parsePasted. ([InviteCodesService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/invite-codes/invite-codes.service.ts))
- Traced client Messages no-coach state -> existing CoachCodeSheet -> POST /coachless/coach-code/check and /redeem -> CoachlessController -> CoachCodeRedemptionService; unchanged sheet owns the code attach, cache and entitlement refresh. ([CoachlessController](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/coachless/coachless.controller.ts), [redemption service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/coachless/coach-code-redemption.service.ts), [mobile UI change](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- Traced Grocery/Shopping actions -> /lists/:type and /clear-checked -> ListsController -> ListsService -> Prisma listItem. ([ListsService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/lists/lists.service.ts))
- Traced PrepGuide -> GET /prep-guide -> PrepGuideController -> PrepGuideService -> Prisma mealPlan/recipe, and existing ingredient additions -> POST /lists/grocery. ([PrepGuideService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/prep-guide/prep-guide.service.ts), [ListsService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/lists/lists.service.ts))
- Traced RecipeDetail -> /recipes/:id and /save -> RecipesController -> RecipesService -> Prisma recipe/saved rows; actual missing/not-visible recipes return 404, unlike fetch errors. ([RecipesService](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/src/recipes/recipes.service.ts))
- Traced client Settings -> useSettings local preferences and existing profile-key map; removed only Units/Calorie Display rows and unused map entries, without reopening meal/water profile synchronization. ([mobile UI change](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- Confirmed backend desired-state flags FEATURE_COACHLESS_HOME and FEATURE_COACH_CODE_TOOLS are true; no config/flag changes. ([desired state](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/main/.github/fly-env-desired-state.json), [mobile UI change](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- Read `_COMMON_126.md` fully, requested JOBS126 paragraphs, SoT A1, A2 overrides 1–11, and A6.
- Read only the specified findings in AUDIT-17/03/08/12-125.

## B list

- None identified.

## U list

- U-17-5: a coach opening Settings sees duplicate bulk-invite entries and no emailed-invite history link from Codes; fixed by keeping BulkInvite and adding CoachInvites entry. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- U-17-6: a coach opening a missing invite's history is falsely told its live route is coming soon; fixed missing-code/retry copy and Who joined title. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- U-17-7: a coach whose invite preview/send fails gets generic or raw technical copy; fixed safe action-specific alerts that keep the entered list. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- U-03-3: a coachless client opening Messages is sent to support despite having a coach code; fixed existing code-sheet entry with server capability gate, support fallback, refresh and retained welcome. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- U-08-7: a client whose list/prep/bookmark/recipe operation fails sees Error or a false missing-recipe claim; fixed action-specific copy, genuine 404 state and recipe retry. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- U-12-4: a client selects Units/Calorie Display but neither display changes; removed the inert controls only. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))

## C one-liners

- None identified.

## Covered by open PRs

- Checked all open mobile/backend PR titles. Relevant non-dependency mobile PR file lists: m#439, m#302, m#265, m#264. None touches the assigned screens.

## PRs opened (number, head, lines, CI)

- Opened [mobile PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440) at exact head `48348a628a40b5323a99cb1a547e5e2c92baae57`; pushed once.
- Changed lines: 263 additions + 101 deletions = 364 (including tests). ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))
- Main-fail proof: 6 failed suites, 17 failed / 44 passed tests against main source with regression tests, [targeted CI run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555490180).
- Baseline CI log saved to `/home/user/workspace/ops/reports/evidence/FU-COPY-126/mainfail.log`.
- [Fixed targeted CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555731169) passed eight suites / 70 tests, including existing Messages V2/cache tests; [full PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555724890/job/112581382146) passed all guards, lint, typecheck and full tests, with all CodeQL checks green at the exact head.
- Full-suite result: 641/641 suites and 8,619/8,619 tests passed. ([full PR CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37555724890/job/112581382146))
- Posted the required opening-round [READY FOR AUDIT comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440#issuecomment-6028754449); no repush required.
- Evidence preserved: `mainfail.log`, `fixed-targeted.log`, `full-pr-ci.log`, and `mobile-440.patch` under `/home/user/workspace/ops/reports/evidence/FU-COPY-126/`.

## Not fixed (needs operator)

- None: all six assigned U findings are fixed within T2; no T4 promotion or owner decision required. ([PR #440](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440))

## HANDOFF

- Completed Tue Oct 6 18:14:39 PDT 2026 (clock from `TZ=America/Los_Angeles date`), before the hard stop.
- READY FOR AUDIT at `48348a628a40b5323a99cb1a547e5e2c92baae57`; full CI green; B=0 U=6 C=0; operator/owner decisions=0. ([PR #440 and opening comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/440#issuecomment-6028754449))
- Operator next step: route m#440 to the LF lens pair, then promote under the fleet's normal exact-head process.
- Worktree is clean and retained at `/home/user/workspace/wt/FU-COPY-126-mobile-fresh` for operator review; all work is committed/pushed and a full patch is preserved.
- PR owns only `agent126/fu-copy-126-fresh`. CI-only remote branches `ci/FU-COPY-126-mainfail-1` and `ci/FU-COPY-126-fixed-1` were deleted after evidence capture.
- No local heavy jobs or locks were used; all testing ran in the permitted GitHub lanes/PR CI.
- Do not reuse or remove other workers' worktrees. Do not reopen completed work, merge, deploy, or change production.
