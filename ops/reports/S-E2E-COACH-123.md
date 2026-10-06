# S-E2E-COACH-123 — coach journey trace (scout, Claude Opus 5.5, READ-ONLY, agent 123)

Started 21:30 PDT 10-05, report written 21:45-21:46 PDT (time box 45 min, ends 22:15). Nothing pushed, no PRs, no comments,
no workflow runs, no worktrees made. Scope per W3-16: core-flow dead ends and money errors only (FREEZE + RUTHLESS SCOPE).

Evidence: backend main 5230306c (/home/user/workspace/wt/RO-backend), mobile main a727eb49 (/home/user/workspace/wt/RO-mobile),
env names from ops/aud-123/FLAGS-D1-123 (fly-secrets-list 10-01 run 36885057965, env-truth 10-03; names and presence only, no values),
and five public unauthenticated GETs against production (no account, no data): `/.well-known/apple-app-site-association` 200,
`/.well-known/assetlinks.json` 200, `/join/TESTCODE` 404 "Invite unavailable" page (correct for a bad code),
`/api/v1/connect/onboarding/return` and `/refresh` 302 to `tgp://connect/onboarding/return|refresh`, `/health` and `/readyz` 200.

## Result
A 0 / B 0 definite / B-conditional 1 (needs one owner check; smallest fix given) / C 6. No dead end and no money error found in
code on the main path. Every mobile call on the journey has a matching backend route on 5230306c (checked one by one, list below).

## Journey trace (step -> screens -> backend -> verdict)
1. Coach sign-up. CreateAccountScreen role choice -> POST /auth/register `intended_role: 'coach'` -> auth.service.ts:260-285 creates
   User(role coach) + CoachSubscription {tier free, status active} + CoachProfile with a GP- code in one transaction. So
   assertCoachCanAcceptClients (invite-codes.service.ts:276) passes for a brand-new coach. Packages and invite-code routes use
   SubscriptionGuard without @RequiresTier, so a free coach is not blocked. OK.
