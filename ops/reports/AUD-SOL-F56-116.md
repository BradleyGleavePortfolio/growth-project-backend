# AUD-SOL-F56-116 — GPT-6.1 Sol

## Scope and intake

Only backend #685 F5 and #686 F6 are under audit; both are T4 test-only pieces of #627, and all six piece bodies were read to establish boundaries. [F5](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685) [F6](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686)

- Claimed #685 at `858d37165662ad83af7c380f5f57700fd3d47afa` (base `42e9ca13b0b365315fade00f0fce869f5e25834b`); 4 test files, 2,958 additions, no deletions. [F5 readiness/size assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975772653)
- Claimed #686 at `7be7d396dcaab5f62c941a78e6e071ce3518ad28` (base F5); 3 test files, 1,355 additions, no deletions. [F6 readiness](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975772625)
- Prior Sol APPROVE is #627 at `7c29d98121d931af04d68038f97aec601589e6a2`; subsequent B-627-9 closure was recorded at `3a5338d72c277238486452f7f256da2d8e22c7c8`, which raised B-627-10. [Prior approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926) [Latest Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972047312)
- FR10's B-627-10 regression closure is verified: actual failing-before CI has 2 assertion failures / 9 controls passing; its fetched SHA `cc162334540d56b09d9598005f98c9e5df184661` has an empty runtime/schema/dependency diff against `3a5338d7`, and its paused-sender test file is byte-identical to F5; F5/F6 execute that complete suite successfully. [FR10](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972269313) [Verified failing-before run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37143889028) [F5 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511/job/111302207287) [F6 execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664774/job/111286644839)
- C-627-10 remains the owner-directed nullable-key-column follow-up, not a blocker of these tests. [Recorded follow-up disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972269313)

## Stack tree proof

`git merge-tree --write-tree 66162285882d75d7619542c9aa581da5cc93145d d23fa31773f2e7f14781d243db35067d949f421a` yielded tree `09de2bffd1b9186b64f840bd9ee4761c4c0f510f`, identical to `git rev-parse 7be7d396^{tree}`; `git diff --exit-code` against the reconstructed tree is empty, and all seven F5/F6 files are byte-identical to fixed #627 at `66162285`. [Original fixed head](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/66162285882d75d7619542c9aa581da5cc93145d) [F6 head](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/7be7d396dcaab5f62c941a78e6e071ce3518ad28)

## Completed review and findings

Every line of F5's 4 files (2,958 lines) and F6's 3 files (1,355 lines) was read, along with the complete provider/database model, transfer orchestrator and real charge lock, plus relevant settlement, reversal, netting, backfill, notification, email and HTTP-boundary call sites. [F5](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685) [F6](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686) [Fixture model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/test/utils/settlement-fakes.ts)

G09 reuse is limited to this lens's prior approval: concurrency, money-protocol, OR-111-1 and renewal-backfill are byte-identical to `7c29d981`; r7's 35 additions / 4 deletions, all r8 in-flight lines and all r9 paused-sender lines received fresh deep review, and full piece diffs were read even where prior evidence applies. [Prior same-model approval](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926)

No A/B was identified in either owned test-only diff; posted verdicts are APPROVE 0/0/1 each, with only the following optional coverage improvements. [Posted F5 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975835233) [Posted F6 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975835306)

- **C-685-1**, `test/s-fee-r4-money-protocol.spec.ts:788-807`: claimed later-page recovery creates only one reversal, so page size 1 still finds the match on page one; a first-page-only implementation satisfies this case, and the minimal strengthening is a newer nonmatching same-transfer reversal plus a second-call cursor assertion and unchanged movement counts. [Reviewed test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/858d37165662ad83af7c380f5f57700fd3d47afa/test/s-fee-r4-money-protocol.spec.ts) [Listing model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/test/utils/settlement-fakes.ts)
- **C-686-1**, `test/s-fee-renewal-backfill.spec.ts:213-219`: “keeps the cursor” starts without a saved cursor and never asserts it; an implementation resetting to null on failure passes, and the minimal strengthening is a seeded non-null cursor, input/output cursor assertions, then a resumed recovery without duplicate payout. [Reviewed test](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/test/s-fee-renewal-backfill.spec.ts)

