# B-COMMWS-123 (F6, builder, Claude Opus 5.5, agent 123) — community posting dead-end (B-E2E-1)
Start 21:46 PDT 10-05. Time box 45 min (ends 22:31). Done 22:06 PDT.
Status: DONE. Both PRs pushed once, CI green, FIX ROUND 1 (OPENING) posted, READY FOR AUDIT. B count 0 open (B-E2E-1 fixed by the pair).

## PRs
- growth-project-backend#753 `fix/community-auto-provision-workspace` @ d5cdf747e4e5442929a911a9a96d44f74bd6021f (385 changed lines, src 60)
  - `CommunityRepository.ensureWorkspaceForCoach` (community.repository.ts): workspace upsert on slug `coach-<coachId>`, name
    "Community", cohort upsert on `workspace_id_name` "All members" sort_order 0 (clinic seed shape). Reuses an existing owned space;
    an archived space is not revived.
  - `CommunityService.getMe`: coach -> ensure; student with coach_id and no membership -> ensure, then the existing bootstrap.
  - `CommunityPostsService.canCreatePost`: owner, workspace coach OR any active unbanned member (was coach-only). REQUIRED: without it,
    the provisioned client still gets 403 community.post.client_posts_disabled on every Hall/Cohort post (scout sketch missed the
    coach-only gate). Filter/report/block already apply to posts; clients already write comments and cohort messages.
  - Tests: new test/community/community-me-auto-provision.spec.ts (unit, real service+repo over in-memory Prisma; 3/4 fail on main,
    4/4 pass). community-posts.e2e.spec.ts (live, CI job community-live-tests): test 2 now expects member post 201; new 2b = client of
    a coach with no space gets workspace+membership on /me, slug/name/cohort checked, repeat + coach /me reuse it, client posts 201,
    foreign client 404.
- growth-project-mobile#389 `fix/community-space-no-workspace` @ 6e3c581cadf225c33bfd0b9fe9c82604ae4b9878 (140 changed lines)
  - CommunitySpaceScreen: successful /me with workspace_id null -> "No cohort yet / Send your coach a message" (Home > Messages), no
    composer CTA. Route mode (no props, from Today "Visit the Hall"/cohort card) now reads the workspace from useCommunityMe (before,
    the routed Hall never loaded posts).
  - CommunityComposerScreen: submit disabled with no workspace (never posts to workspaces//posts) + plain note.
  - Tests: CommunitySpaceScreen.test.tsx + communityScreens.test.tsx; 5 cases fail on main, all 26 pass.

## Operator decision
- D-F6-1: member posts. Default **(a) keep #753 as is (members may post; matches the job's "student can post 201" acceptance and the
  app's existing "Your coach has turned off member posts" copy)**. (b) revert the canCreatePost hunk + e2e test 2 and instead hide the
  client composer CTA in the app (needs a further mobile change before the 10-07 build).

## Cs (not fixed)
- C-F6-1: Today "Send your coach a message" (CommunityTodayScreen goToMessages) does nothing while FEATURE/EXPO DM is off; after #753
  deploys only coachless clients reach it. One-line fallback to Home > Messages.
- C-F6-2: 403 body community.post.client_posts_disabled is now unreachable (kept for a future per-workspace toggle).
- C (edge, deferred to 10k clients): coach whose workspace has zero active cohorts.

## CI and comments
- b#753 @ d5cdf747: all checks green (build-and-test, community-live-tests 129/129 incl. posts e2e 2/2b, rls-live-tests, danger, R75,
  schema parity, CodeQL, audit; deploy-readiness-gate skipped). Live job:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37416038597/job/112114743793
  Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/753#issuecomment-6009703365
- m#389 @ 6e3c581c: Typecheck, lint, test green; CodeQL green (run 37416287056).
  Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/389#issuecomment-6009723008

## HANDOFF
- Done. b#753 @ d5cdf747e4e5442929a911a9a96d44f74bd6021f and m#389 @ 6e3c581cadf225c33bfd0b9fe9c82604ae4b9878, both READY FOR AUDIT
  (two lenses each, T4 access change on b#753 canCreatePost). Nothing merged or deployed.
- Operator: decide D-F6-1 (default (a) keep member posts). If (b): revert the canCreatePost hunk + posts e2e test 2 on b#753 and add a
  client-CTA hide on m#389 before the 10-07 build.
- Merge order: either order is safe. m#389 alone fixes the dead end (shows "No cohort yet"); b#753 deployed makes the Hall usable.
- Worktrees removed; no locks, claims or ci/audit branches created. PR branches stay (they are the PR heads).
