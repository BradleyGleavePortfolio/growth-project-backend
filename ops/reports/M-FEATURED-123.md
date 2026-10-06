# M-FEATURED-123 — W3-06 owner Featured coach editor (agent 123, Claude Opus 5.5, builder)

Start 21:30 PDT 10-05 (TZ=America/Los_Angeles date). Time box 60 min.

## Result
- Mobile: growth-project-mobile#391 @ 914b3ed37b98f0755f19069e6b80c488036af23a — "feat(coach): owner Featured coach editor in Settings". 898 changed lines (tests included; under the 900 entry budget and the 1,500 rule).
- Backend: growth-project-backend#749 @ ef3bdb4abe994ed46b5416a14249a7fbe71736ff — "feat(coachless): owner coach list for the featured coach editor". 109 lines. PR CI all green. FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/749#issuecomment-6009823835
- B count found: 0 in code I touched. One owner-facing fact (below) changes how the owner sets himself up.

## Why a backend PR too (operator: please confirm)
The entry is a mobile job, but no route an owner app session can reach lists coach accounts or another coach's packages:
`/admin/coaches` (AdminController) and `/v1/admin/payments/coaches/:id/connect` are behind ServiceTokenGuard as well as JWT (console only).
Without a list the owner would have to type a coach account UUID: a dead end. b#749 adds one read-only owner route
`GET /admin/featured-coach/coaches` -> `{ coaches: [{ id, name, email, business_name, packages: [active packages] }] }`,
same guards as GET/PUT /admin/featured-coach, packages filtered exactly like the PUT check (`activePackageOf`).
If the operator prefers not to land it, the mobile editor still works for an already-configured coach (404 fallback).

## Roles fact the owner needs (plain words)
The server accepts only an account whose role is `coach` as the featured coach (featured-coach.service.ts update():
`coach.role !== 'coach'` -> featured_coach_invalid; coachCard() and code attach also require role coach). The editor is owner-role only.
So one account cannot be both. Bradley needs his owner account (to edit) and a coach account (to be featured, own GP-BRADLEY and the
$49/mo package). The editor preselects the coach account whose name equals the owner's name. If production has only his owner
account today, he signs up a coach account first (C04), creates the $49/mo package there, then opens Settings > Owner > Featured coach
on the owner account. Decision for operator/owner (default in brackets): allow the owner-role account itself to be the featured coach
[no: keep two accounts; the attach writer, seats and payouts all assume role coach, a T4 change not worth it before launch].

## What the editor does (m#391)
- Settings > Owner > Featured coach, only when `currentUser.role === 'owner'` (coach and sub_coach never see it; tested).
- Coach picker (list from b#749; configured coach, else owner-name match, preselected); code (GP-BRADLEY suggested, uppercased,
  "Create the code if it is new" = create_code_if_missing default on); package picker from that coach's active packages or none;
  banner title 120 / offer 200 / Roman pitch 400 with counters; pitch prefilled
  "Sir/Ma'am, just so you're aware, TGP's top coach has available slots. Enter code <code> and join for <price>. Interested?"
  (price like "$49/mo"), following code/price until edited, with "Use the suggested pitch"; accepting + Roman switches; four caps with
  server defaults 24/3/14/2 and range checks before the request.
- Live preview reuses the client Banner and RomanCard (exported from CoachlessHomeSlot) and says why the Roman card is hidden.
- Errors: featured_code_other_coach / featured_code_unknown under Code, featured_coach_invalid under Coach, featured_package_invalid
  under Package; 401/403 owner-only; offline; 429; 400 rejected field; 5xx with request reference. After save: confirms a created code
  and warns when clients still cannot see the offer (resolved.accepting_clients false: coach subscription or code not valid).
- PUT body sends every field (the PUT replaces all; null clears).

## Tests (local, via heavy.sh, one file at a time)
- mobile src/screens/coach/featured/__tests__/FeaturedCoachEditorScreen.test.tsx 16/16; src/navigation/__tests__/coachSettingsMoneyRow.test.tsx 6/6
  (3 new). eslint clean on changed files.
- backend test/coachless/coachless-home.spec.ts 20/20 (1 new). eslint clean.

## CI state
- b#749: all checks green at ef3bdb4a (build-and-test, danger, R75, CodeQL, RLS/community/mwb lanes).
- m#391: all green at 914b3ed3 (Typecheck, lint, test run 37417580993; CodeQL). FIX ROUND 1 (OPENING) posted, READY FOR AUDIT:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/391#issuecomment-6009926320

## Cs
- C: the coach list is capped at 200 coach accounts (launch size). C (edge, deferred to 10k clients).
- C: after a save the form keeps the canonical code from the server; other fields stay as typed.

## FIX ROUND 1 on m#391 (22:36-22:4x PDT)
- Verdicts at 914b3ed3: Opus and Sol both REQUEST CHANGES, same B-391-1. Normal-user story: the owner signs in and lands back on sign-in, because
  RootNavigator bootstrapAuth only sent role coach and role student into the app (owner fell to "Token exists but no role yet").
- Operator rulings: keep b#749 = yes; featured coach stays coach-role only = yes.
- Fix (smaller option, no dead end): owner -> the coach app (`setAuthState('coach')`) with the coach onboarding wizard skipped.
  Why this one: the backend coach routes behind coach Home/Settings already accept role owner (RolesGuard owner total bypass,
  CoachGuard, CoachOrOwnerGuard, SubscriptionGuard `role === 'owner'` passes), and coach screens already branch on isOwner
  (CoachHomeScreen, RiskBoard). A separate owner stack would be a new navigator and more lines.
- New head 4f02a19e36383a64cb18b1e9ec467b638d9a5b87 (+31 lines; PR total 929 vs merge base, under 1,500).
- Tests: src/__tests__/rootNavigatorOnboardingField.test.tsx +1 through the real RootNavigator bootstrap (cached owner -> nav-coach,
  not nav-auth, /coach/onboarding never called; fails on the old head, passes now). src/navigation/__tests__/coachNavigation.test.ts +1
  (ClientsStack registers FeaturedCoachEditor with the editor component, where the owner Settings row navigates). Existing
  coachSettingsMoneyRow tests cover owner sees the row and it opens the editor.
- Cs left as Cs (not in this round): C-391-1 contradictory notes with list 404 + no config; C-391-2 create-if-new default on;
  Sol C: explicit "No package" reloads as the first package.

## HANDOFF
- Round 1 pushed at 4f02a19e, CI green, FIX ROUND 1 comment posted 22:46: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/391#issuecomment-6010193220 . Worktree removed.
- Next: re-review by both lenses at 4f02a19e (delta: RootNavigator owner branch + 2 tests). Merge b#749 then deploy; m#391 before the
  10-07 build.
- Owner setup after both land: coach account (role coach) with the $49/mo package exists -> sign in with the owner account (now opens
  the coach app) -> Settings > Owner > Featured coach -> pick the coach, keep GP-BRADLEY + "Create the code if it is new", pick the
  package, set offer text, switch on Accepting and Roman card -> Save.
- Never merge or deploy from this lane.
