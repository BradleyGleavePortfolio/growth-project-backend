FIX ROUND 8 (B-611-116, agent 116) — growth-project-backend#611 @ 357c40fe86aba7dd09fc39b4ec4118ef550e5ae0

This round closes GPT-6.1 Sol's B-611-7 ([5975837459](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459), 0/1/0) and every finding in Claude Opus 5.5's verdict ([5975902540](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975902540), 0/2/5), both at `5eac8f21`. It also applies the operator's ruling on Opus RG-1 (Sign in with Apple), and merges current main.

**Main merge.** Main `d23fa317` was merged as `aeb3b438`. The merge was clean. Its tree `9decfbd2` equals `git merge-tree --write-tree 5eac8f21 d23fa317`. Main (#647) touches only notifications and scheduling: no public page, Sentry or deletion file.

**Failing-before.** Commit `783bf2d2` is `aeb3b438` plus the two new specs only. It ran in the CI lane as [run 37172439577](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172439577): 17 failed, 10 passed.
- Every finding test fails.
- The controls pass: the backend Sentry boundary, the voice checks and the 7 owner-answer pins.

**After:** this head's CI.

| Finding | Change | Commit | Test (fails at 783bf2d2, passes at head) |
|---|---|---|---|
| Sol B-611-7 = Opus C-611-12: the policy said crash and performance reports include the email address | **Privacy, "Device, usage and diagnostic data":** "...and crash and performance reports linked to your account ID, with no name or email address attached."<br>**Telemetry:** unchanged and id only (mobile `setSentryUser` / `scrubEvent`; backend `beforeSend` sends no `user`).<br>**Docs:** procedures §6 records both halves and the public sentence. README rule added. The PR-body vendor row no longer shows `setUser({ id, email })`. | 357c40fe | `test/privacy-diagnostics-disclosure.spec.ts`: the rendered bullet; no sentence on either policy ties email to reports; §6 and the page agree; backend `beforeSend` drops a `{ id, email }` user (control) |
| Opus B-611-10: `/help/delete-account` "What we keep" lists less than the Privacy Policy | **Added to the list:**<br>- the closed-account record, kept with no end date;<br>- the sign-in provider's account ID while its removal is retried, then the 30-day one-way code;<br>- Anthropic's 30-day copy;<br>- Sentry 90 days, Resend 30 days and PostHog 30 days;<br>- de-identified information.<br>**Shared strings:** exported `CLOSED_ACCOUNT_RECORD_TEXT`, `ONE_WAY_CODE_TEXT`, `ANTHROPIC_RETENTION_TEXT` and `DEIDENTIFIED_TEXT`, used by both pages. The owner-approved Privacy paragraph renders the same words. | 357c40fe | `test/privacy-round8-retention.spec.ts` B-611-10: 4 tests, including one that pairs every item `/privacy` keeps with its help-page counterpart and one that checks the shared exports |
| Opus B-611-11: the runbook dump step has no deletion rule | **`docs/deploy-runbook.md` §2 step 3 and §3 step 1** now state the §1.1 rules and link §1.1:<br>- one owner-controlled location;<br>- the file named with its date;<br>- deleted 30 days after the deploy is verified;<br>- never kept more than 90 days;<br>- a monthly check;<br>- the local `backups/` file deleted the same day.<br>"S3 bucket, etc." is gone.<br>**BCP weekly export:** points to §1.1 and requires noncurrent-version expiry.<br>**§1.1:** no longer quotes the old line. | 357c40fe | B-611-11 (4 tests) |
| Opus C-611-13: Mux receives the device IP address | **Privacy Mux bullet** adds: "When a video is uploaded or played, the device connects to Mux directly, so Mux also receives its IP address and device type." The §8 row is updated. | 357c40fe | C-611-13 |
| Opus C-611-14: PostHog deletes asynchronously | **Procedures §8/§9:** the owner removes the person within 21 days. The public 30-day wording is kept. | 357c40fe | C-611-14 |
| Opus C-611-15: RCW 19.373.010 says "process" | **Both policies and the help page:** "commits publicly to keep and use it only in de-identified form". | 357c40fe | C-611-15; the owner-answers pin moved |
| Opus C-611-16: "kept while your account is open" is absolute | "Unless a shorter period is listed above, your information is kept while your account is open." | 357c40fe | C-611-16 (also checks the retention list sits above it); the owner-answers pin moved |
| Opus RG-1 + operator ruling: production has no Apple key, so the sentence "we ask Apple to revoke TGP’s access" is false today | **New sentence:** "If you used Sign in with Apple, deleting your account ends the app’s link to your Apple ID. To remove the app from your Apple ID as well, on your iPhone open Settings, tap your name, then Sign-In & Security, then Sign in with Apple, choose the app and stop using it with your Apple ID."<br>**Rest of the approved paragraph:** byte-identical.<br>**Follow-up:** procedures §0/§8/§9 and the PR body record it. Once the owner sets `APPLE_TEAM_ID`, `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY` in production, a follow-up PR restores the revocation sentence. | 357c40fe | RG-1 (no "revoke" on any policy page; the true path is stated) + "the rest of the approved deletion paragraph is unchanged" |

**Pre-push checklist**
- (a) Nothing new reaches logs, Sentry or analytics. The telemetry boundary is unchanged and pinned.
- (b) and (c) do not apply: this round changes copy and docs only.
- (d) The new copy has no first person, no exclamation marks and no emojis, and does not name the clinic partner. Voice tests in both specs check this.
- (e) Every finding has a failing-before test (run above).
- (f) Size after this round: +2,500/-243 (2,743), under 3,000.

**Local checks** (heavy.sh, `--runInBand --ci`)
- 10 suites, 142 passed: both new specs, owner-answers, restore-split, trust-pages, help-delete-account, help-pages, public-pages, the support-email guard and sentry-config.
- eslint is clean on the 5 changed TS files, and `check-r75` reports OK.

The tier stays T4, and no promotion trigger fired. No route, rendering, telemetry or deletion code changed.

**Checks at 357c40fe:** all 11 required checks are green: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, npm audit, CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity and community-live-tests.
- The first build-and-test attempt failed only on the known flake: a jest worker ran out of memory in `test/community/rls/community-message-shape.live.spec.ts` (718 suites passed, including both new specs).
- The single rerun passed: [job 111350501659](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172679752/job/111350501659), with 718 suites and 12,388 tests passed, and 23 suites, 239 tests and 5 todo skipped.

**Branch state:** main moved to `f57baba3` (#664, the multer 2.4.0 dependency bump: `package.json`, the lockfile and one spec) at about 20:20 PDT, after this push. It does not overlap with #611's files. `git merge-tree --write-tree 357c40fe f57baba3` is clean, with tree `7a915dbc`. This brings in a lockfile change, so I did not merge it here. It is a mechanical update-branch for the operator, followed by a merge-only delta.

READY FOR AUDIT
