# AUD-E2E-COACH-126 — coach first hour on the 10-07 build (auditor, read-only, no PRs)
Start 18:33 PDT 10-06 (TZ=America/Los_Angeles date). Hard stop 19:35. Backend main f71bb9a4 (RO checkout; origin/main now 054c7384, re-checked), mobile main 950689af (origin/main now 8e08197a, re-checked).
Flags as they will be: eas.json "clinic" (extends production) + backend .github/fly-env-desired-state.json on main.
Status: DONE (audit complete; no PRs by job entry)

## Scope traced
Method: mechanical route cross-check of every mobile `api.<verb>('/...')` call (incl. `${BASE}` constants) against every backend
controller route (845 routes, per-controller prefixes), then screen-by-screen trace of the coach's first hour.
- Sign up as coach: CreateAccountScreen role step -> /auth/signup-policy (SIGNUP_ROLE_CHOICE_ENABLED unset = on) -> RootNavigator
  GET /coach/onboarding -> CoachWizardNavigator steps 1-5 (/coach/onboarding/start|steps/:n|complete). OK.
- Consultation (coach read): ClientConsultationScreen -> GET /coach/clients/:clientId/consultation (tenancy in service, 404 on refusal). OK.
- Stripe Connect: GetPaidPanel / CoachConnectScreen -> /coach/connect/status|status/refresh|onboarding-link, /v1/connect/accounts/dashboard-link. Routes exist. (Deep money audit already done by AUD-MJ-PAYOUT-126.)
- First package one-off + recurring: wizard step 3 FirstPackageForm + CoachPackageEditScreen -> /v1/coach/packages (toBackendCreate fields == CreatePackageDto whitelist). OK.
- Appointment types / weekly hours: CoachAppointmentTypesScreen -> POST /scheduling/session-types (CreateSessionTypeInput == CreateSessionTypeDto); CoachAvailabilityEditor -> POST /scheduling/coaches/:id/availability. OK.
- Invite (code, link, email, bulk): /coaches/me/invite-link (lazy-create), /coach/codes (FEATURE_COACH_CODE_TOOLS on), /coach/invite-codes/bulk|bulk/parse|:id/send. Routes exist; email send wired (_sendInviteEmail).
- Booking accept: /scheduling/sessions/:id/approve|decline. Route exists.
- Message client: ClientMessagesScreen -> /coach/clients/:client_id/messages. Route exists; send failure shows specific copy.
- Program build/assign: Programs tab (EXPO_PUBLIC_FF_MWB_PROGRAMS on) -> /v1/coach/programs/* incl. /:id/assign. Routes exist.
- Ask AI paused state: m#439 @ 030e5721 (open) + b#808 merged: FEATURE_MWB_AI_LIVE_CREATE unset -> status state 'paused' -> PAUSED_COPY.
- AI draft approve: CoachAiSection / PendingAiDrafts / AIWorkoutDraft / AIMealPlanDraft -> /coach/ai/* (RequiresTier pro; see B3: BILLING_ENFORCEMENT=enforce was pushed to Fly on 2026-04-30); approve workout = assign to calendar; approve meal = per-client MealPlan. Consent refusal handled (aiRefusalOf).
- Meal plan: ClientDetail MealPlanTab/PlanFormModal -> /coach/clients/:client_id/meal-plans (client reads GET /meal-plans). Settings > Meal Templates -> /coach/meal-templates.
- Risk board / Overview: RiskBoardScreen -> /coach/clients/risk-board; Overview -> /coach/command-center/overview. Routes exist.
- Earnings/payouts: MoneyScreen -> /v1/coach/money/*, /coach/connect/payouts|metrics. Routes exist.
- Support inbox: SupportInboxScreen (Crisp; unavailable -> email fallback with specific copy). OK.

## B list
- B1 (false customer-facing claim, linked from the app) The coach help centre describes a web "coach console" that does not exist
  and a paid subscription that production does not require. User story: a new coach taps Settings > Help centre > Setup and is told to
  "Sign in to the coach console at https://console.thegrowthproject.app" (the host does not resolve: curl exit 6, no DNS), to "start
  your subscription" because "The subscription has to be active before you can send messages or invite clients", and (First client)
  that the invite link "shows your photo, your bio", so they stall at step 1 or pay for something the app never asks for.
  Evidence: live https://app.trygrowthproject.com/help/setup, /help/first-client, /help/tour and /help/faq (HTTP 200, fetched 18:45)
  contain those lines; the app opens /help from src/screens/coach/SettingsScreen.tsx:289-300 (helpUrl()). Facts: coach tools are
  mobile-only (help-pages.html.ts:468 says so itself); SubscriptionGuard passes free-tier coaches on every free route even in
  enforce mode, because sign-up writes CoachSubscription tier 'free' status 'active' (auth.service.ts:318-322; subscription.guard.ts
  free branch); the invite landing renders only coach name +
  business name (invite-landing.service.ts:43-55, no photo or bio); the role is self-serve at sign-up (SIGNUP_ROLE_CHOICE_ENABLED unset
  = on), so "Reply to the welcome email so we can promote it" is also wrong.
  File: backend src/public-pages/help-pages.html.ts:53 (COACH_CONSOLE_URL), :179-235 (setup steps 1-6 + done list), :240-300 (first
  client), :304-350 (tour), FAQ billing answers (~:425-445, "message sends are blocked" after the grace window).
  Smallest fix (T1 copy, backend, needs a deploy): rewrite Setup as the in-app path (sign up as coach -> 5-step setup -> Get paid with
  Stripe from Overview -> first package -> Clients > Invite codes / share link), delete the subscription step and the "Billing reads
  Active" checks, drop the photo/bio claim, and point the Tour at the app tabs (Overview, Clients, Programs, Messages, Settings) or
  remove the Tour page from the nav. Not covered by any open PR (b#787 from AUDIT-19-125 fixed only the support page).
  (Messaging and invites are free-tier routes, so the "subscription has to be active" claim is false in either enforcement mode.)

- B2 (broken links in every nightly email, from tonight) The daily digest emails send dead links. User story: a coach who signed up
  today gets the 23:00 PDT "coach daily" email (cron 0 6 * * * UTC, every role=coach user, even with zero clients), taps "Open coach
  console" or "Unsubscribe", and lands on https://console.thegrowthproject.app (host does not resolve); each client gets the 00:00 PDT
  email whose "Open the app" and "Unsubscribe" go to https://app.thegrowthproject.app (host does not resolve).
  Evidence: digest.service.ts:47-49 defaults (APP_URL / CONSOLE_URL, neither in the Fly manifest; prod-switches.yml lists APP_URL as
  STUB_ALLOWED), :143-144 and :209-210 build unsubscribeUrl = <base>/settings/notifications; templates/digest-coach.hbs:146,151 and
  digest-client.hbs:137,142; _activeCoachesWithEmailDigest (digest.service.ts:392-406) has no activity filter. Even with APP_URL set to
  the real host, https://app.trygrowthproject.com/settings/notifications answers 404 (checked 18:48), and the app has no digest-email
  switch (only Mute all), so the footer "Unsubscribe or manage preferences in the app" is half false. Operator note says digests start
  sending after the Resend fix (check NotificationDigestLog after 06:00Z), so tonight is the first real send.
  Not confirmed: whether APP_URL / CONSOLE_URL are set on Fly outside the manifest (a Fly secrets digest by name answers it).
  Smallest fix: (a) operator, tonight, no code: add EMAIL_DIGEST_COACH_ENABLED=off and EMAIL_DIGEST_CLIENT_ENABLED=off to the
  manifest and env-sync (production flag change = operator/owner call); (b) code (backend T2): CTA -> PUBLIC_APP_BASE_URL universal
  link or /download/ios|android, "Open coach console" -> "Open the app", and a real one-tap unsubscribe route (signed token ->
  notification_prefs.digest_email=false) before turning digests back on.
  Same root cause, same fix: nudge emails build app_url and preferences_url from APP_URL with the same dead default
  (notifications/nudges/nudge-engine.service.ts:444-451).

- B3 (core flow, likely; one operator check) Coach AI and AI-draft approval refuse every coach except the owner. User story: a coach
  who signed up today opens a client, sees the Coach AI card read "Offline / AI offline — owner action required", and Pending AI drafts
  and "Approve & assign" fail, because every /coach/ai/* route is @RequiresTier('pro') (ai/coach/coach-ai.controller.ts:42-43;
  ai/coach/coach-ai-execution.controller.ts:155), sign-up gives every coach tier 'free' (auth.service.ts:318-322, :1683-1692), and with
  BILLING_ENFORCEMENT=enforce the guard throws 403 TIER_UPGRADE_REQUIRED (subscription.guard.ts:110, :156-168, :252); there is no
  way to buy pro (U6; auth.service.ts:1676 TODO(pro-upgrade)). The owner role bypasses the guard (subscription.guard.ts:101), so owner
  testing does not show it. Mobile maps the 403 to "Offline" (CoachAiSection.tsx:114-121 on main 8e08197a).
  Evidence the flag is on: Actions run 25177310698 of fly-secrets-set.yml (2026-04-30T16:34Z, success, head 50fd2dcf, app default
  backend-spring-lake-3890 = fly.toml app) ran `flyctl secrets set ... BILLING_ENFORCEMENT=enforce` (workflow line 129 at that sha).
  BILLING_ENFORCEMENT is not in .github/fly-env-desired-state.json, so fly-env-sync never unset it. Not confirmed: that nobody unset it
  by hand since (a Fly log line "[SubscriptionGuard] [enforce] coach=" or `fly secrets list` digest answers it, names only).
  Not touched by the Ask AI builder: /ai/gateway/workout-builder/* has no SubscriptionGuard. Other pro routes: /workout-programs/*
  (fork/clone/fan-out), not called by mobile main.
  Smallest fix: (a) operator/owner, no code: declare BILLING_ENFORCEMENT "unset" in the manifest flags (observe mode; may need a
  closed values set at env-validation.ts:338) and run env-sync,
  matching docs/deploy-runbook.md:416 ("stays unset / observe-only during the rollout"); (b) code alternative (backend, T3 because it is
  an entitlement change): @RequiresTier('free') on the two coach-AI controllers until a pro purchase path ships.

## U list
- U1 Settings > Meal Templates is a dead end. A coach taps Settings > Meal Templates, reads "Reusable building blocks for the daily
  meal plans you assign to clients", creates a template, and then finds no screen anywhere that uses it (PlanFormModal has no
  template picker; mealTemplatesApi.createPlan/assignPlan and useCreateDailyMealPlan have zero UI callers), so the work is wasted.
  File: src/screens/coach/SettingsScreen.tsx:527-539 (row), src/screens/coach/CoachMealTemplatesScreen.tsx:72-75 (copy).
  Smallest fix: hide the Settings row for 10-07 (meal plans are built per client in Client > Meal plan), or change the header copy to
  "Saved meals with macros. Using them inside a client's meal plan is coming soon." Hide is the recommended default.
- U2 Raw technical error text on coach first-hour saves. When a save fails the coach sees Axios text like "Request failed with status
  code 400" because the alert body is `err instanceof Error ? err.message : 'Unknown error'`:
  src/screens/coach/CoachWorkoutBuilderScreen.tsx:1249-1252 (save a workout plan), src/screens/coach/CoachMealTemplatesScreen.tsx:138-141
  (save a meal template). (The CoachBulkInviteScreen.tsx:72-75/:98-101 instances are fixed by m#440, merged 01:30Z; still present at
  mobile main 8e08197a: builder :1251, meal templates :140.) Overlap: m#443 (AIB-6, open) also edits CoachWorkoutBuilderScreen.tsx.
  Smallest fix: use the existing `errorMessage(err, '<specific fallback>')` helper from src/types/common (already used by
  ClientMessagesScreen.tsx:261) with fallbacks "The plan was not saved. Check the connection and save again." etc.
- U3 (COVERED by m#440, merged 01:30Z: the legacy row is removed on mobile main 8e08197a) Three overlapping invite entries in Settings. Settings shows "Bulk invite clients" (BulkInviteScreen), "Invites & email"
  (CoachInvitesScreen) and, under Coach Tools, "Invite Codes (bulk)" (legacy CoachBulkInviteScreen, labelled "legacy" in its own
  accessibility label), so a coach inviting their first clients picks between two different bulk-invite screens.
  File: src/screens/coach/SettingsScreen.tsx:620-634. Smallest fix: delete the legacy "Invite Codes (bulk)" row.
- U4 Coach AI offline copy is operator text. If the boot probe fails, ClientDetail > Coach AI shows "AI offline — owner action
  required" and a failed generate shows "AI is offline — owner action required (set ANTHROPIC_API_KEY)." to the coach.
  File: src/components/coach/CoachAiSection.tsx:357-359, :240, :301. Smallest fix: "Coach AI is not available right now. Programs and
  meal plans can still be built by hand." Low frequency (ANTHROPIC_API_KEY is present on Fly). Overlap: m#443 (open) edits
  CoachAiSection.tsx (third instance at :330 on main 8e08197a).

- U5 Coach bio silently not saved. A coach opens Settings > Bio, writes a bio, taps Save, feels the success tap and sees the bio, but
  PUT /profile answers 409 consultation_incomplete for any coach without height, weight, date of birth and sex (profile.service.ts:76-84,
  writeProfileWithTargets 'require_complete', macro-calculator.ts:142-162) and the app swallows it (SettingsScreen.tsx:205-216,
  console.warn only, bio kept in AsyncStorage on that phone). Even when it saves, it writes UserProfile.bio, while every client-facing
  surface reads CoachProfile.bio (coach-code-lookup.service.ts:127-136, landing-pages.html.ts:998, v1-coach.service.ts:101), which
  has no coach write path. Smallest fix for 10-07: mobile shows the failure ("The bio was not saved.") instead of the success tap, or
  hide the Bio row; real fix (post-launch, backend): write coach bio to CoachProfile.bio (e.g. PUT /coach/team accepts bio).

- U6 "Start subscription" is a dead button on Android. A new coach opens Settings > Billing & access, reads "No subscription. You do not
  have an active coach subscription yet.", taps Start subscription and gets "Billing portal unavailable: No Stripe customer is
  provisioned for this coach yet. An OWNER must call start-subscription first." (operator text; no self-serve start exists).
  Files: mobile src/screens/coach/CoachBillingScreen.tsx:295-325 (button shown for state none; iOS hides it via purchasesHidden),
  backend src/billing/billing.service.ts:1667-1672 (message). Ties to B1 (help page tells coaches to start a subscription).
  Smallest fix (mobile T1): when state is 'none', hide the button and show "TGP is free for coaches at launch. Clients pay through your
  packages." (owner to confirm the wording; default: hide the button, keep the status card).

## C one-liners
- ClientRiskDetailScreen calls /admin/ptm/clients/:id (no such route; owner-only /admin/clients/:id/ptm) but no screen navigates to it: dead code, C.
- Coach community screens (/community/coach/dashboard|inbox|cohorts) call routes that do not exist, but EXPO_PUBLIC_FF_COACH_COMMUNITY is not set in eas.json, so the tab is absent: C.
- invites.singleInvite -> POST /coach/invite-codes/single has no route, but has no UI caller: C.
- SubscriptionGuard refuses role sub_coach on meal templates and /coach/ai (C, sub-coach scope already an open owner decision B4).
- coach-onboarding-welcome email template says "Open the coach console" but has no sender in code (never sent): C.
- OverviewScreen error state replaces the whole screen, hiding the setup checklist header, only when /coach/command-center/overview fails: C.

## Covered by open PRs
- Ask AI in the workout builder: m#439 (AIB-5) + b#809/b#815 (generator, subset approve).
- U3 and the CoachBulkInviteScreen part of U2: m#440 (FU-COPY-126, merged 01:30Z).
- B2 is NOT covered by b#819 (B-EMAILFROM-126, open): b#819 edits digest.service.ts _send (sender only), not the APP_URL /
  CONSOLE_URL links; a B2 code fix overlaps that file. B1 is not covered (no open PR touches help-pages.html.ts).
- Re-verified at current heads: backend origin/main 054c7384 has no change to help-pages.html.ts, digest.service.ts, templates,
  billing.service.ts, profile.service.ts, nudge-engine.service.ts since f71bb9a4; mobile main 8e08197a still has U1, U2 (builder,
  meal templates), U4, U5, U6.

## PRs opened
none (auditor, no PRs by job entry)

## Not fixed (needs operator)
Every item below is unfixed (auditor lane, no PRs). Routing: B1 backend T1 copy builder; B2 operator flag call tonight + backend T2
builder; B3 operator/owner flag call (manifest) or backend T3; U1/U2/U4/U5/U6 one small mobile T1 PR (all in coach Settings/Billing/AI/builder/meal-templates files), against mobile main
8e08197a, overlap m#443 on CoachAiSection.tsx and CoachWorkoutBuilderScreen.tsx.
- B1 backend src/public-pages/help-pages.html.ts:53, :179-235, :240-300, :304-350, FAQ billing (~:425-445) -> rewrite to the in-app
  coach path; drop console URL, subscription step, "Billing reads Active", photo/bio claim.
- B2 backend src/notifications/digest.service.ts:47-49, :143-144, :209-210; templates/digest-coach.hbs:146,151; digest-client.hbs:137,142;
  nudges/nudge-engine.service.ts:444-451 -> tonight: EMAIL_DIGEST_COACH_ENABLED=off + EMAIL_DIGEST_CLIENT_ENABLED=off (operator);
  then CTA to the real app host and a working unsubscribe route before re-enabling.
- U1 mobile SettingsScreen.tsx:527-539 hide Meal Templates row (or change CoachMealTemplatesScreen.tsx:76 copy).
- U2 mobile CoachWorkoutBuilderScreen.tsx:1249-1252, CoachMealTemplatesScreen.tsx:138-141 -> errorMessage(err, specific fallback).
- U4 mobile CoachAiSection.tsx:240, :301, :330, :357-359 -> customer copy, no "owner action" / env names.
- U5 mobile SettingsScreen.tsx:205-216 -> surface the failed save (no success tap on failure) or hide Bio; backend follow-up to write
  CoachProfile.bio.
- U6 mobile CoachBillingScreen.tsx:295-325 -> hide "Start subscription" for state 'none'.
- B3 .github/fly-env-desired-state.json flags: BILLING_ENFORCEMENT "unset" (observe mode), env-sync; or
  @RequiresTier('free') at ai/coach/coach-ai.controller.ts:42 and ai/coach/coach-ai-execution.controller.ts:155.
- Operator checks (names only, no values): confirm BILLING_ENFORCEMENT is still on Fly (B3); are APP_URL / CONSOLE_URL /
  STRIPE_BILLING_PORTAL_RETURN_URL set on Fly? (B2; billing.service.ts:1675-1677 defaults the portal return to the dead console host.)

## Owner/operator decisions
- D1 Ask AI "paused for maintenance" copy on 10-07: with FEATURE_MWB_AI_LIVE_CREATE unset the builder shows "Ask AI is paused for
  maintenance. Your workouts are unchanged." (m#439 aiBuilderCopy.ts PAUSED_COPY). The owner asked for it live and ON. Default: flip
  per the AIB plan after b#809 + b#815 merge together; if the flip slips past the build, keep the copy (it is true enough and calm).
- D2 (B2) Turn the nightly digests off until links work? Default: yes, EMAIL_DIGEST_COACH_ENABLED=off and
  EMAIL_DIGEST_CLIENT_ENABLED=off before 23:00 PDT tonight (first coach send), back on after the link fix ships.
- D3 (B3) Coach AI for free-tier coaches at launch? Default: BILLING_ENFORCEMENT unset (observe mode, per docs/deploy-runbook.md:416)
  until a pro purchase path exists; nothing a coach can buy today is pro.
- D4 (U6) Copy for coaches with no subscription. Default: hide "Start subscription"; keep the status card.

## HANDOFF
Audit finished 18:59 PDT 10-06. Nothing in flight: no worktrees, no branches, no ci/* lanes, no locks, no PR comments.
Counts: B=3, U=6 (U3 already covered by m#440, so 5 open), C=6 one-liners. Needs operator: 8 (B1, B2, B3, U1, U2, U4, U5, U6).
Next agent: route B2 (a) to the operator before 23:00 PDT 10-06 (first coach digest send); B3 to the operator to confirm the Fly
value (names/log only) and take D3; B1 to a backend copy builder; the mobile U bundle to one FU builder. Evidence commands used: curl to app.trygrowthproject.com/help/{setup,first-client,tour,faq}
(200) and /settings/notifications (404); getent hosts for console.thegrowthproject.app / app.thegrowthproject.app (no DNS).
Route cross-check scripts: /tmp/routes126.py, /tmp/mob126.py (may be gone; logic described under Scope traced).
