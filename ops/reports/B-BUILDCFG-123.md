# B-BUILDCFG-123 — the 10-07 build config check (W3-03, builder, Claude Opus 5.5, agent 123)

Started 21:30 PDT 10-05, finished 21:38 PDT. Checked on mobile main `a727eb495a0ce381a22c4ac40370c0c69f53a656`.
Worktree `/home/user/workspace/wt/B-BUILDCFG-123` (detached, read-only use, removed at the end).

**Result: no PR. Nothing in the repo has to change before the build. B count 0.** Every open item below is a setting in EAS,
App Store Connect or Play Console that only the owner can see. The repo cannot read EAS values, and this job reads names only.

## What I checked (repo side)

| Item | Result |
|---|---|
| Every `EXPO_PUBLIC_*` name the code reads is in `config/expected-env.json` | OK. A source scan of src, App.tsx, plugins and app.config.js finds no unlisted name (the only extra matches are in comments and tests). |
| Every `EXPO_PUBLIC_*` name in eas.json production and clinic is in expected-env | OK (none unknown). |
| Names the build insists on (the `eas-build-pre-install` hook `scripts/check-expected-env.js --eas-hook`, profiles clinic and production) | `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (must be `pk_live_`), `EXPO_PUBLIC_SENTRY_DSN`. If any is missing or a placeholder, the build stops before install and names the variable. No required name has been added since the 10-02 env check passed (`17e4c117`). |
| clinic `extends` production | The clinic build gets every production value plus Health Connect on, client tutorial, coach brief, consultation onboarding and DM off (`--list --profile clinic` shows 15 profile values, including the iOS purchase-hide flag). |
| `node scripts/validate-app-config.js` | OK, 2 warnings: `playStoreUrl` is null, and `docs/well-known/assetlinks.json` (the repo copy) still has the placeholder. The live `app.trygrowthproject.com/.well-known/assetlinks.json` is served with a real fingerprint. |
| Version numbers | `version` 1.0.0, iOS `buildNumber` "6", Android `versionCode` 5, `appVersionSource: local` (EAS remote versioning off, no autoIncrement). |
| Version vs last builds | ff6bd4b (10-01) was an Android preview APK with versionCode 4, and it never had an iOS build. The last Play upload candidate was the production .aab (versionCode 4, EAS 4d2665c6). The last iOS TestFlight builds were 3, 4 and 5 (May). The SoT shows no iOS build since then. So iOS 6 and Android 5 are both one above the last known upload. |
| iOS purchase gate | `IOS_P2P_ONLY_MIN_NATIVE_BUILD = 6`. Build 6 or higher always hides non-1:1 purchases. Keep the build number at 6 or above. |
| OTA (expo-updates) | `runtimeVersion {policy: fingerprint}`; `updates.url` matches projectId `a12c3345-...`; `checkAutomatically ON_LOAD`; `fallbackToCacheTimeout 0`; channels: production -> `production`, clinic -> `clinic` (both EAS environment `production`). The purchase-gate file is a fingerprint input. OK. |
| Sentry | `@sentry/react-native/expo` plugin (org `the-growth-project`, project `growth-project-mobile`) plus native init. The DSN is required by the hook. `SENTRY_AUTH_TOKEN` is not checked by the build hook (see owner step 4). |
| PostHog | Optional. `App.tsx` reads `EXPO_PUBLIC_POSTHOG_API_KEY` and falls back to `EXPO_PUBLIC_POSTHOG_KEY`. `src/lib/analytics.ts` reads **only** `EXPO_PUBLIC_POSTHOG_KEY`. Host defaults differ (`app.posthog.com` vs `us.i.posthog.com`). |
| API base URL | The app sends every call to `EXPO_PUBLIC_API_URL` + path, and the backend serves its routes under `/api` (`setGlobalPrefix('api')`). Live probes: `GET https://api.trygrowthproject.com/health` 200; `/api/me/feature-flags` 401 (route exists); `/me/feature-flags` 404. **So the value must be `https://api.trygrowthproject.com/api`**. The bare host would make every call return 404. |

## Owner build checklist for Wed 10-07 (plain words)

Before you press build:
1. **Build the clinic profile, once per platform:** `eas build --profile clinic --platform ios` and `--platform android`, from a clean
   checkout of mobile main (eas.json requires a clean commit). Clinic has everything production has, plus Health Connect, the tutorial,
   coach brief and consultation onboarding. Do not also build `production` for the stores. Both profiles share the same app ID and the
   same build numbers, so the second upload would be rejected, and the production profile has no Health Connect.
