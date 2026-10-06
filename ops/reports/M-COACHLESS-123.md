# M-COACHLESS-123 — mobile coachless Home + featured coach + scripted Roman card (agent 123, Claude Opus 5.5)

Started 19:42 PDT 10-05 (time box 80 min -> 21:02); finished 20:07. Repo: growth-project-mobile only. Nothing merged or deployed.

## PR
- growth-project-mobile#386, branch `agent123/m-coachless-home` (base main a33e5d75), head
  **0a1bc0bd7d18348742184a2e5dcac1a1c961748d** (commits 28a77608 feat + 0a1bc0bd fix).
  Title: feat(client-home): coachless Home banner, coach code sheet and scripted Roman card. Tier T4 (attach + checkout hand-off).
  Size 1,189 changed lines (339 test), under 1,500. Body: ops/aud-123/M-COACHLESS-123/pr_body.md.
- PR CI green at the head: CI run 37407056784 (Typecheck, lint, full test suite: success), CodeQL 37407056724 success. The first
  head 28a77608 was also green (run 37406619503).
- FIX ROUND 1 (OPENING) + READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008505792
- Notify: ops/lanes123/notify/M-COACHLESS-123.txt.

## What it does
- `coachless_home` added to SERVER_FEATURE_FLAG_KEYS (src/api/featureFlagsApi.ts) + useFeatureFlags (OFF by default).
- `src/api/coachlessApi.ts`: zod client for GET /coachless/home, POST coach-code/check, coach-code/redeem (Idempotency-Key header),
  roman-card/seen, roman-card/not-now; `coachlessFailureOf` maps the global error envelope `code` (never the server text); 404 = off.
- `src/components/coachless/CoachlessHomeSlot.tsx` (HomeScreen, after DunningBanner): server banner (title; offer, featured coach and
  package price + "Use code <code>" only while the server returns the offer), "Enter a coach code" always while coachless; scripted
  Roman card (server text verbatim; shown only while roman_card is returned AND banner.code is set), one /seen per displayed card,
  Not now hides + persists.
- `CoachCodeSheet.tsx`: live check (debounced 400 ms, latest wins), Join with one UUID key per code reused on retry (new key for a new
  code or after idempotency_key_reused / _required). Welcome moment: grant created/already_active -> "Your plan with X is active."
  Done; grant pending_consent -> message the coach (never checkout); packages_available > 0 -> "Choose a plan" -> existing Day 1
  PackageSelectionSheet with initialPackageId = next.featured_package.id (new optional prop; opens 450 ms after the code sheet closes,
  two modals cannot animate at once on iOS); 0 plans -> Message coach. patchUserCache({coach_id}).
- `coachlessCopy.ts`: specific copy for all 14 server codes + network / 429 / 400 / unexpected (reference id for redemption_failed).
- No owner admin screen, no eas.json change, no lockfile change.

## Evidence (local, heavy.sh, one file at a time)
- CoachlessHomeSlot.test.tsx 11/11; PackageSelectionSheet.subscription.test.tsx 37/37 (+2 for initialPackageId);
  useFeatureFlags.test.tsx 7/7; HomeScreen.macroMode 3/3 (slot mocked); copyVoice.guard 8/8; quietLuxuryDoctrine 10/10.
  eslint on changed files: 0 errors (3 pre-existing HomeScreen warnings). Full tsc + suite: PR CI (green).

## Decisions for the operator
- D1 (owner config, not code): Roman's pitch is FeaturedCoachConfig.roman_pitch_text and mobile renders it verbatim, so the "you're"
  fix lands when the owner saves the config: "Sir/Ma'am, just so you're aware, TGP's top coach has available slots. Enter code
  <featured code> and join for <price>. Interested?" Recommended default: include this exact line in the owner's PUT
  /admin/featured-coach step before the FEATURE_COACHLESS_HOME flip.
- D2: checkout hand-off is one tap ("Choose a plan") from the welcome moment, not automatic, so the welcome moment is seen.
  Recommended default: keep.

## Follow-up Cs (not fixed, out of scope)
- C-386-a: mobile has no surface for POST /consent/grant `onboarding.agreement`, so a pending_consent grant (only when contracts are
  on) waits on the coach; this PR routes that client to the coach thread instead of checkout.
- C-386-b C (edge, deferred to 10k clients): PackageSelectionSheet's 24 h "Skip for now" suppression would close the hand-off sheet if
  the same user skipped a coach's sheet in the last 24 h (needs a prior coach).

