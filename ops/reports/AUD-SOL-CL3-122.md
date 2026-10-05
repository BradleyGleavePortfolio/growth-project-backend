# AUD-SOL-CL3-122 — coachless main-refresh delta

Job: AUD-SOL-CL3-122, agent 122, GPT-6.1 Sol. Start: Monday 2026-10-05 16:26:27 PDT. Time box: 20 minutes.

## Scope

Review only the main-refresh/restack conflict resolutions and preservation of previously approved PR changes: [#721](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721), [#722](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722), [#723](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723).

Reuse only the prior Sol evidence, not the current Opus lens's work: [prior #721 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6004991224), [prior #722 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6004991568), [prior #723 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6004991999).

## Current heads

| PR | Exact head | Verdict |
|---|---|---|
| [#721](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005437353) | 538a0ba4baacefcea5208c0a8a11e87a1a09fb86 | APPROVE; A/B/C 0/0/0 |
| [#722](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005437748) | f02a3904d0662731e0dc7bbb7cbbb026dfefdd71 | APPROVE; A/B/C 0/0/0 |
| [#723](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005438205) | 8c9943673cd2129732fde9b59aef2c19389d4b6c | APPROVE; A/B/C 0/0/0 |

## Independent preservation and conflict review

- #721: exact parents are prior approved d90b484278f432e6e73e41326dc31cadc8892999 and main 5cde6253f941112f2d9afbcf572a4da838dbb16a; the remerge diff contains only the reported schema conflict resolution. All three coachless models and SchedulingJobLease remain separate and intact at `prisma/schema.prisma:7994–8071`. [Builder provenance](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005202279), [merged schema](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/538a0ba4baacefcea5208c0a8a11e87a1a09fb86/prisma%2Fschema.prisma).
- #721: old/new piece diffs normalized only for blob IDs/hunk positions differ by relocation of one empty separator line; all nonempty changes match, the three new files have identical blobs, and size stays 808 lines. Auto-merged CI wiring, User/CoachPackage relations and erasure entries retain every PR line. [Refreshed piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/5cde6253f941112f2d9afbcf572a4da838dbb16a...538a0ba4baacefcea5208c0a8a11e87a1a09fb86).
- #722: exact parents are prior approved c219d2f391c37edd700d5204f31b50286f280d82 and refreshed #721. Read all four remerge conflict hunks: DTO flag keys, evaluator and the two spec maps retain both `coachless_home` and `messaging_core_v2` without changing either gate. Old/new normalized piece diffs match exactly, all eight introduced files have identical blobs, and size stays 1,290 lines. [Restack provenance](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005202626), [refreshed piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/538a0ba4baacefcea5208c0a8a11e87a1a09fb86...f02a3904d0662731e0dc7bbb7cbbb026dfefdd71), [flag evaluator](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f02a3904d0662731e0dc7bbb7cbbb026dfefdd71/src%2Ffeature-flags%2Ffeature-flags.service.ts).
- #723: exact parents are prior approved e3368cc3cbb0961326ddf147728f7fc32d884188 and refreshed #722; the remerge diff is empty, old/new normalized piece diffs match exactly, all six introduced files have identical blobs, and size stays 1,117 lines. CoachlessModule import and registration survive the app.module.ts auto-merge. [Restack provenance](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005203117), [refreshed piece](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/f02a3904d0662731e0dc7bbb7cbbb026dfefdd71...8c9943673cd2129732fde9b59aef2c19389d4b6c), [app module](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/8c9943673cd2129732fde9b59aef2c19389d4b6c/src%2Fapp.module.ts).

## Migration and CI evidence

- The coachless migration is unchanged and additive, depending only on User, CoachPackage and older app RLS helpers; the seven later main migrations do not modify its three tables or those dependencies. [Exact migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/538a0ba4baacefcea5208c0a8a11e87a1a09fb86/prisma%2Fmigrations%2F20270301000000_coachless_featured_coach%2Fmigration.sql), [refresh provenance and later migration list](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005202279).
- Read exact-head forward migration and community logs: both actually run `prisma migrate deploy`, apply `20270301000000_coachless_featured_coach`, then the seven later migrations, and report all migrations successfully applied. These are fresh-CI-database proofs, not a claim of a production or separate already-applied-main simulation. [Forward deploy job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845535/job/112022085808), [community deploy job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845528/job/112022085571).
- #721: fetched current protection contexts and joined all 11 by exact name to exact-head check runs; every required context is completed/success, including rls-live-tests, build-and-test, CodeQL, SBOM, banned-cast, Danger and schema parity. [Required contexts](https://api.github.com/repos/BradleyGleavePortfolio/growth-project-backend/branches/main/protection/required_status_checks), [CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845528), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845515/job/112022085510), [SBOM](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845579/job/112022085481), [banned-cast](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845530/job/112022085583), [Danger](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845636/job/112023453023), [schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845679/job/112022086564).
- #721: the coachless live RLS suite ran 18/18 successfully; build/test ran 807 passing suites and 13,754 passing tests, with skips/todos reported separately in the retained log. [Live RLS job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845528/job/112022085629), [build/test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386845528/job/112022085588).
- #722: seven present required contexts are green; exact-head build/test ran 808 passing suites and 13,774 passing tests, including both flag specs, coachless Home, erasure coverage and FK order. CodeQL, banned-cast, SBOM and Danger contexts are absent while stacked, not green. [CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387063894), [build/test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387063894/job/112022807829), [PR checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722).
- #723: seven present required contexts are green; exact-head build/test ran 809 passing suites and 13,803 passing tests, including redemption, coachless Home, feature flags and erasure checks. The same four main-only contexts are absent while stacked, not green. [CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387233260), [build/test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387233260/job/112023370554), [PR checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723).

## Findings and posted verdicts

No normal-use A/B defects and no new C findings; all three approvals have A/B/C = 0/0/0. Each exact head was re-fetched immediately before its one verdict POST at 16:30:15–16:30:19 PDT. [#721 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005437353), [#722 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005437748), [#723 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005438205).

RUTHLESS SCOPE: frozen edge cases were not investigated. No current-round Opus lens report, notes or comment was read before posting.

## Saved evidence and operator handoff

Evidence directory: `/home/user/workspace/ops/aud-122/AUD-SOL-CL3-122/`.

- `721/722/723-old-piece.patch`, `*-new-piece.patch`, `*-normalized.patch`, `*-comparison.patch`, `*-remerge.patch`: independent delta corpus.
- `delta-preservation.txt`: complete nonempty-line and new-file blob comparisons.
- `pr-*.json`, `compare-*.json`, `checks-*.json`, `required-checks.json`, `721-required-check-verification.json`: GitHub provenance/check snapshots.
- `run-*.json`, `*-build-test-*.log`, `721-forward-migration-*.log`, `721-community-migrate-deploy-*.log`, `721-live-rls-*.log`: exact-head CI evidence.
- `comment-*.md`, `comment-*-payload.json`, `comment-*-receipt.json`: exact posted verdicts and receipts.

Recommended defaults: retain the migration name, accept this Sol delta approval for the three exact heads, obtain the independent Opus delta verdicts, and land under the split-stack rules only when every required main check is green. [#721 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/721#issuecomment-6005437353), [#722 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005437748), [#723 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005438205), [split-stack rule A5.11](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/TGP_SOURCE_OF_TRUTH.md). The four absent contexts on #722/#723 are operator merge gates, not new code findings. [#722 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/722#issuecomment-6005437748), [#723 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/723#issuecomment-6005438205).

No source edit, PR-branch push, merge, deployment, production access, local test/build or new CI run performed. No worktree, audit branch or lock was created; claim markers are archived to this job's evidence directory.

## HANDOFF