2. **Check five values in expo.dev → Project → Environment variables → production** (look, do not paste them anywhere):
   `EXPO_PUBLIC_API_URL` reads exactly `https://api.trygrowthproject.com/api` (with `/api` at the end);
   `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (the live key, starting
   `pk_live_`) and `EXPO_PUBLIC_SENTRY_DSN` are present.
3. Visibility of every `EXPO_PUBLIC_*` variable is **plain text or sensitive, never secret**. A secret value builds fine, but the
   update tool cannot send it in a later over-the-air fix, so the fix would be refused.
4. Add **`SENTRY_AUTH_TOKEN`** (visibility sensitive, a Sentry token with release rights) in the production environment if it is not
   there. Without it, crash reports arrive unreadable, the over-the-air publish tool refuses to run, and the iOS bundle step can fail
   (the Sentry script exits with an error when the upload fails).
5. Add **`EXPO_PUBLIC_FF_IOS_HIDE_NON_P2P_PURCHASES` = `true`** (plain text) in the production environment if it is not there. The
   build already gets it from eas.json, but the over-the-air publish tool requires the EAS copy too. Do not set any other flag in the EAS
   environment to a value different from eas.json.
6. Analytics (optional): if you want PostHog, set **`EXPO_PUBLIC_POSTHOG_KEY`**, which both analytics readers use, and
   `EXPO_PUBLIC_POSTHOG_HOST` to your PostHog region host. Never set `EXPO_PUBLIC_SCREENSHOT_MODE` or `EXPO_PUBLIC_FF_WEARABLE_AI_INSIGHTS`.
7. Apple Pay / Google Pay: leave `EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER` and `EXPO_PUBLIC_GOOGLE_PAY_ENABLED` unset unless the Apple
   merchant ID is already registered. Unset means no wallet button, which is fine for day 1.
8. **Build numbers:** in App Store Connect → TestFlight, confirm the highest 1.0.0 build is 5 (this build is 6). In Play Console,
   confirm the highest versionCode is 4 (this build is 5). If either store already has the number, a one-line bump PR is needed first.
   Any rebuild after a rejected or failed upload also needs a bump (numbers do not go up on their own).
9. Start early. The free Expo plan queues builds for hours, and paying for faster builds is your call.

After the build:
10. Write down the **commit SHA, EAS build IDs and the runtime version** shown on each build page. An over-the-air fix reaches this build
    only if it is published to channel **`clinic`** (`npm run update:publish -- --channel clinic --environment production --message "..."`,
    `--dry-run` first) from a tree whose native parts match the build. Any change to app.json, app.config.js, eas.json, plugins, native
    packages or `src/config/purchaseSurfaces.ts` creates a new runtime, and this build ignores that update.
    `npx expo-updates runtimeversion:resolve --platform ios|android` must match the build page.
11. A fix downloads on one app launch and shows on the next cold start (users open the app twice).
12. Before the first over-the-air publish, run the four device checks in `docs/OTA_UPDATES.md` (offline start, update received, bad
    update recovers, rollback).

## Cs (one line each)
- C (follow-up): `src/lib/analytics.ts` ignores `EXPO_PUBLIC_POSTHOG_API_KEY`, and the two readers default to different PostHog hosts. Owner step 6 covers it.
- C (follow-up): README says a missing `SENTRY_AUTH_TOKEN` "still succeeds". That is not true of iOS under @sentry/react-native 7.11 (`sentry-xcode.sh` exits 1 when the upload fails). Owner step 4 covers it.
- C: repo `docs/well-known/assetlinks.json` placeholder vs the live file. The universal-links job owns this. iOS AASA lists /join, /invite and /billing/update-card, but not /reset-password or /p (Android intent filters have them). For the link job.
- C: `playStoreUrl` null in app.json (fill after the Play listing is public; OTA can't change it later).

## HANDOFF
- State: DONE. Report only, no PR, no push, no branch, no comment. B 0. Worktree `/home/user/workspace/wt/B-BUILDCFG-123` removed.
- If a fresh agent continues: the only open items are owner settings (checklist 1-9). They need an expo.dev, App Store Connect or Play
  Console look, which agents may not do (never touch Expo or EAS). If the owner reports that iOS build 6 or Android versionCode 5 is
  already used, open one PR on mobile main bumping `ios.buildNumber` / `android.versionCode` in app.json (keep iOS at 6 or above), title
  `chore(release): build N / versionCode M for the 10-07 store build`.
- Notify: `/home/user/workspace/ops/lanes123/notify/B-BUILDCFG-123.txt`.
