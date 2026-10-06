# S-IOSREV-123 — App Store review readiness (W3-01, launch step 7)

Scout: Claude Opus 5.5, agent 123. Read-only. Started 21:30 PDT 10-05, report written 21:45 PDT.
Code read: mobile main `a727eb495a0ce381a22c4ac40370c0c69f53a656` (RO checkout /home/user/workspace/wt/RO-mobile, still main at 21:43)
and backend `5230306c` (RO-backend) for the auth and terms pages. No PRs, no comments, no pushes, no production calls.

Result: **2 B, 0 A, 12 C.** (a) purchase surfaces PASS, (b) Sign in with Apple PASS, (c) account deletion PASS,
(d) purpose strings FAIL (B-1), (e) fresh reviewer: no crash on the main path, but B-1 crashes are reachable, and the
UGC terms gap (B-2) is a standard 1.2 rejection. Both Bs are mobile-only, small, and must merge before the 10-07 build
(B-1 is a native Info.plist change that an OTA update cannot deliver).

## B list

### B-1 — Missing camera and photo-library purpose strings (crash and ITMS-90683 upload block)
- Where: `app.json:26-31` (`expo.ios.infoPlist`) has Face ID, Health share/update and Motion only. There is no
  `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription` or `NSPhotoLibraryUsageDescription`, and no plugin adds them
  (no expo-image-picker / expo-camera / expo-media-library in package.json; the crisp-sdk-react-native plugin is not listed and
  only sets notification keys).
