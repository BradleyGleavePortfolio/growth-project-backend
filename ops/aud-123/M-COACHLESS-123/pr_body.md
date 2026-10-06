## Tier header
- **Tier:** T4 (attaches a client to a coach and hands off to paid checkout; money-adjacent, access). Lenses: Opus + Sol.
- **Job:** M-COACHLESS-123 (agent 123). Backend: growth-project-backend#721, #722, #723, #734 (src/coachless on main, deployed in deploy 5).
- **Size:** 1,344 changed lines (478 test), under the 1,500 cap. No lockfile change.

## What a coachless client sees (server flag `coachless_home`, FEATURE_COACHLESS_HOME)
Story: a person signs up without a code, opens Home, sees the banner, enters the featured code, is attached to the coach and lands
on the Day 1 plan sheet with the featured package already selected.

- **Banner** at the top of client Home (`CoachlessHomeSlot`, after the dunning banner). Title, offer line and code come from
  GET /coachless/home (the owner's FeaturedCoachConfig); nothing about the offer is hard-coded. The offer line, the featured coach
  card (name, business, package name and price) and **Use code <code>** show only while the server returns the offer (the featured
  coach accepts clients). **Enter a coach code** / **Enter a different code** always works while coachless.
- **Code sheet** (`CoachCodeSheet`): live validation once the text is a well-formed code (POST /coachless/coach-code/check,
  debounced 400 ms, latest answer wins) shows "Coach: <name>" or the specific refusal. **Join** posts
  /coachless/coach-code/redeem with an `Idempotency-Key` UUID: one key per code, reused on a retry of the same code (a lost answer
  replays the same result), a new key for a different code or after `idempotency_key_reused`.
- **Welcome moment** from the redeem answer: "<coach> is now your coach." (or "is already your coach." for a replay), then one
  next step:
  - the code granted an active plan (`grant.status` created / already_active): "Your plan with <coach> is active." -> Done
    (never asked to pay again);
  - `next.packages_available > 0`: "Next, start the plan: <featured package>, <price>." -> **Choose a plan** opens the existing Day 1
    `PackageSelectionSheet` with `initialPackageId = next.featured_package.id` (new optional prop; selected only when it is in the
    coach's list). Payment runs through the existing shared purchase flow, unchanged. On iOS (non-P2P purchases hidden) Choose a
    plan opens the labelled 1:1 coaching screen (More > ClientPackages) instead (fix round 2, B-386-OPUS-1);
  - the code's free plan waits for the onboarding agreement (`grant.status` pending_consent): "This code includes a plan with
    <coach>. It turns on once the onboarding agreement is accepted. ..." -> **Message <coach>** (never sent to pay);
  - no plans: "<coach> has no plan to buy in the app yet. Send a message to get started." -> **Message <coach>** (Messages).
  The local user cache gets `coach_id` so the rest of the app sees the coach; the shared entitlement gate is refreshed (fix round 2,
  B-386-SOL-1: a granted plan unlocks Workout without a restart); Home refetches and the banner goes away.
- **Scripted Roman card** (no AI call): the server's pitch text verbatim, shown only while GET /coachless/home returns
  `roman_card` AND the banner carries the featured code (coach accepting). One impression per displayed card
  (POST /coachless/roman-card/seen; `visible:false` hides it), **Enter the code** opens the sheet prefilled, **Not now** hides it
  and persists (POST /coachless/roman-card/not-now). Caps and snooze are the server's.
- **Refusal copy** for every code (coachlessCopy.ts): code_invalid, code_expired, code_revoked, code_exhausted,
  code_email_mismatch, coach_not_accepting, already_attached, role_cannot_redeem, account_not_found, idempotency_key_required,
  idempotency_key_reused, redemption_in_progress, redemption_failed (with the request reference), coachless_disabled, plus no
  connection, 429 and a 400 format error. Never the raw server text; no first person, no exclamation marks.

## Hidden when off
`coachless_home` false (flag off, coach/owner account), a cached `coach_id`, `eligible:false`, or 404 from /coachless/home: nothing
renders and no coachless request is sent beyond the Home read. No eas.json change; no owner admin screen (owner sets the offer
through PUT /admin/featured-coach).

## Files
- `src/api/coachlessApi.ts` (zod-parsed client for the five routes, failure mapping)
- `src/components/coachless/{CoachlessHomeSlot,CoachCodeSheet}.tsx`, `coachlessCopy.ts`
- `src/api/featureFlagsApi.ts`, `src/hooks/useFeatureFlags.ts`: `coachless_home` key
- `src/screens/client/HomeScreen.tsx`: one slot line
- `src/components/PackageSelectionSheet.tsx`: optional `initialPackageId`

## Tests (fail before this change: the modules and the prop do not exist)
- `src/components/coachless/__tests__/CoachlessEntitlement.test.tsx` (1, fix round 2): real EntitlementProvider + ProtectedScreen:
  inactive -> redeem a granted code -> Done -> protected content, no foreground event (fails at 0a1bc0bd).
- `src/components/coachless/__tests__/CoachlessHomeSlot.test.tsx` (12, incl. iOS Choose a plan -> ClientPackages): gate off / attached / not eligible / 404; the full story
  (banner -> Use code -> check -> Join with a UUID key -> welcome -> plan sheet with the featured package); same key on retry and a
  new key for a new code; specific refusal for check and join; active grant ends on Done; pending_consent grant never opens the plan sheet; no plans -> Messages; not accepting hides
  offer, featured coach and Roman card; Roman impression once, prefilled sheet, Not now persisted; copy for every code.
- `PackageSelectionSheet.subscription.test.tsx` (+2): `initialPackageId` selects the listed package; an unlisted id selects nothing.
- `useFeatureFlags.test.tsx` (+1 and the exact maps): `coachless_home` read from the server map, OFF by default.
- Local (heavy.sh, one file at a time): the three files above, HomeScreen.macroMode, copyVoice.guard, quietLuxuryDoctrine pass;
  eslint on the changed files: 0 errors. Full tsc and the full suite run in this PR's CI.

## Owner config note (not code)
Roman's pitch is the owner's config text. Owner words 10-01 13:41 with only the spelling fixed, to save through
PUT /admin/featured-coach `roman_pitch_text` (the code and price come from the same config):
"Sir/Ma'am, just so you're aware, TGP's top coach has available slots. Enter code <featured code> and join for <price>. Interested?"
