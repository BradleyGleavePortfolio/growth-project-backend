# B-AUTHZ-123 — F5 cohort member assignment + legacy block list (B-AUTHZ-1, B-AUTHZ-2)

Builder: Claude Opus 5.5, agent 123. Start 21:48:51 PDT 10-05; time box ends 22:28 PDT.
Evidence: ops/reports/S-AUTHZ-123.md (B-AUTHZ-1, B-AUTHZ-2 only; B-AUTHZ-3 is in b#747, getLeaderboard untouched).

## PR

- growth-project-backend#752 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/752
- Branch fix/community-cohort-assign-authz, base main 5230306c, head 69ad43d08f874f5a4d0122785493fd2c4d28187b
- Size: +200 / -11 = 211 changed lines over 6 files (the 1,500 rule and the 600 wave cap both hold). No new as any / as unknown as / as never, no empty catch.

## Fix

B-AUTHZ-1 (community-cohort-members.service.ts + .repository.ts): assign() builds an AssignTargetScope before the lookup.
For the platform owner it is null (override). For a coach it is the workspace coach id plus the workspace id. findUserById and
findUserByEmail filter by `deleted_at: null AND (coach_id = workspace coach OR active CommunityMembership in the workspace)`.
A foreign or unknown target gets the same coded 404 community.cohort.user_not_found (the code is already in the mobile contract).
Nothing is returned from the lookup, and there is no ban lift and no membership/invite upsert.

B-AUTHZ-2 (messages-safety.service.ts): listBlocks selects blocked.role. Student targets get memberFirstName(name); coach, owner and
sub_coach targets keep the profile name. Block and unblock are unchanged, with no new gate.

## Tests (fail on main, pass on the branch; local via heavy.sh, one file at a time)

- Service spec: 4 new tests (foreign by user_id, foreign by email, own client, owner override). On main 3 fail; the own-client
  positive control passes on both, as intended.
- Repository spec: 2 new tests (scoped where-clause for id and email). Both fail on main.
- messages-safety spec: 2 new tests (client first name, coach full name). The client test fails on main.
- On the branch: 21/21, 4/4, 33/33. ESLint is clean on the 6 files. Logs: ops/aud-123/B-AUTHZ-123/{main,fix}-*.log.

## Cs (not fixed, scope)

- C (scope): a coach can only add a co_coach who is on their roster, already active in the workspace, or added by the platform owner.
  Mobile has no co_coach flow today; a team sub-coach acceptance flow is follow-up work.
- C (edge, deferred to 10k clients): the legacy POST /api/users/:id/block still accepts any existing id. It now reveals only a
  first name for clients, which matches the community surfaces.

## CI

All 16 checks at head 69ad43d0 were green at 22:05 PDT, including build-and-test (full tsc + suite), community-live-tests,
rls-live-tests, mwb-3-live-tests, R75 banned casts, Danger, CodeQL and Schema parity. deploy-readiness-gate was skipped.
CI run: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37416022838

## HANDOFF

- Done 22:06 PDT. Posted FIX ROUND 1 (OPENING) ... READY FOR AUDIT on #752 @ 69ad43d08f874f5a4d0122785493fd2c4d28187b:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/752#issuecomment-6009725877
- Notify file written: ops/lanes123/notify/B-AUTHZ-123.txt. Worktree /home/user/workspace/wt/B-AUTHZ-123 removed. The local branch
  is deleted; the remote branch fix/community-cohort-assign-authz stays because it is the PR head. No ci/* or audit/* branches were
  created.
- Next (operator): two lenses (T4 access/privacy) at head 69ad43d0. If they post Bs, a fix round goes on the same branch.
  Never merge or deploy from this lane.
- Operator decision: are cross-roster cohort invitations intended? Default: no. Foreign direct assignment is now refused, and any
  future cross-roster flow would need an acceptance step.
