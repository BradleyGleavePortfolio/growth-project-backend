# B-PRIVFU2-118 (builder, T4, agent 118 wave): backend #700 and mobile #368

Started 10:16 PDT on 10-04 and ended 11:13 PDT (times from `TZ=America/Los_Angeles date`). Working notes, comment and body drafts, and the scan script are in ops/aud-118/B-PRIVFU2-118/.

## Backend #700 (branch b-privfu-117/no-email-in-logs): FIX ROUND 2 + READY FOR AUDIT
- Head: 5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb. The required checks were 11/11 green at READY, and the merge state was CLEAN.
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/700#issuecomment-5982863868
- PR body:
  - The tier header is now T4. The T4 scan line names the email send path's ProviderFailure.
  - Fix round table row 2 added.
  - The log-pii paragraph and the out-of-scope paragraph now describe round 2.
- Findings closed:
  - Sol: B-700-1, B-700-2, and C-700-1 (the same issue as Opus B-700-2b).
  - Opus: B-700-1 and B-700-2, plus C-700-2 (for the files this PR owns), C-700-3 and C-700-5.
- Commits:
  - 64ad9438 merges main 2af682ca.
  - 6946f0b9 tests only.
  - d8ee379f the fix.
  - 5e3dabb0 an R75 test fix. The forgotPassword replay had `.catch(() => undefined)`, which counted as an empty catch, net +1.
- CI-lane runs:
  - Failing before: 37221266107. 8 suites failed; 43 tests failed and 21 passed. This run included the 4 lens probe specs, copied verbatim.
  - Passing after: 37222059865. 28 suites passed; 388 tests passed and 16 were skipped.
- Head build-and-test: 731 suites passed; 12,592 tests passed.
- Size: 2,012 lines changed (1,858 added, 154 removed). That is in the 1,500–3,000 band, so it needs a SIZE ASSESSMENT. About two-thirds is tests.

## Mobile #368 (branch b-privfu-117/apple-delete-copy): FIX ROUND 1 + READY FOR AUDIT
- Head: fdfecc47a4ff8a65bf1cd8f6a26f1c2a34c88c45. All checks were green (3 required, plus CodeQL), and the merge state was CLEAN.
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/368#issuecomment-5982922216
- PR body:
  - The tier header is now T4, because the `apple_revocation` handling changed.
  - A Fix round table was added with rows 0 and 1.
  - The Change and out-of-scope sections were updated.
- Findings closed: B-368-1 (both lenses), C-368-1, C-368-2 and C-368-3 (including authFailure.ts:183).
- Commits:
  - b5feeed8 tests only.
  - fdfecc47 the fix. It also corrects two of the new test assertions.
- CI-lane runs:
  - Failing before: 37222630053. 3 suites failed; 16 tests failed and 52 passed. The Sol probe file and the Opus patch were applied verbatim.
  - Passing after: 37222797494. 7 suites passed; 173 tests passed.
- Head CI: 453 suites passed; 6,335 tests passed.
- Size: 394 lines.

## Cleanup
- The ci/B-PRIVFU2-118-* branches (4) were deleted.
- The worktrees wt/B-PRIVFU2-118-{700,lane,368,mlane} were removed after their node_modules were unlinked.
- The shared deps are intact.

## Follow-ups (C)
- **C-700-2 remainder (backend).** 306 log calls in 141 files still print exception text. The list is `LEGACY_EXCEPTION_TEXT` in test/privacy/no-pii-in-logs.spec.ts, which must match exactly.
  - Fix rule: in each file, replace the text with `describeFailure(err[, module codes])` and lower the baseline.
  - This changes what ops see in logs (codes instead of messages), so it belongs in a separate mechanical PR.
- **Opus C-700-1 (backend).** The owner's free-text reason is in the coach-ai-budget log lines (coach-ai-budget.service.ts:425, :477). This needs a migration, as the job entry says.
  - Fix rule: store the reason, and log only its id and length.
- **Opus C-700-4 (backend).** Calorie values appear in log lines at macros.service.ts:95-96 and coach-ai.service.ts:413-414.
  - Fix rule: log ids and buckets, never the values.
- **finance-admin.client.ts `attempt()` (backend).** For network_error, `detail` returns the raw fetch message to the admin console. It does not reach logs.
  - Fix rule: return `describeFailure(err)`.
- **Other backend provider and request text:**
  - mux.service.ts:287 puts provider text into an error.
  - webview-detect.middleware.ts:202 logs the storefront `req.path`.
  - community-notifications.service.ts:258 is a near-miss.
  - Fix rule: use labels or ids instead of text.
- **First person in backend public copy.**
  - help-pages.html.ts:722 says "Our own copies keep only ...", while mobile now says "The app’s own copies ...". The two make the same claim with different subjects.
  - trust-pages.html.ts:210 and :251 also use "we/our".
  - Fix rule: give the operator a policy-voice decision. Legal pages may keep "we".
- **First person in mobile copy.**
  - deletionErrors.ts:101, :126, :129 ("We could not ...", "and we will help").
  - signupRoleNotice.ts:51, :55 ("we will set up coach access").
  - authFailure.ts:161 ("We couldn’t reach the server") and :186-187 ("the link we sent"). A test pins "the link we sent" in authFailureFixRound7.test.ts:43.
  - Fix rule: rewrite these with no subject, or with "the app", and update the pins.
- **Mobile #368 note.** Apple's revocation outcome is not part of the status response, so a later visit shows the conditional "If Apple did not confirm ..." copy.
  - Fix rule, optional: add `apple_revocation` to GET /me/delete-account/status, which would need a backend column.

## Operator decisions
1. #700 size is 2,012 lines (1,500–3,000 band). Recommended default: accept it. About two-thirds is tests: probe replays, guard self-tests and the 141-line baseline.
2. The C-700-2 legacy exception text. Recommended default: open a separate mechanical PR that works file by file against the baseline.
3. Backend policy-page voice ("we/our" on help and trust pages). Recommended default: leave the legal pages as they are, and fix only in-app copy.

## HANDOFF
- READY FOR AUDIT is posted on #700 at 5e3dabb0 (11/11 green) and on #368 at fdfecc47 (all green).
- Both PRs need fresh Sol and Opus lens audits at those heads. #700 also needs a SIZE ASSESSMENT.
- Nothing is pushed beyond those heads. There are no open ci branches or worktrees.
