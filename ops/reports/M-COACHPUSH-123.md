# M-COACHPUSH-123 — F8 coach push ask + Community "message your coach" (agent 123, Claude Opus 5.5 builder)

Started 09:27:57 PDT 10-06 (time box 35 min, ends 10:03). Repo: growth-project-mobile, base main @ 435e67a97be515703e1915663fc3323176c5257a.

## PR
- mobile#393 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/393
- branch agent123/m-coachpush, head 59ec57770771b4f98f61e5ffc3180cef37b129c4
- size: 11 files, +313/-29 (well under 1,500). No lockfile, Expo or EAS changes.

## Changes
(a) C-S-PUSH-3: `src/screens/coach/ClientsListScreen.tsx` (the real coach landing tab; CoachNavigator initial tab = ClientsStack ->
ClientsList, and it mounts only after the coach wizard) now mounts `<PushPermissionCard audience="coach" />` under the header.
`PushPermissionCard` has a new optional `audience` prop (default client, so client Home copy is unchanged). The coach copy is
"Turn on notifications so you see client messages and new client alerts." Behaviour is unchanged: the same per-user dismiss key
(once per account), shown only when status != granted and canAskAgain, OS prompt only on "Turn on", and the token is registered
through the existing registerForPushNotifications({requestPermission:true}) + usersApi.updatePushToken path.
(b) C-F6-1: `CommunityTodayScreen.goToMessages` with communityDm OFF now navigates to Home > Messages (the 1:1 coach thread, the
same target as the m#389 CommunitySpaceScreen no-workspace state). With DM ON it still opens CommunityDmList. When
`client.coach_id` is empty, the "Send your coach a message" button is hidden on Today (no_membership) and on the Space
no-workspace state. `CommunityEmptyState` now has optional actionLabel/onAction and renders the CTA only when both are given.
The notifications README line is updated.

## Tests
- New `src/screens/community/__tests__/communityMessageCoach.test.tsx` (5): on main 3 fail and 2 regression guards pass. With the fix, 5/5 pass.
- New `src/screens/coach/__tests__/ClientsListPushPrimer.test.tsx` (3): on main 2 fail and 1 guard passes. With the fix, 3/3 pass.
- `PushPermissionCard.test.tsx`: +1 coach-audience test (5/5 pass).
- Updated: the CommunitySpaceScreen.test user mock now has coach_id; ClientsListRiskPill.test stubs the card (its theme mock lacks semanticColors).
- Local runs via heavy.sh, one file at a time, all green: ClientsListRiskPill 5, CommunitySpaceScreen 10, CommunityTodayScreen 2,
  communityScreens 16, InviteCtaWiring 6, skeleton 28, communityFlagOff 9, HomeHeaderActions 4. eslint on the changed files: 0 errors
  (1 pre-existing warning in ClientsListScreen useEffect deps).

## CI @ 59ec5777 (all green, 09:39 PDT)
- Typecheck, lint, test: SUCCESS https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37496893581/job/112383621750
- CodeQL / Analyze (actions, javascript-typescript): SUCCESS https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37496893536
- Mergeable: MERGEABLE.

## Comment
FIX ROUND 1 (OPENING), ending READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/393#issuecomment-6020930007

## Cs (not fixed, scope)
- C-M393-1: the Roman `noCohorts` copy says "Your coach will place you in one", which a coachless client still sees now that the
  button is hidden. A copy-only follow-up (a coachless stem) would fix it.
- C-M393-2: with communityHall OFF, Today's "Visit the Hall" falls back to goToMessages, so it now opens coach Messages instead
  of doing nothing. This only happens in an odd flag combination.

## HANDOFF
- State: DONE at 09:40 PDT. mobile#393 is open at head 59ec57770771b4f98f61e5ffc3180cef37b129c4, CI is green, and the opening comment has been posted.
  Not merged (never merge). Worktree /home/user/workspace/wt/M-COACHPUSH-123-1 is removed. No locks or claims are held, and no ci/* or audit/* branches were created.
- Next: two-lens audit of mobile#393 at 59ec5777. It must merge before the Wed 10-07 Expo build, which the operator/owner decides.
- If a lens raises a B: create a worktree from origin/agent123/m-coachpush (`git -C /home/user/workspace/growth-project-mobile worktree add
  /home/user/workspace/wt/M-COACHPUSH-123-2 origin/agent123/m-coachpush`), link deps (`ops/link_deps.sh mobile <wt>`), fix, run single
  jest files via heavy.sh, push once, and post FIX ROUND 2.
- Operator decisions: C-M393-1 (coachless noCohorts copy). Recommended default: a copy-only follow-up after launch, or fold it in if a lens
  calls it a false claim.
