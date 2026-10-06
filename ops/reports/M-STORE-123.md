# M-STORE-123 — store-review mobile fixes for the 10-07 build (F3, agent 123)

Builder: Claude Opus 5.5. Started 21:47 PDT 10-05 (time box 50 min, ends 22:37). Base: mobile main a727eb49.

PR: growth-project-mobile#390 — https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/390
Branch `agent123/m-store-review`, head `f55cc61b7fc7da9beea1a183fb579229052454b0`. 15 files, +642 / -9 (under 700).
Commits (author/committer Bradley Gleave, no co-author):
1. `4f5bda08` fix(app-config): iOS camera and photo-library purpose strings; no Android RECORD_AUDIO while voice notes are off
2. `6d542519` feat(community): one-time community terms agreement and a Terms line on Create account (Apple 1.2)
3. `f55cc61b` fix(trust): truthful Trust Center security copy; mark stale Play data-safety worksheets superseded

## What was fixed
- (a) B-IOSREV-1: `app.json` `expo.ios.infoPlist` adds NSCameraUsageDescription, NSPhotoLibraryUsageDescription,
  NSPhotoLibraryAddUsageDescription (scout's exact purpose text). No code change; build number untouched.
- (b) B-IOSREV-2: `src/components/community/CommunityTermsGate.tsx` (new) wraps `CommunityNavigator` (client tab),
  `CoachCommunityNavigator` (coach tab) and More > Community (`withProtectedScreen(withCommunityTerms(CommunityScreen))`).
  Shows COMMUNITY_GUIDELINES + zero-tolerance sentence; "Agree and continue" stores `community_terms_agreed:v1:<userId>` in
  prefsStorage; "Read the Terms of Service" opens TERMS_URL. Unreadable storage -> asks again (never skips). CreateAccount
  shows "By creating an account, you agree to the Terms of Service and the Privacy Policy." with both links above the
  Create account button (covers email, Google, Apple). Shared opener `src/lib/legalLinks.ts` (failure alert names the page
  and gives the address; logged via logger.warn; no empty catch).
- (c) B-STORECOPY-1: TrustCenterScreen metadata value "Encrypted in transit; secure token storage" and the three packet
  bullets; group label "Security and storage"; offline fallback meta string updated to match.
- (d) B-STORECOPY-4: superseded banners in PLAY_STORE_READINESS.md section 4 (+ Permissions declared) and
  docs/PLAY_INTERNAL_TESTING_PACKAGE.md sections 5 and 6, linking the packet on tgp-agent-context main and listing the gaps.
- (e) B-PLAYREV-1: expo-audio `recordAudioAndroid: false` + `android.permission.RECORD_AUDIO` in blockedPermissions.
  Proof of no reachable recording UI: `communityVoiceNotes` default false, not set in any eas.json profile; the only recorder
  (VoiceNoteComposer -> useVoiceRecorder -> useNativeVoiceRecorder) is mounted only by the CommunityVoiceComposer route,
  registered only when the flag is on. Real expo-audio plugin evaluated in a test: no RECORD_AUDIO.

## Tests (local, heavy.sh, one file at a time)
- new `src/config/__tests__/storeReviewPermissions.test.js` 9/9 (fails on main)
- new `src/components/community/__tests__/CommunityTermsGate.test.tsx` 11/11 (fails on main)
- `src/screens/__tests__/trustCenterPolicyLinks.test.tsx` 27/27 (+2 new, fail on main)
- `src/screens/auth/__tests__/CreateAccountScreen.test.tsx` all pass (+1 new, fails on main)
- communityFlagOff / coachCommunityFlagOff / communityVoiceFlagOff 23/23; validate:config OK; eslint changed files 0 errors.
- Full typecheck / suite: PR CI (see status below).

## CI
At f55cc61b: Typecheck, lint, test SUCCESS (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37416332741/job/112115649272);
CodeQL (actions + javascript-typescript) SUCCESS. Opening comment (READY FOR AUDIT):
https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/390#issuecomment-6009738738 (posted ~22:07 PDT).

## Cs (not fixed, one line each)
- C-1 backend /terms lacks the "no tolerance" sentence and still has the "company policy draft" intro (S-IOSREV C-4); backend PR.
- C-2 `src/components/trust/TrustCueRow.tsx` says "End-to-end encrypted"/TLS 1.3/AES-256 but is not rendered anywhere (dead code); delete or fix later.
- C-3 `src/services/README.md:8` and `src/storage/mmkv.ts` comments still say "secure enclave"/AES-256 (docs only).
- C-4 push/deep link straight into a Community thread for a user who has not agreed shows the gate first, then the stack opens at its initial route (nested params may be lost): C (edge, deferred to 10k clients).

## HANDOFF
- State: DONE. PR #390 open at f55cc61b7fc7da9beea1a183fb579229052454b0, CI green, opening comment posted (READY FOR AUDIT). Not merged.
- Worktree /home/user/workspace/wt/M-STORE-123 removed at the end (branch lives on origin). No locks/claims held.
- Next: two lenses audit #390 (operator assigns). If a fix round is needed: recreate a worktree from
  origin/agent123/m-store-review, link deps with ops/link_deps.sh mobile, fix, one push.
- Notify: /home/user/workspace/ops/lanes123/notify/M-STORE-123.txt
