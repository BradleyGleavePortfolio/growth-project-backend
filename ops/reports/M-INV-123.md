# M-INV-123 — mobile coach Codes screen on /coach/codes (agent 123)

Started 19:42 PDT 10-05. Time box 80 min (ends ~21:02). Mobile main a33e5d75, backend main e6f9a5ec (b#658 merged as 214f0755).

## Progress
- 19:45 read COMMON, WAVE 2 preamble, own entry, SoT M-INV-120, B-INV2-120 "Mobile gaps", B-INV4-122.

- 19:50 PR1 m#385 opened (agent123/invite-refusal-copy, head 35f8c1e8825d7b710bd934f2d56642f6313976d6): day-one + signup refusal copy.
  Tests fail on main, pass here (pairWithCoachErrors 6/6, inviteAttachOutcome 7/7, day1OnboardingScreens 27/27, day1OnboardingFlow 22/22).
- 19:51 PR2 worktree wt/M-INV-123-2 (agent123/coach-codes-screen) started: api client + Codes screen + QR.
  QR decision: toqr 0.1.1 (already in package-lock via expo's CLI, MIT, pure JS) + react-native-svg (direct dep) instead of
  react-native-qrcode-svg (would add qrcode + deprecated text-encoding and a fresh install). Matrix decoded with OpenCV QRCodeDetector:
  29x29 for https://app.trygrowthproject.com/join/GP-7XQ9KM decodes to the same string.

- 19:59 PR2 m#387 opened (agent123/coach-codes-screen, head 2c7801ed8b31a6687ecab8fbb67c8ed902347d95), 1,135 counted lines.
  Local: CoachCodesScreen 8/8, coachCodesApi 6/6, qrMatrix 3/3, coachNavigation 4/4, reachabilityGates 19/19, InviteCtaWiring 6/6,
  CrossPillarSurface 8/8, declaredDependencies 32/32; scoped tsc (8 files, 73 src pulled in) clean; eslint clean.

- 20:00 m#385 CI green (CI 37406109000, CodeQL 37406108977); FIX ROUND 1 (OPENING) READY FOR AUDIT posted:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385#issuecomment-6008436605
- 20:01 m#387 second commit 326f3a630aa2d03c52e12eaad50c7c343d05a93c (bulk invite + who-joined links kept from the legacy screen, so the
  flag flip removes nothing); cancelled the CI run at 2c7801ed (37406837162). 1,168 counted lines. CoachCodesScreen 9/9.

- 20:06 m#387 CI at 326f3a63 failed one suite: quietLuxuryDoctrine (fontWeight 700 in CoachCodesScreen; 8084/8085 passed,
  run 37407002778, log ops/aud-123/M-INV-123/ci_387_326f3a63.log). Fixed to 600, doctrine test 10/10 locally.
- 20:07 m#387 head b54bea80c5c9948ec71465d4361dd0a1f36d76f7 pushed; CI running.

- 20:15 m#387 CI green at b54bea80 (CI 37407516837, CodeQL 37407516840); FIX ROUND 1 (OPENING) READY FOR AUDIT posted:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387#issuecomment-6008600789
- 20:16 worktrees wt/M-INV-123-1 and wt/M-INV-123-2 removed (all work pushed). No ci/* or audit/* branches, no lane runs, no locks.
  Ended 20:16 PDT (34 minutes of 80).

## Result
| PR | Title | Tier | Head | Size | CI | Comment |
|---|---|---|---|---|---|---|
| m#385 | fix(invites): say when a code was turned off, expired or used up | T3 | 35f8c1e8825d7b710bd934f2d56642f6313976d6 | ~128 | green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385#issuecomment-6008436605 |
| m#387 | feat(coach): Codes screen to create, rotate, turn off and share codes as a QR | T4 | b54bea80c5c9948ec71465d4361dd0a1f36d76f7 | 1,168 | green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387#issuecomment-6008600789 |

Both are based on main and independent (split by surface: client refusal copy vs coach screen, rather than api-then-screen,
so #385 can merge before the 10-07 build on its own; the refusals are live as soon as the backend with b#658 is deployed).

## Decisions (recommended defaults)
1. QR encoder: toqr 0.1.1 (already in package-lock via the Expo CLI, MIT, pure JS, one root lockfile line, package.json pinned) instead
   of react-native-qrcode-svg (would add qrcode + deprecated text-encoding). Default: accept. Proof: OpenCV decode of the matrix.
2. Gate: the existing InviteCodes route asks GET /coach/codes; 404 (coach_code_tools_disabled or bare) shows the legacy screen. No
   separate row to hide; every entry point keeps working either way. Default: accept.
3. #385 also maps coach_not_accepting_clients and already_attached_to_different_coach on Day-1 pairing (they also showed "not
   recognized"). Default: accept (two sentences, same function).
4. The flag flip waits for the lens pair on #387 plus a device pass (scan from the QR sheet, Share QR image on iOS and Android).

## Follow-up Cs (not done)
- Day-1 "network" string says "Couldn't reach our servers" (existing copy, first-person plural). One-line copy fix later.
- Backend C-658-8 (signups baseline) is avoided on mobile by asking for 8 days.

## HANDOFF
- DONE 20:16 PDT. m#385 @ 35f8c1e8 and m#387 @ b54bea80, both CI green, both FIX ROUND 1 (OPENING) READY FOR AUDIT posted.
- Next for the operator: lens pair on #385 (T3) and #387 (T4); merge #385 before the 10-07 build; #387 can ride the build dark
  (server flag off -> legacy screen) and flip FEATURE_COACH_CODE_TOOLS after a device pass.
- Drafts: ops/aud-123/M-INV-123/{pr1_body.md,pr2_body.md,comment_385.md,comment_387.md}; CI log of the one red run:
  ops/aud-123/M-INV-123/ci_387_326f3a63.log. Notify: ops/lanes123/notify/M-INV-123.txt.
- Cleanup done: worktrees removed; local branches agent123/invite-refusal-copy and agent123/coach-codes-screen remain in the main
  clone as the PR heads (do not delete while the PRs are open). Nothing in flight.