## HANDOFF (20:07 PDT 10-05)
- Done: PR #386 open at 0a1bc0bd7d18348742184a2e5dcac1a1c961748d, PR CI green, OPENING + READY FOR AUDIT posted, notify written.
- Next: Opus + Sol lenses on #386 at 0a1bc0bd (T4). If a lens posts a B: recreate a worktree
  (`git -C /home/user/workspace/growth-project-mobile worktree add /home/user/workspace/wt/M-COACHLESS-123-2 origin/agent123/m-coachless-home`),
  link deps (`ops/link_deps.sh mobile <wt>`), fix as a new commit (no force-push), run the touched test file via heavy.sh, one push,
  post `FIX ROUND 2 (M-COACHLESS-123, agent 123) — growth-project-mobile#386 @ <sha>`.
- Before the FEATURE_COACHLESS_HOME flip: #386 merged and in the 10-07 build, owner saves the offer (D1), device pass.
- Cleanup done: worktree wt/M-COACHLESS-123-1 removed (all work pushed); no ci/* or audit/* branches created; no locks taken.

---

# FIX ROUND 2 on m#386 (20:26-20:36 PDT 10-05, time box 30 min)

Input: both lenses REQUEST CHANGES at 0a1bc0bd (Sol 6008549315 B-386-SOL-1; Opus 6008571221 B-386-OPUS-1).

## Changes (one commit 64c5bde0, 4 files, +157/-2; one push)
- B-386-SOL-1: `CoachCodeSheet.tsx` calls the shared `refreshEntitlement()` (useEntitlement) on a successful redeem (failure logged via
  logger.warn, no empty catch). A granted free/prepaid plan now unlocks the gate without a foreground/restart.
- B-386-OPUS-1: `CoachlessHomeSlot.tsx` onChoosePlan: `nonP2PPurchasesHidden()` (iOS) -> `navigation.navigate('MoreTab', { screen:
  'ClientPackages' })` (the labelled 1:1 coaching screen); Android keeps the Day 1 PackageSelectionSheet with the featured package.
- Tests: new `src/components/coachless/__tests__/CoachlessEntitlement.test.tsx` (integrated: real EntitlementProvider + ProtectedScreen
  + slot + sheet; inactive -> redeem granted code -> Done -> Workout content, no AppState event). Verified it FAILS with the
  CoachCodeSheet fix reverted and passes with it. `CoachlessHomeSlot.test.tsx` +1 iOS test (ClientPackages, no plan sheet) and the
  Android story asserts no navigation (12/12).
- Local heavy.sh: CoachlessEntitlement 1/1, CoachlessHomeSlot 12/12, copyVoice.guard 8/8, quietLuxuryDoctrine 10/10,
  iosStorePackagePurchasePosture 10/10; eslint src/components/coachless 0 problems.

## Result
- growth-project-mobile#386 head **64c5bde0f20f3a39d76961e7eb9838dc515fa2d3**, MERGEABLE, 1,344 changed lines (478 test).
- PR CI green at the head: CI run 37409208185 (Typecheck, lint, full test suite), CodeQL 37409208559.
- FIX ROUND 2 comment, READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008806111
- PR body updated (iOS hand-off, entitlement refresh, tests, size). Notify file updated.
- Cs unchanged (C-386-SOL-1/C-386-a pending-consent recovery; C-386-SOL-2/C-386-b plan-sheet 24 h suppression, C (edge, deferred to
  10k clients)).
- Note: one slip at worktree creation: a relative path made git put the worktree inside the main clone (growth-project-mobile/wt/);
  removed at once (the main clone's checkout was not changed; `git status` clean) and recreated at /home/user/workspace/wt/M-COACHLESS-123-2.

## HANDOFF (20:36 PDT 10-05)
- Done: B-386-SOL-1 and B-386-OPUS-1 fixed at 64c5bde0, PR CI green, FIX ROUND 2 READY FOR AUDIT posted, notify updated.
- Next: Opus + Sol delta re-review of #386 at 64c5bde0 (the two Bs + changed lines). Nothing merged or deployed;
  FEATURE_COACHLESS_HOME stays off until merge, both lenses APPROVE and an owner device pass (and the owner saves the D1 pitch text).
- Cleanup: worktree wt/M-COACHLESS-123-2 removed (all work pushed); no ci/* or audit/* branches; no locks taken.