2. Coach wizard (CoachWizardNavigator.tsx, 5 screens). Stripe, first package and invite are each skippable ("Continue without payouts
   for now", "Skip for now"), and the Overview tab header (CoachHomeCards -> CoachSetupChecklist) brings them back. OK.
3. Stripe Connect onboarding. Two entry points:
   - Wizard / Home checklist / CoachSetup: GetPaidPanel.tsx:147-182 -> POST /coach/connect/onboarding-link (creates the Express
     account if missing, card_payments + transfers requested, stripe-connect-api.service.ts:308-311) -> openAuthSessionAsync with
     `tgp://connect/onboarding` -> production return page 302s to that scheme (verified) -> POST /coach/connect/status/refresh re-reads
     the account from Stripe and writes the mirror. OK.
   - Settings > "Payouts (Stripe Connect)": CoachConnectScreen.tsx:121-166 -> POST /v1/connect/accounts/create + /onboarding-link ->
     openBrowserAsync -> on close GET /v1/connect/accounts/me, which reads ONLY the database mirror (connect.service.ts getStatusForCoach).
     The mirror changes only on the account.updated webhook (billing.service.ts:542 -> syncFromStripe) or the refresh route. See
     B-COND-1.
   - Env: STRIPE_CONNECT_RETURN_URL / STRIPE_CONNECT_REFRESH_URL present on Fly (names only); the HTTPS landing pages work.
4. Create a package with fees. CoachPackageEditScreen / FirstPackageForm -> /v1/coach/packages (create, publish). Floor $19.99 is a
   clear refusal with copy, never a silent price change (packages.service.ts:171-175, 901-1017). Copy "You keep the price minus Stripe
   processing and the TGP 2% fee" (FirstPackageForm.tsx:445) matches fee-policy.service.ts:21 (200 bps) and the S-FEE settlement
   (price - actual Stripe fee - 2%, checkout.service.ts:355-363). OK.
5. Share a code. FEATURE_COACH_CODE_TOOLS is OFF in production, so the Codes route renders the legacy InviteCodesScreen
   (CoachCodesEntry.tsx: 404 -> legacy). Legacy routes /coach/invite-codes* and /coaches/me/invite-link exist
   (invite-codes.controller.ts:35-148). Link = https://app.trygrowthproject.com/join/<code>; AASA + assetlinks serve and list /join/*.
   With the flag ON, /coach/codes GET/POST/rotate/revoke/signups all exist and write the same InviteCode table the redeem path reads. OK.
6. Client joins. /invite/:code/preview + register with code or /auth/attach-coach-code -> client.coach_id set. Paid purchase:
   one-time -> /v1/checkout/payment-intent, renewing -> /v1/checkout/subscription-intent (usePackagePurchase.ts), $0 -> claim-free.
   Both paid paths refuse with COACH_NOT_PAYOUT_READY while the mirror says charges are off (checkout.service.ts:604,
   subscription-checkout.service.ts:272); mobile has copy for it (packagePayment.ts:869-874). Renewals: invoice.paid ->
   checkout-webhook-handler -> PurchaseSplitHandler.onChargeSucceeded per renewal + settlement sweep cron backstop; entitlement
   fan-out on purchase (onPurchaseEntitled). OK.
7. Program builder. Programs tab (EXPO_PUBLIC_FF_MWB_PROGRAMS=true) -> /v1/coach/programs (ProgramLibraryFeatureGuard needs
   FEATURE_MWB_TEMPLATES, ON). Every mobile call in programsApi.ts matches program-library.controller.ts routes (list, saved-workouts,
   create, get, patch, days put/delete, duplicate, archive, restore, revisions, assignees, assign, unassign). The Pro-tier-gated
   /workout-programs/* controller (workout-builder.controller.ts:259-261) is NOT called by the app, so the free-tier gate there does not
   bite. OK.
8. Booking options + reminders. Settings rows -> ClientsStack CoachBookingOptions / CoachAvailabilityEditor / CoachAppointmentTypes /
   CoachTimeOff / CoachBookingInbox (all registered). Every /scheduling/* path the app calls exists in scheduling.controller.ts. No money on
   bookings (no price fields). BOOKING_REMINDERS_ENABLED=on. OK (push delivery is W3-17).
9. Broadcasts. FEATURE_COACH_BROADCASTS OFF -> BroadcastsEntry hidden in both inboxes (MessagesScreen.tsx:127, CoachInboxV2.tsx:317).
   With the flag ON, list/preview/segment-options/create/pause/resume/cancel routes exist (broadcasts.controller.ts:56-111) and the
   CoachBroadcasts / CoachBroadcastComposer routes are registered (CoachNavigator.tsx:431-440). OK.
10. Inbox v2. messaging_core_v2 ON -> CoachInboxV2 on /coach/messages/inbox and /coach/clients/:id/messages/*. OK.
11. Roman adjustment approve. Overview tab -> Command Center "Action queue" tab -> RomanAdjustmentsSection -> /coach/adjustments
    list/approve/edit/dismiss/undo (roman-adjust.controller.ts). 404 = hidden. OK.
12. Earnings / tax CSV. Settings > Money (CoachMoney) -> /v1/coach/money/summary|charges|attention, export.csv (header starts
    `date_utc,`, which is what the mobile reader checks, coach-money.service.ts:820 vs coachMoneyApi.ts:868). OK.

## B-conditional (operator decision; becomes a B only if the owner check fails)
B-COND-1 Settings > Payouts never re-reads Stripe, so a coach who finishes onboarding there stays "not ready" unless Stripe's
account.updated webhook for connected accounts reaches the backend.
- Normal-user story: a new coach opens Settings > Payouts (Stripe Connect), completes Stripe, comes back and still sees charges and
  payouts off; a client then taps Buy and is told the coach has not finished Stripe onboarding, so no one can pay that coach.
- When it happens: only if the live Stripe account has no Connect webhook endpoint ("Events on Connected accounts") sending
  account.updated / capability.updated / account.application.deauthorized to POST /api/v1/webhooks/stripe, signed with
  STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_NEXT. These events about a connected account are sent to Connect endpoints, not to the
  platform's own account endpoint. docs/connect-setup.md section 6 says to add them to "the TGP endpoint" and does not mention a
  Connect endpoint, so the live setup may be missing it. No cron re-syncs accounts (syncFromStripe is called only from the webhook and
  POST /coach/connect/status/refresh).
- Recovery today: Home checklist > Get paid > "Check again" calls the refresh route and fixes the mirror, but nothing tells the coach
  to do that.
- Code: mobile src/screens/coach/payments/CoachConnectScreen.tsx:121-166 (handleStartOnboarding calls load() at :150, which is
  GET /v1/connect/accounts/me = mirror) and :115-119 (onRefresh, also mirror); backend src/connect/connect.controller.ts:97-105 (me()).
- Smallest fix (recommended default, backend only, about 10 lines, ships without a new app build): in ConnectController.me(), when the
  row exists and `charges_enabled` or `payouts_enabled` is false and it is not deauthorized, call
  `this.connect.syncFromStripe(row.stripe_account_id)` inside try/catch and return the synced row (syncFromStripe already returns the
  unchanged mirror when Stripe refuses). One spec: a mirror with charges off and a Stripe stub with charges on returns charges on.
  Alternative mobile fix (needs the 10-07 build): CoachConnectScreen calls POST /coach/connect/status/refresh before load() after the
  sheet closes and on pull-to-refresh.
- Owner check (O-1): Stripe Dashboard (live) > Developers > Webhooks: is there a "Connected accounts" endpoint to
  /api/v1/webhooks/stripe with those three events, and is its signing secret the one in STRIPE_WEBHOOK_SECRET or
  STRIPE_WEBHOOK_SECRET_NEXT? If yes, B-COND-1 is a C.

## C (follow-ups, no fix needed for launch)
- C-1 CoachConnectScreen copy is generic in three places ("Please try again.", "Payouts are temporarily unavailable. Please try again
  later.", "Unable to open Stripe") — product copy rule; CoachConnectScreen.tsx:68, 103, 137, 160, 177, 195.
- C-2 POST /v1/checkout/sessions (hosted Checkout) sells a one-time + recurring combo package as mode 'payment' only (it checks
  `billing_type === 'recurring'`, not isRecurringPackage), so the recurring part would never bill — checkout.service.ts:353-354. The app
  never calls this route (no caller of createCheckoutSession in mobile src), so no normal user reaches it. Smallest guard: refuse
  isRecurringPackage(pkg) there like createPaymentIntentForClient does at :545.
- C-3 Dead mobile code: invites.ts:215-224 `singleInvite` posts to /coach/invite-codes/single, which does not exist on the backend.
  No caller.
- C-4 Settings > Payouts opens Stripe with openBrowserAsync, so the return page's tgp:// redirect shows an "Open in app" hop instead of
  closing the sheet the way the wizard's openAuthSessionAsync does. Cosmetic.
- C-5 Money export has no "last calendar year" range (today / ... / ytd). Launch-day coaches have no prior-year sales.
- C-6 APP_STORE_URL / PLAY_STORE_URL are set (names only); the invite landing's store buttons use them. Owner should confirm they
  point at the public listings once the 10-07 build is live (W3-18 device pass can include tapping them).

## Owner checks (decisions, each with a default)
1. O-1 above (Stripe live Connect webhook endpoint). Default: ship the 10-line backend fix anyway; it removes the dependency.
2. In the 10-07 device pass (W3-18): as a fresh coach, open Settings > Payouts once. If it shows "Set up Stripe to get paid" with only
   Try again, live Connect is not ready on the server (ConnectModule probe failed at boot). Default: add the step to the pass.
3. The 10-07 build's EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY must be the live key that pairs with the live STRIPE_SECRET_KEY (W3-03 owns
   build config). Default: W3-03 confirms by name and mode prefix only.

## HANDOFF
State: DONE, report only. No PRs, comments, pushes, worktrees, locks or claims. Nothing to clean up.
If continuing: (1) the operator decides B-COND-1 (default: backend builder adds the sync in ConnectController.me() with one spec,
under 40 lines, Conventional Commit `fix(connect): re-read Stripe when the payout status is not ready`); (2) owner answers O-1;
(3) C-2 can ride along with any checkout PR (one-line guard). Everything else on the coach journey traced OK on backend 5230306c and
mobile a727eb49.