Tests retain production money arithmetic, CAS predicates, charge fencing and durable receipt transitions, checking fixed cents and independently retained external objects rather than service-return tautologies; the in-app rollback case supplies a rolling-back transaction double, and notification retry cases use real EmailService/NotificationsService at the relevant boundary. [Fixture model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/test/utils/settlement-fakes.ts) [Prior same-model boundary disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5964131926)

## Outside-owned-diff routing notes

These are observations from tracing fixture call sites, not verdicts on additional PRs and not B findings on F5/F6:

- F2's payout-notice copy still contains `We will hold`, `We took`, `We paid` at `src/connect/fees/payout-notice-copy.ts:67,79,93,101`, and F5 pins those strings; route the owner no-first-person rule to the F2 code owner and coordinate corresponding F5 assertion updates if that copy changes. [Actual copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/src/connect/fees/payout-notice-copy.ts)
- Other lower-piece diagnostic boundaries retain arbitrary `Error.message` interpolation, e.g. charge-lock release `src/connect/fees/charge-lock.ts:230-231` and transfer recheck scheduling `src/connect/fees/transfer-orchestrator.service.ts:893-897`; the narrow B-627-10 classifier closure does not certify those different paths, so route privacy review to the assigned lower-piece owners rather than reopening B-627-10 on these tests. [Lock diagnostic](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/src/connect/fees/charge-lock.ts) [Transfer diagnostic](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/7be7d396dcaab5f62c941a78e6e071ce3518ad28/src/connect/fees/transfer-orchestrator.service.ts)

## CI intake

The seven required checks that run on stacked bases are currently successful for both heads; the main-only CodeQL, danger, banned-cast and SBOM gates do not run on these bases and remain landing gates. [F5 exact-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511/job/111302207287) [F6 exact-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664774/job/111286644839)

F5 exact-head CI executes all four owned suites and reports 720 passed suites / 12,421 passed tests; F6 executes all three owned plus inherited F5 suites and reports 723 passed suites / 12,466 passed tests; both disclose 23 skipped suites / 239 skipped tests / 5 todo, not acceptance evidence. [F5 log](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511/job/111302207287) [F6 log](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664774/job/111286644839)

No heavy local work, dependency installation, candidate-branch edits, merges or production actions performed.

## Retained audit material

- `/home/user/workspace/ops/aud-116/AUD-SOL-F56-116/685-verdict.md`
- `/home/user/workspace/ops/aud-116/AUD-SOL-F56-116/686-verdict.md`
- Original failing-before run SHA fetched and verified in the backend object database; no probe branches created.

## Publication and cleanup

Both heads were re-read immediately before posting, unchanged from intake, and one exact-format GPT-6.1 Sol verdict was published on each; #685 comment was created at `2026-10-04T02:36:07Z`, #686 at `2026-10-04T02:36:08Z`. [F5 posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975835233) [F6 posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975835306)

The own read-only worktree was clean and removed after publication; no dependency symlink, probe branch or run was created, and all report/verdict files are retained.

## HANDOFF

- **#685:** head `858d37165662ad83af7c380f5f57700fd3d47afa`; GPT-6.1 Sol **APPROVE**, **A/B/C 0/0/1**; C-685-1 optional later-page strengthening; next step is the other lens / remaining stack approvals, not another Sol verdict on this unchanged head. [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975835233)
- **#686:** head `7be7d396dcaab5f62c941a78e6e071ce3518ad28`; GPT-6.1 Sol **APPROVE**, **A/B/C 0/0/1**; C-686-1 optional outage-cursor strengthening; requested tree equality is exact; next step is the other lens / remaining stack approvals. [Published verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975835306)
- All seven stacked-base required gates are green for both heads, but the four main-only checks have not run; the operator must collapse/land the coupled stack as one only after every piece's dual approval, re-prove the collapsed F1 tree, obtain all main-required checks and merge-only attestations, and deploy with mobile #321. [F5 readiness/landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975772653) [F6 readiness/landing contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975772625)
- Recommend leave C-627-10 on its already-directed separate follow-up and route outside-diff copy/diagnostic observations above to the assigned lower-piece owners; no new owner decision is required for these test-only verdicts. [Recorded C-627-10 disposition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972269313)
- Job complete; stop here and do not audit any further PR/head in this job.
