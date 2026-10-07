# Store text — October 07 build

**Refreshed draft for Bradley and the operator. No store submission has been made.**

The inspected release basis is [mobile main 950689af](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/950689af696f993d6bb2b361ca6b5d07bab1328e) and [backend main 2df556b7](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/2df556b7eeaf00cd8ec571b30f830933461cd8e5), checked October 06 at 18:16:19 PDT.

Both October 07 platform builds should use the clinic settings, which inherit production settings and include the Android Health Connect integration. [Build settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json)

Use the text below only after the corresponding paths pass in the actual submitted build. **Evidence links belong to this sheet, not the store fields:** copy the wording without the links. Keep all passwords in the stores' private review-access fields.

## 1. Listing text

### App name

The Growth Project

### App Store subtitle

Training, food and coaching

### Play short description

Personal training, food logs and support from your coach.

### Shared full description

The Growth Project brings personal training, food logging and coach conversations into one app. [Client screens](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/ClientNavigator.tsx)

Follow workouts assigned by your coach, record your sets and review your progress. [Workout logging, #397](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/397) [Progress, #430](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/430)

Log food with clear portions, use recent foods and repeat a past meal. [Food portions, #396](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/396) [Faster food logging, #403](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/403)

Book and manage coaching sessions in Calendar, message your coach and take part in coach-led Community spaces. [Calendar, #367](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/367) [Messaging, #377](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377) [Community build settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json)

Clients with a coach can choose to join that coach's leaderboard and choose a display name. [Optional Community leaderboard, #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438)

Open the PDFs, videos and other content included in your coaching plan when your coach makes them available. [Delivered content, #434](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434) [Buyer content enabled, #437](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437)

Ask Roman, the optional AI assistant, general training and nutrition questions, and manage your AI permission and saved conversations. [AI permission disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts) [Conversation controls, #375](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/375)

Coaches can manage clients, build and assign training programs, review food and workouts, prepare AI drafts for review, and attach PDFs and videos to coaching packages. [Coach screens](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/CoachNavigator.tsx) [AI workout assignment, backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806) [Package files, #437](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437)

**Add to the iPhone description:** Connect Apple Health with your permission to bring available activity, sleep and other selected health readings into your coaching. [iPhone health connection, #421](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/421)

**Add to the Android description:** Connect Health Connect with your permission to bring available activity, sleep and other selected health readings into your coaching. [Android clinic health settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json)

**Include in both descriptions:** The Growth Project provides personal training and general nutrition guidance, not medical care. [Non-medical service disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

It is not a medical device and does not diagnose, treat, cure or prevent any medical condition. [Existing health disclaimer](https://support.google.com/googleplay/android-developer/answer/16679511?hl=en)

Consult a healthcare professional for medical advice and before making medical decisions. [Existing health disclaimer](https://support.google.com/googleplay/android-developer/answer/16679511?hl=en)

Roman is an AI assistant, not a healthcare professional, and its replies can be wrong. [Public AI terms](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

## 2. Release notes

### App Store — What's New

- Faster food logging with recent foods, repeat meals and clearer portions. [Mobile PR #403](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/403) [Mobile PR #396](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/396)
- Improved assigned workouts, live-session controls and saved-workout editing. [Mobile PR #399](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/399) [Mobile PR #401](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/401)
- Open PDFs and videos included in your coaching plan. [Mobile PR #434](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434) [Mobile PR #437](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437)
- Find your coach's optional leaderboard inside Community. [Mobile PR #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438)
- Coaches can review AI workout drafts and assign the approved workouts to clients. [Backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806) [Truthful app confirmation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/utils/coach/aiWorkoutApproveCopy.ts)
- Improved Apple Health access, support reporting and coach notification setup. [Mobile PR #421](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/421) [Mobile PR #417](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/417) [Mobile PR #393](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/393)

### Play — What's new

Faster food logging with recent foods and repeat meals. [Mobile PR #403](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/403)

Improved workout logging and session controls. [Mobile PR #397](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/397) [Mobile PR #401](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/401)

Connect Health Connect, open PDFs and videos included in coaching plans, and find an optional leaderboard in Community. [Clinic settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json) [Mobile PR #434](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434) [Mobile PR #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438)

Coaches can review AI workout drafts and assign approved workouts. [Backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806)

Clearer support reporting and plan terms. [Mobile PR #417](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/417) [Mobile PR #342](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342)

Join the Play sentences into one paragraph when pasting.

## 3. Private review notes

**Before pasting:** confirm both review accounts work in the submitted binary, contain synthetic data only, and have the sample plan, assignments, files, sessions, conversation and Community membership described below. Replace any unverified item with an accurate access instruction.

### Common notes for both stores

The Growth Project is a personal-training app for clients and coaches, not a medical service. [Service description](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

Client and coach review credentials are supplied separately in the private review-access fields. Use the client account to inspect Train, Log, Calendar, coach Messages, Community and the active coaching plan; use the coach account for Clients, Programs, Messages and Settings. [Client navigation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/ClientNavigator.tsx) [Coach navigation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/navigation/CoachNavigator.tsx)

For the optional leaderboard, open Community > Leaderboard using the client account paired with a coach; participation is off until the client chooses to join. [Leaderboard entry and opt-in, #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438)

For included PDF/video content, open More > Membership > View coaching plans > View what's included on the supplied active plan. [Content entry](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/screens/client/ClientPackagesScreen.tsx)

For coach AI workout review, open Clients > the review client > Summary > Coach AI > Generate workout program; review and approve the draft, then inspect the client's assigned workouts. [Coach AI entry](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/components/coach/CoachAiSection.tsx) [Actual assignment, backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806)

Client-data AI needs optional permission, which can be managed in More > Settings > Privacy > Roman and AI; ordinary coaching remains available when permission is declined. [AI permission disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

Roman conversations are not visible to the coach; restricted staff access for support, safety and debugging and AI-provider processing are described in the privacy policy. [Roman privacy disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

For support, open Settings > Support; Report a problem by email opens an email draft, with a visible support-address fallback when the device cannot open email. [Support entry and fallback](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/screens/support/SupportInboxScreen.tsx)

Health connection is optional and reads selected available data into TGP for the client and assigned coaching team; this connector does not write workouts back to the phone's health store. [Health-data disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

Account deletion is in Settings; it has a confirmation step and a 14-day grace period. [Account-deletion disclosures](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/f71bb9a4c973fbd7d3f3bcd555dbcd0cd491e199/src/public-pages/trust-pages.html.ts)

Privacy policy: https://app.trygrowthproject.com/privacy

Consumer Health Data Privacy Policy: https://app.trygrowthproject.com/consumer-health-privacy

### Add for App Review

Sign in with Apple is offered on supported iPhones; Apple Health is under More > Connected devices. [Native Apple sign-in button](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/components/AppleSignInButton.tsx) [Apple settings correction, backend #748](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/748) [Apple Health entry, #421](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/421)

The iOS release hides coach AI-credit packs and coach software-upgrade purchases while retaining the named human coach's 1:1 package checkout. [iOS purchase policy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/config/purchaseSurfaces.ts)

**Only after the owner confirms the submitted paid offers are genuinely real-time, one-to-one human services, add:** PaymentSheet is used for real-time personal training between the client and a named individual coach; recurring checkout shows the price, interval and any trial terms before payment. [App payment implementation, #342](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342) [Existing payment-rule reference](https://developer.apple.com/app-store/review/guidelines/)

Included PDFs, videos and programs support the coaching service; this listing does not claim that standalone digital files, AI replies or group services are sold through an iOS payment exception. [Purchase-surface scope](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/src/config/purchaseSurfaces.ts)

### Add for Play review

This submitted Android build includes Health Connect under More > Connected devices and asks for the user's selected health permissions. [Clinic Health Connect settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json)

Android release builds hide coach AI-credit and coach software-upgrade Stripe purchase surfaces; real-time human coaching package checkout is unchanged. [Android digital-purchase correction, #412](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/412)

### Ask AI note — keep conditional

Do **not** add Ask AI to public store claims at this snapshot: the status route has merged, but the new workout-builder UI and generator are still open PRs, and the latest desired-state settings leave live generation unset. [Mobile #439](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439) [Merged status route, backend #808](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808) [Generator, backend #809](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/809) [Current settings](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json)

If the operator confirms those changes are in the actual build and deployed backend, add this private note: Ask AI appears in the coach's saved-workout builder, proposes changes for review when enabled and makes no change until Apply; when paused it explains that workouts are unchanged, and if the backend does not support it the entry is hidden. [Proposed Ask AI states, mobile #439](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439)

## 4. Changed claims and why

| Previous wording or omission | Refreshed wording | Why |
| --- | --- | --- |
| iPhone described as production; Android alone as clinic. | Both October 07 builds use clinic settings. | Clinic inherits production and adds the required launch screens; this corrects the old device instructions. [Build settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json) |
| Health Connect omitted from Android release copy. | Health Connect is included for this clinic Android build. | The clinic setting includes the native integration; ordinary production Android settings still differ. [Build settings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/950689af696f993d6bb2b361ca6b5d07bab1328e/eas.json) |
| Apple sign-in described as an expected failure. | Test successful Apple sign-in; capture a failure as different. | Apple audience and nonce settings were corrected, but a source-code review is not a completed device test. [Backend #748](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/748) |
| iPhone Apple Health treated as an optional extra without a reliable entry. | More > Connected devices reaches Apple Health. | The phone-specific entry was corrected. [Mobile PR #421](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/421) |
| Samsung Health shown as a separate connection; cloud trackers assumed available. | Use Health Connect on Android; show cloud trackers only when available. | The phone filters and server-driven provider list now control what is offered. [Mobile PR #421](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/421) [Mobile PR #436](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/436) |
| Code tools, broadcasts and no-coach Home described as off. | Include their day-1 paths, with the featured offer dependent on saved configuration. | The current desired-state manifest marks the three features on; the operator must still confirm the applied live state. [Backend manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json) |
| Dunning v2 described unconditionally as off. | Do not promise a billing-recovery state in public copy; confirm its live state separately. | The manifest now requests it on, but applying that requires the owner's Stripe steps; a manifest is not proof of the live setting. [Backend #762](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/762) [Backend manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json) |
| Coach push permission and Community mute described as known gaps. | Expect a coach permission prompt and muted Community pushes. | Both normal-use gaps were fixed. [Mobile PR #393](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/393) [Backend #751](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/751) |
| Community posting described as expected to fail. | Test posting, replies and the coach report queue. | Coach spaces, the persistent New post action and the report-queue entry were corrected. [Backend #753](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/753) [Mobile PR #428](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/428) |
| Leaderboard absent from the release text. | Optional leaderboard inside Community, for clients of the same coach. | It is now reachable, with opt-in, opt-out and a display name; not a public all-user ranking. [Mobile PR #438](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438) |
| Purchased PDF/video content absent or described as unavailable. | Open included files; coaches upload and attach package PDFs/videos. | Buyer access, upload selection and store-build deliverables were enabled. [Mobile PR #434](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434) [Mobile PR #437](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437) |
| AI approval could be mistaken for client assignment. | Say assigned only after a real assigned count, then check the client's workouts. | The app distinguishes library-only responses, and the backend now writes the approved client assignments. [Mobile PR #425](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/425) [Backend #806](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/806) |
| Ask AI could be presented as already shipped. | A conditional device/review check only, including paused and unsupported states. | Status support has merged; the mobile UI and generator remain open, and live generation is not enabled in the latest requested settings. [Mobile #439](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439) [Backend #808](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808) [Backend #809](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/809) [Current settings](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json) |
| Android coach digital Stripe purchase controls could be implied available. | No coach AI-credit/software checkout claim on either store build. | Android release purchase controls now hide those digital payment surfaces too. [Mobile PR #412](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/412) |
| Food, workout and progress descriptions missed the new everyday fixes. | Recent foods, repeat meals, correct portions, usable session controls and saved progress. | The corresponding mobile paths were corrected since the old sheets were written. [Mobile PR #403](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/403) [Mobile PR #401](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/401) [Mobile PR #430](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/430) |
| Generic support failure or report path omitted. | Settings > Support > Report a problem by email, with an address fallback. | The normal-use support report and failure recovery were added. [Mobile PR #417](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/417) |
| Old universal encryption or invite-only/web-only wording. | No blanket certification, hardware-encryption, invite-only or web-only claims. | Trust Center and public signup/help wording were corrected; use current public disclosures. [Mobile PR #390](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/390) [Backend #755](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/755) |

## 5. Before the operator pastes anything

1. Confirm the final version/build and both private review sign-ins; use only synthetic reviewer data.
2. Confirm the sample active plan, assigned workouts, files, bookings, messages and Community membership actually appear on both phones.
3. Confirm the paid offers match the real-time human-coaching description; recommended default: describe PDFs/videos as included package content, not standalone app purchases.
4. Use the final binary's privacy, health and permission inventory for the store forms; do not paste the old declaration worksheet as if it described this build.
5. Leave Ask AI and Roman's newer memory/playbook out of public release claims unless separately confirmed in the submitted build and applied backend settings; the inspected manifest still leaves memory/playbook unset. [Current manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2df556b7eeaf00cd8ec571b30f830933461cd8e5/.github/fly-env-desired-state.json)

**Your next step:** complete the device pass, then paste the verified wording and private review access into the store forms.
