# B-LINKS-123 — W3-05 invite links, QR links and universal links (agent 123)

Start 21:30 PDT 10-05 (time box 30 min, ends 22:00). Builder, Claude Opus 5.5.

## Production checks (read-only GETs, 21:31)
| Check | Result |
| --- | --- |
| `https://app.trygrowthproject.com/.well-known/apple-app-site-association` | 200 JSON. appID `F8TL8N7SGQ.com.growthproject.app`; paths `/join/*`, `/invite/*`, `/billing/update-card`; webcredentials same appID. Same doc on api.trygrowthproject.com. |
| `https://app.trygrowthproject.com/.well-known/assetlinks.json` | 200 JSON. package `com.growthproject.app`, 1 SHA-256 fingerprint (B8:9D:…:FB), `handle_all_urls` + `get_login_creds`. |
| Mobile app.json (a727eb49) | iOS bundle `com.growthproject.app`, `associatedDomains: applinks:app.trygrowthproject.com`; Android package `com.growthproject.app`, `autoVerify` https filter `/join`, `/invite/accept`, `/reset-password`, `/p`, `/billing/update-card` + tgp scheme. IDs match the served files. |
| `/join/GP-BRADLEY`, `/invite/GP-BRADLEY`, `/join/GP-NOPE99` | 404 "This invite isn't available" page, link to /signup. `/api/invite/GP-BRADLEY/preview` → `{"valid":false}`: GP-BRADLEY is not created yet (C04 / W3-06), so no valid production code exists to render the valid page live. |
| `/signup`, `/signup/<code>`, `/download/ios`, `/download/android` | 200. /signup says invite-only, "open it on your phone"; download pages are "Coming to the App Store / Google Play" status pages. |
| `app.trygrowthproject.com/` | 404 "Page not available" (known backlog: no home page). |

## App handling (code read, mobile a727eb49)
- `RootNavigator.linking`: prefixes `tgp://`, `https://app.trygrowthproject.com`; `CreateAccount: 'join/:invite_code?'` → `CreateAccountScreen` prefills `invite_code` and previews it (`CreateAccountScreen.tsx:187,408-416`). Signed-in users: URL guard stores the code via `writePendingInviteCode` (PendingInviteBanner).
- Codes screen (m#387) QR/share: backend `coach-code-tools.service.ts` `joinUrlFor` → `PUBLIC_INVITE_BASE_URL/<code>` (= `/join/<code>`), legacy screen `buildInviteUniversalLink`. Same URL shape. OK.
- Backend preview covers CoachProfile.invite_code and InviteCode rows (`invite-codes.service.ts:767-804`). OK.

## Finding fixed (B-LINKS-1)
Valid-code landing page (`invite-landing.service.ts renderValid`, main 5230306c): main button = the shared universal link itself; "Continue on web" = `/signup`. A visitor only sees this page when the OS did not open the app, and iOS keeps same-domain taps in Safari, so the button reloads the page; /signup tells the visitor to open the invite on a phone (loop). Story: a new client taps the coach's invite link on an iPhone without the app, taps the big "Open in The Growth Project" button, and the same page reloads; only a small store link at the bottom leads anywhere. Also: unset `APP_STORE_URL` fell back to `apps.apple.com/app/the-growth-project/id0` (dead).

Fix: **growth-project-backend#745** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/745, branch `fix/invite-landing-ctas`, head `8ad33e4bbc1d826e2c896dc668e0fa86750c6f79`, 363 changed lines (5 files).
- iPhone UA: primary "Get the app on the App Store", secondary "Already have the app? Open it" (`tgp://join/<code>`).
- Android UA: primary `intent://join/<code>#Intent;scheme=tgp;package=com.growthproject.app;S.browser_fallback_url=<PLAY_STORE_URL>;end` (opens app with code, else Google Play) + Google Play link.
- Other: "Open this invite on your phone to join." + both stores. All layouts show the code and "open this invite link again after installing, or enter code X when you create your account".
- APP_STORE_URL unset → `<invite host>/download/ios`. `Vary: User-Agent`.
- Tests: `test/invite-landing.spec.ts` 17/17 pass locally (heavy.sh); new tests fail on main. ESLint clean on touched files.

## Cs (not fixed)
- C-LINKS-1: Android intent filter mixes `tgp` hosts and `https` hosts in ONE autoVerify filter; data elements merge, so Android 11 and older try to verify hosts like `https://join` and fail all-or-nothing (Android 12+ verifies per host). Users still reach the landing page, whose Android button now opens the app. Fix later: split the https entries into their own intent filter (mobile app.json). C (edge, deferred).
- C-LINKS-2: AASA lists `/invite/*` but the app has no `invite/:code` route (only `invite/accept/:token`); no code emits `/invite/<code>` links today. C.
- C-LINKS-3: assetlinks fingerprint B8:9D:…:FB not verified against the Play App Signing key (needs Play Console; not read-only from here). If it is the EAS upload key only, Play-installed apps will not auto-verify; the landing page intent button still works.
- C-LINKS-4: `/signup` page copy uses first person ("we will connect you", "Email us" is fine). Copy rule.
- C-LINKS-5: no deferred deep link: after installing from the store the code is not carried; the page tells the user to reopen the link or enter the code (CreateAccount also has Paste invite code).

## Operator decisions
1. Set `APP_STORE_URL` / `PLAY_STORE_URL` Fly secrets to the real listings once live (default: keep status pages until then; this PR makes the unset iOS case safe).
2. Confirm the assetlinks fingerprint equals the Play App Signing SHA-256 in Play Console (default: owner checks during W3-02 Play review readiness).

## CI
PR CI at 8ad33e4b: 15 SUCCESS, 1 SKIPPED (deploy-readiness-gate, expected in PR mode), 0 red (checked 21:47). Opening comment posted 21:48: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/745#issuecomment-6009540659 (READY FOR AUDIT).

## HANDOFF
- DONE 21:48. PR backend#745 @ 8ad33e4bbc1d826e2c896dc668e0fa86750c6f79, CI green, FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT. Next step belongs to the operator: assign Opus + Sol lenses (full review, 30 min; touched files src/invite-landing/*, test/invite-landing.spec.ts, docs/invite-landing.md).
- Worktree /home/user/workspace/wt/B-LINKS-123 removed (work pushed). PR branch fix/invite-landing-ctas kept (it is the PR head).
- No mobile change needed for the 10-07 build. Optional follow-up C-LINKS-1 (split the Android https intent filter) is mobile app.json only.
- Open operator decisions: real APP_STORE_URL / PLAY_STORE_URL secrets once listings are live; confirm assetlinks fingerprint vs Play App Signing key.