- Code that needs them:
  - `src/screens/share/ShareCardScreen.tsx:184` `Sharing.shareAsync(uri, …)` of a PNG. expo-sharing 56.0.18 presents
    `UIActivityViewController` (`node_modules/expo-sharing/ios/SharingModule.swift:21`), whose "Save Image" action writes to the
    photo library and needs `NSPhotoLibraryAddUsageDescription`; without it iOS ends the app. Reached from
    `src/screens/client/ProgressScreen.tsx:515-526` (share button shows at a 3+ day logging streak).
  - `src/screens/coach/CoachCodesScreen.tsx:421-426` same pattern for the invite QR image (when the code tools flag is on).
  - Crisp support chat (`src/services/support/crisp.service.ts:231` `show()`, reachable pre-sign-in and from More / Settings):
    the native Crisp iOS SDK (pod `Crisp ~> 2.13`) lets users take and send photos and save photos.
    [Crisp's iOS SDK docs](https://docs.crisp.chat/guides/chatbox-sdks/ios-sdk/) list `NSCameraUsageDescription` and
    `NSPhotoLibraryAddUsageDescription` as required Info.plist keys.
- Upload risk: App Store Connect runs a static scan and turns a build with camera/photo API references but no purpose string
  into an invalid binary (ITMS-90683; e.g. [PTKD on ITMS-90683](https://ptkd.com/journal/how-to-fix-itms-90683-missing-purpose-string-bluetooth)
  notes the build "never reached TestFlight"). The SoT records no iOS build on record as of 10-01 (TGP_SOURCE_OF_TRUTH.md
  line ~7470), so the 10-07 build is likely the first to meet this scan with Crisp linked.
- Normal-user story: a client with a three-day logging streak taps Share on Progress, picks "Save Image" in the iOS share
  sheet, and the app closes instantly (same for anyone who taps the camera in the support chat, a likely reviewer tap).
- Smallest fix (builder, ~4 lines, app.json only): add to `expo.ios.infoPlist`
  - `"NSCameraUsageDescription": "The Growth Project uses the camera only when you choose to take a photo to send in a support chat."`
  - `"NSPhotoLibraryAddUsageDescription": "The Growth Project saves an image to your photo library only when you choose Save Image, for example a progress card or an invite QR code."`
  - `"NSPhotoLibraryUsageDescription": "The Growth Project opens your photo library only when you choose a photo to send in a support chat."`
  Then `scripts/validate-app-config.js` / app-config tests still pass (no build number change). No code change.

### B-2 — No in-app agreement to terms for user-generated content (Guideline 1.2)
- Where: community is on in the production build (`eas.json` production env `EXPO_PUBLIC_FF_COMMUNITY_TAB/HALL/COHORTS=true`;
  backend community POSTS/MESSAGES on). The app has a content filter (server 422, `CommunityComposerScreen.tsx:71`), report and
  block (`SafetyMenu`), 24-hour review copy and contact (`CommunitySafetyScreen`), but no screen asks a user to agree to terms.
  `TERMS_URL` (`src/config/env.ts:72`) is defined and never used; no auth screen (`CreateAccountScreen.tsx` ~1386-1416,
  `LoginScreen.tsx`) mentions or links Terms; the Community tab only links to the guidelines (`CommunityTabScreen.tsx:89-100`).
  The production profile does not run the consultation onboarding (its waiver box is clinic-only and is not a UGC EULA).
  Backend Terms (`src/public-pages/trust-pages.html.ts:531`) cover harassing content but never say "no tolerance".
- Why B: Apple's 1.2 rejection asks the developer to "require that users agree to terms (EULA) and these terms must make it
  clear that there is no tolerance for objectionable content or abusive users" as one of the required precautions, alongside
  filter, report, block and contact. Everything else on that list exists; this item does not.
- Normal-user story: the reviewer signs in with the demo client, opens the Community tab, sees posts from other members, and
  rejects the build under 1.2 because no screen asks users to accept terms that forbid objectionable content and abusive users.
- Smallest fix (builder, mobile only, well under 200 lines with a test):
  1. One-time "Community guidelines" agreement sheet on first Community open (per-user MMKV key, like the package-prompt key):
     the existing `COMMUNITY_GUIDELINES` list plus "There is no tolerance for objectionable content or abusive users. Content
     that breaks these guidelines is removed and the account that posted it can be removed." Buttons: "Agree and continue"
     (writes the key) and "Read the Terms of Service" (opens `TERMS_URL`). Composer and reply actions stay behind it.
  2. One line on CreateAccount above the buttons: "By creating an account, you agree to the Terms of Service and the Privacy
     Policy." with both links (covers email, Apple and Google sign-up on that screen).
  3. Backend follow-up (C-4 below) adds the "no tolerance" sentence to /terms so the linked page says the same thing.

## (a) iOS purchase surfaces (gate `nonP2PPurchasesHidden()`, `src/config/purchaseSurfaces.ts:63`)
Gate: iOS only; hidden unless the bundle flag is explicitly false AND the native build is below 6 (fail closed). Production
and preview set `EXPO_PUBLIC_FF_IOS_HIDE_NON_P2P_PURCHASES=true`; clinic inherits it and the release default is hidden anyway.

| Surface | Sells | iOS state |
|---|---|---|
| ClientPackagesScreen (More > Membership > View coaching plans) | 1:1 coach plan | SHOWN, header `oneToOneCoachingLabel()` = "1:1 coaching with <coach>" + "Each plan is personal coaching delivered one to one by your coach." (`ClientPackagesScreen.tsx:262-266`) — allowed |
| PackageCheckoutScreen (share link `tgp://p/:token`, `/p/:token`) | 1:1 coach plan | SHOWN, labelled 1:1 (`PackageCheckoutScreen.tsx:193`) — allowed |
| UpdateCardScreen / dunning banner / lockout | card update for an existing 1:1 plan | SHOWN — part of the 1:1 payment, allowed |
| PackageSelectionSheet "Choose your plan" (Day1Win, 24h package_prompt) | 1:1 plan, unlabelled | HIDDEN (`lib/packagePromptGate.ts:28`) |
| CoachlessHomeSlot "choose plan" (server flag off) | 1:1 plan | iOS routes to labelled ClientPackages (`CoachlessHomeSlot.tsx:129`) |
| ProtectedScreen / PaywallSheet (Workout, Log, Plan, Calendar, Meal plan, AI guide) | plans upsell | HIDDEN: "Your coach manages your access" + Message your coach (`ProtectedScreen.tsx:48`, `PaywallSheet.tsx:70`) |
| Membership website link | web steering | HIDDEN (`MembershipScreen.tsx:213`) |
| CreditPackCheckout route (coach AI credits) incl. push tap | AI credit packs | HIDDEN via `withNonP2PPurchaseGate` (`CoachNavigator.tsx:98`), push routes to Settings (`pushTapRouter.ts:97`) |
| AI budget banner / meter chip / PackOptionsRow / tutorial / hard-pause modals | AI credit packs | HIDDEN (`AIBudgetMount.tsx:75,130,142`; `PackOptionsRow.tsx:38`) |
| CoachBillingScreen Start subscription / Manage billing / invoice links | coach plan | HIDDEN; status copy replaced by neutral note (`CoachBillingScreen.tsx:256,294`) |
| TeamManagement UpgradeGate / SubCoachInvite seat copy | seats | HIDDEN (`TeamManagementScreen.tsx:138`, `SubCoachInviteModal.tsx:144`) |
| Community event external links | paid links | allow-list of meeting/replay URL shapes only (`CommunityEventDetailScreen.tsx:85,283`) |
| BrandedCheckoutWebView | 1:1 hosted checkout | registered, no navigate() caller (dead route) |
| Programs | via packages only (`ProgramPackagesScreen` is coach-side) | no separate sale |
| Storefront, tips, classroom, challenges, community | none found (no price fields in community code) | n/a |
| Coach Stripe Connect / Money / charge screens | payouts and coach-initiated charges for 1:1 service | not an in-app purchase by the user |
Verdict (a): PASS. Apple Pay is off by config (`app.config.js` wallet plugin only with a merchant id).

## (b) 4.8 Sign in with Apple
Google appears only on Login (`LoginScreen.tsx:545-571`) and CreateAccount (`CreateAccountScreen.tsx:1390-1408`), each only when
the server advertises it. `AppleSignInButton` is on both screens unconditionally on iOS (`LoginScreen.tsx:580`,
`CreateAccountScreen.tsx:1415`); `usesAppleSignIn: true` and the expo-apple-authentication plugin are in app.json. No other
Google entry point. PASS. Production Apple config (APPLE_AUDIENCES, `/auth/apple`) is W3-04's lane; SoT 10-01 recorded the
signup policy as Apple on, Google off.

## (c) 5.1.1(v) account deletion
Client: More > Settings > Account > Delete account (`client/SettingsScreen.tsx:192-201`), also Trust Center (`TrustCenterScreen.tsx:406`),
Roman and AI (`RomanAiConsentScreen.tsx:344`) and the dunning lockout (`RootNavigator.tsx:308`). Coach: Settings > Danger zone >
Delete my account (`coach/settings/DangerZone.tsx:91-101`) and Trust Center. `DeleteAccountScreen` re-authenticates with password,
Apple or Google, types DELETE or the email, 14-day grace, cancels plans, and shows Apple revocation status. PASS.

## (d) Purpose strings (app.json + app.config.js)
- Health: `NSHealthShareUsageDescription` specific (react-native-health plugin, no clinical records). PASS.
- Face ID, microphone (expo-audio, voice notes), calendar write-only: present and specific. PASS.
- Notifications: no Info.plist string on iOS; prompt is in-app. PASS.
- Camera / photo library: MISSING — B-1.
- No location, contacts, Bluetooth or tracking APIs in deps; `ITSAppUsesNonExemptEncryption=false` set.

## (e) Fresh reviewer account (no coach, no plan)
Fresh client: Lean onboarding > Day-1 (coach pairing has "I don't have a code yet") > Home works; Workout, Log, Calendar,
Plan, Meal plan and AI guide show "Your coach manages your access" + Message your coach > Messages "No coach connected" >
Contact support. No crash and no dead end, but most of the app is locked, so the review notes must give a demo client with
a coach and an active plan, and a demo coach. If `COACH_CODE_GATE_ENABLED` is on in production, a fresh sign-up also needs a
code (give one). Fresh coach: wizard step 1 is required, steps 2-4 skippable, then Settings (and deletion) is reachable.
Crash paths a reviewer can hit: B-1 (support chat camera, Save Image).

## C list (one line each)
- C-1 `NSHealthUpdateUsageDescription` says workouts may be written to Apple Health; the app requests no write types (`healthKitClient.ts:318`). Drop the claim or the key.
- C-2 `NSMotionUsageDescription` declared, no CoreMotion use (steps come from HealthKit). Harmless.
- C-3 expo-calendar `remindersPermission: false`: if the first upload email names a reminders key, add a one-line string.
- C-4 Backend /terms: add "There is no tolerance for objectionable content or abusive users" and remove the public intro line "written as a company policy draft, and counsel review is recommended" (`trust-pages.html.ts:518-520`), which a reviewer reads.
- C-5 Membership copy "To pause, change tier, or cancel, message your coach directly" (`MembershipScreen.tsx:166-169`) conflicts with End my plan in YourPlansPanel.
- C-6 First-person product copy: "I could not reach the server…" (`RomanAiConsentScreen.tsx:66,71`).
- C-7 Coach wizard has no Sign out; deletion reachable only after step 1.
- C-8 Client Settings shows Change Password to Sign-in-with-Apple-only accounts.
- C-9 VERIFY with W3-04: SoT 10-01 listed `APPLE_SIGNIN_KEY_ID` / `APPLE_SIGNIN_PRIVATE_KEY` absent on Fly, so Apple token revocation at deletion reports `not_configured`; Apple requires revocation for SIWA accounts. Owner adds the key through the secure form.
- C-10 `purchaseSurfaces.ts` comment says expo-updates is not configured; it now is (channels in eas.json). The native build anchor still holds. Doc drift (W3-03).
- C-11 `BrandedCheckoutWebView` registered with no caller (dead route).
- C-12 iOS coach billing note "Billing changes are not made in the iOS app" and the "No subscription" pill; acceptable, keep without links.

## App Review notes draft (App Store Connect > App Review Information > Notes; under 4,000 characters)
Placeholders in <> are for the owner. Never name the clinic partner.

```
The Growth Project is the companion app for one-to-one personal training between a client and an individual coach.
Each client works with one named coach, who writes the client's training and nutrition plan, reviews check-ins and
logged workouts, replies to messages, and runs live sessions that the client books in the Calendar tab.

DEMO ACCOUNTS
Client (has a coach and an active plan): <email> / <password>
Coach: <email> / <password>
Invite code for a new client account: <code>
Sign in with Apple is available on the Sign in and Create account screens.

PAYMENTS — GUIDELINE 3.1.3(d)
The only purchase in the iOS app is a client paying their own individual coach for one-to-one personal training, a
real-time person-to-person service between two individuals. It is offered on one screen, titled "1:1 coaching with
<coach name>" (More > Membership > View coaching plans), and paid through Stripe to that coach's Stripe Connect account.
Each plan includes direct messaging with the coach, check-in reviews by the coach and live sessions booked in the
Calendar tab. Programs and meal plans inside a plan are written or assigned by that coach for that client as part of
the coaching; they are not sold on their own.
The iOS app sells no digital goods, app features or subscriptions to the app. Coach business tools (AI credit top-ups,
coach billing, team seats) are not sold in the iOS app, and the app shows no purchase links or prices for them.
Screens that need an active coaching plan say "Your coach manages your access" and offer only "Message your coach".

HEALTH DATA
Apple Health is read only, after the user connects it in Connections, to show the client and their coach sleep, heart
rate, workouts and activity. Nothing is written to Apple Health. Health data is never used for advertising or marketing
and is not sold.
AI features: Roman, the in-app AI assistant, and coach AI drafts use a client's information only after the client turns
on a separate, optional consent that names Anthropic as the AI provider and lists the data sent. It is off by default and
can be withdrawn in Settings > Roman and AI.

USER-GENERATED CONTENT — GUIDELINE 1.2
Community spaces are run by coaches. Users agree to the community guidelines and Terms before taking part (zero
tolerance for objectionable content or abusive users). Text is filtered on the server before posting; every post,
comment and member has Report and Block; reports are reviewed within 24 hours by the coach and The Growth Project team;
contact details are in Community > Community safety. Direct messages between members are off in this version.

ACCOUNT DELETION — GUIDELINE 5.1.1(v)
Clients: More > Settings > Delete account. Coaches: Settings > Delete my account. Deletion is confirmed in the app,
has a 14-day grace period that can be cancelled, and revokes Sign in with Apple tokens.

Support: <support email>. Privacy policy: https://app.trygrowthproject.com/privacy
```
Notes for the owner on the draft: the "users agree … before taking part" sentence is true only after B-2 merges; the
"revokes Sign in with Apple tokens" sentence is true only once C-9 is configured (otherwise drop it); the plan
description of the demo client's plan should itself list the live and messaging elements (owner idea from 10-01: one live
call a month in the $49 plan makes the real-time part concrete). Use dedicated review accounts, not the owner's own coach
account.

## Operator decisions (recommended default first)
1. Assign one mobile builder now for B-1 + B-2 in one PR (default: yes, one PR, app.json strings + community agreement sheet +
   CreateAccount terms line, under 300 lines, must merge before the 10-07 build). B-1 alone is ~4 lines if split.
2. Backend /terms copy (C-4): default yes, small backend PR after B-2 so the link target matches.
3. Review accounts: default create a dedicated demo coach and demo client (active comp plan via code) before submission.

## HANDOFF
- Status: DONE (report only). 2 B (B-1 purpose strings, B-2 UGC terms agreement), 12 C. No worktrees created, no branches,
  no claims, no locks held. Notify file: /home/user/workspace/ops/lanes123/notify/S-IOSREV-123.txt.
- A fresh agent continuing: re-check mobile main head (`gh api repos/BradleyGleavePortfolio/growth-project-mobile/commits/main`),
  if it moved past a727eb49 re-grep `app.json` infoPlist and `TERMS_URL` usage; otherwise hand B-1/B-2 to a builder with the
  exact fixes above. Not checked: live production env (APPLE_*, COACH_CODE_GATE_ENABLED, EXPO_PUBLIC_CRISP_WEBSITE_ID in EAS),
  privacy manifest contents of third-party pods (Expo SDK 56 template ships one), Play items (W3-02).
