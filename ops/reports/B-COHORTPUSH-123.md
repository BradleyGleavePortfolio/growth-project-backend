# B-COHORTPUSH-123 — F11 group chat push (C-S-PUSH-4), agent 123

Builder: Claude Opus 5.5. Started 09:27:57 PDT 10-06 (time box 35 min, ends 10:03). Finished ~09:59.

## PR
- growth-project-backend#757 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/757
- Branch fix/cohort-chat-push, head 0856638c9d2609780ef62b61fedac4025d9bc69a (base main e9b82e1387bcfe647801e842f466ac6dc1fb32cb).
- Commits: a5c3ce99 (fix + spec), af9a0af2 (R75: no new cast tokens in specs), 0856638c (log line via describeFailure).
- Size 365 changed lines (363 +, 2 -), 11 files. Under 1,500.
- FIX ROUND 1 (OPENING) comment, ends READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/757#issuecomment-6021230479

## What changed
- src/community/messages/community-messages.service.ts: `send` ends with fire-and-forget `pushCohortMessage` (after write + realtime).
  One COMMUNITY_MESSAGE_RECEIVED push per recipient through existing `sendCommunityPush` (flag, Mute all since b#751, token,
  lock-screen privacy). Input: targetType=message, targetId=<message id>, deepLink=tgp://community/cohorts/<cohort id>, no body
  context (body stays the fixed "New community message"). Skips both block directions (`hiddenFromViewer(sender)`) and
  notify_level "quiet". Errors caught, logged via describeFailure; send never fails.
- src/community/messages/community-messages.repository.ts: `listCohortPushRecipients` = active memberships of the cohort minus the
  sender minus active workspace bans (`bannedAmong`).
- src/community/notifications/community-notifications.service.ts: `pushEnabled()` made public (skip lookup when push off).
- Specs: new test/community/messages/community-messages-push.service.spec.ts (8 cases; red on main 6 fail, green with fix); new helper
  test/community/messages/community-push-test-helpers.ts (`noCommunityPush()`); constructor arity in 4 unit specs and provider list
  in 2 live-DB e2e specs (push stub, off).

## Local runs (heavy.sh, one file at a time)
- push spec 8/8, coach-reply 4/4, safety-flow 14/14, block-two-way 75/75, challenges cross-surface 11/11, no-pii-in-logs 11/11.
- eslint clean on touched files; R75 local range check net 0. community-notifications.service.ts was already non-prettier on main.

## CI
- At 0856638c (09:57): R75, danger, build-sbom, rls-floor-guard, test-deploy-readiness green; build-and-test, community-live-tests,
  rls-live-tests, mwb-3-live-tests, Schema parity, CodeQL running when I stopped.
- At af9a0af2: type-check/lint/build green; suite 2 failing files of 876: no-pii-in-logs (mine, fixed in 0856638c) and
  test/booking-lock-screen-push.spec.ts ("tomorrow" vs "today"; untouched by this PR; same failure on #756 and #758 today,
  clock-dependent on main). community-live-tests green.
- npm audit (required) red on main e9b82e13 too: critical shell-quote GHSA-pqg4-j6r4-53mv, no exception. Pre-existing.

## Operator decisions (defaults applied, in PR body)
1. notify_level "digest" (column default; nothing writes it today) pushes like "live"; only "quiet" is skipped. Default: keep.
2. Workspace coach without an active membership row in the cohort is not pushed (brief: cohort members; coach inbox covers client
   messages). Default: keep.
3. Main-wide blockers for every backend PR (not this lane): npm audit shell-quote critical (needs a lockfile bump or a dated exception)
   and booking-lock-screen-push clock-dependent spec. Default: one small builder job for each.

## Cs (follow-up, not fixed)
- C: core createNotification returns null for community kinds (digest prefs prefix, push default false), so sendCommunityPush pushes
  but writes no inbox row and its replay guard never finds one. Pre-existing for DMs/replies too.
- C: mobile has no tgp://community deep-link route; a tap opens the app like the other community pushes.

## HANDOFF
- State: PR #757 open at 0856638c, opening comment posted (READY FOR AUDIT). Worktree /home/user/workspace/wt/B-COHORTPUSH-123-1
  removed (all work committed and pushed). No ci/* or audit/* branches created. No locks held.
- Next: wait for build-and-test at 0856638c; the expected red is only booking-lock-screen-push (pre-existing) plus npm audit
  (pre-existing). If any community spec fails, a fresh builder adds a worktree from origin/fix/cohort-chat-push and fixes only that.
- Lens pair (T3/T4: push recipients = data to the right person) audits #757 at 0856638c.
