# B-PUSHMUTE-123 — community push honours "Mute all notifications" (B-S-PUSH-1)

Agent 123 wave 3 fix queue F1; Claude Opus 5.5 builder; started 21:50:41 PDT 10-05 (30-minute box).

## Result
- PR: growth-project-backend#751 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/751
- Branch `agent123/community-push-mute`, head `6a0261331490412ad1ba3549efa12f67cc4d7d98`, base main 5230306c.
- Title: `fix(community): honour Mute all notifications for community push` (Conventional Commits).
- Size: 2 files, +134 / -1 (src 15/1, test 119). Under the 600 wave-3 cap and the 1,500 rule. R75: no new banned tokens.
- Commit identity Bradley Gleave <bradley@bradleytgpcoaching.com>, no AI co-author.

## Change
`src/community/notifications/community-notifications.service.ts`: inside the existing try block, before the replay guard / inbox
write / `pushToUser`, call `this.notifications.channelGate(recipientId, kind, 'push')`; when it returns `'muted'`, emit
`community.push.skipped` with reason `muted` and return. The gate's `'off'` is deliberately ignored (community kinds fall back to the
`digest` prefix whose push default is false), so the COMMUNITY_PUSH_DEFAULTS table remains the per-kind source. New SkipReason `muted`.

## Tests
`test/community/notifications/community-push-mute.spec.ts` (real NotificationsService gate over stubbed Prisma, `pushToUser` spied):
1. muted reply -> no pushToUser, no inbox row, skipped/muted telemetry. FAILS on main (verified by swapping in main's service file).
2. unmuted reply (digest_push false) -> pushToUser('author-1', 'Community', 'New reply on your post', {kind, category client_bot, target}).
3. no preferences row -> sends.
Local via heavy.sh: 3/3 pass; eslint clean on both files; prettier clean on the spec (main's service file already fails prettier
before this change; not reformatted).

## CI / comment
- PR CI at 6a026133: 15 checks green (build-and-test, community-live-tests, rls-live-tests, mwb-3-live-tests, danger, R75, CodeQL,
  schema parity, npm audit, test-deploy-readiness, size-label, build-sbom, rls-floor-guard, comment-deploy-readiness); deploy-readiness-gate
  skipped by design. build-and-test: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37415941434/job/112114448918
- Opening comment (ends READY FOR AUDIT): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/751#issuecomment-6009682742
- Finished 22:02 PDT (about 12 minutes of the 30-minute box).

## Cs
- C (pre-existing, not in scope): for community kinds `createNotification` returns null (digest_push default false), so no inbox row
  is written and the idempotency replay guard never finds a row. Not changed here.

## HANDOFF
- Status: DONE. PR #751 open at 6a0261331490412ad1ba3549efa12f67cc4d7d98, CI green, FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT.
  Not merged, not deployed.
- Worktree /home/user/workspace/wt/B-PUSHMUTE-123 removed; local branch deleted (remote branch agent123/community-push-mute is the PR head).
  No locks or ci/* branches taken.
- Next: two-lens audit of #751 at 6a026133 (operator assigns). Comment and PR body drafts: ops/aud-123/B-PUSHMUTE-123/.
- Operator decision: none needed. B count in this job: 0 open (B-S-PUSH-1 fixed in #751).
