AUDIT Claude Opus 5.5 — growth-project-mobile#368 @ 2216ad1dc94d280e33a39a3ae2d8b7ac197c16dc — VERDICT: REQUEST CHANGES
A/B/C = 0/1/3

Lens: agent 118, job AUD-OPUS-FU2-118.
- Audited at **T4** (account-deletion copy), not the T3 in the body.
- I read all 3 files line by line. Base = main `7fdb629a`; size 112 lines.
- Required checks are green at this head: Typecheck, lint, test (job 111373456068), Analyze (javascript-typescript) and Analyze (actions). The merge state is CLEAN.

## Prior finding of this lens: closed
- AUD-OPUS-PRIV3-117, operator item 1: `APPLE_FALLBACK` gave Sign-In & Security as an iPhone step and said "Apple ID".
- It is closed at `DeleteAccountScreen.tsx:94-97`.

## Copy truth
I checked Apple's pages today: Apple Support 102571 (published 2026-09-14) and the iPhone User Guide 18.0, current, 17.0 and 16.0.
- **`APPLE_FALLBACK` (`:94-97`):**
  - iOS 18 and later: Settings > your name > Sign in with Apple > app > Delete > confirm. That is Apple's path.
  - Earlier iOS (the floor is 16.4) and other devices: account.apple.com > Sign-In & Security > Sign in with Apple. That is Apple's web path, and it does not depend on the iOS version.
  - It gives the same steps, in the same order, as backend #700 `SIGN_IN_WITH_APPLE_DELETION_TEXT` (`trust-pages.html.ts:95-98`). Only "the app" vs "this app" differs.
- **Revoked card (`:463-465`):** shown only when `apple_revocation === 'revoked'`. "Apple Account" is Apple's current name.
- **`APPLE_FORM_NOTE` (`:101-102`):** no first person, and no revocation claim before the server reports one. The old "we also ask Apple" is gone.
- **No logic change:** `showAppleFallback` (`:433-434`) and the revoked condition are identical to main (`:419-420` there).
- **Failing-before run 37180664588: genuine.** Lane head `cb4a34ab` = `018ad155` + lane files, and `018ad155` = main + the test file only. The 9 failures are exactly the 9 new tests.

## B-368-1: the new form note promises something the status view does not always show
- **The promise:** `APPLE_FORM_NOTE` (`:101-102`, new in this diff, rendered unconditionally at `:576-582`) says: "If you signed in with Apple, after you confirm you will see whether Apple removed this app's access to your Apple Account, and how to remove it yourself if not." The PR body says this is "True for every `apple_revocation` outcome".
- **Why it can fail:**
  - The status view shows an Apple card only when `appleOutcome === 'revoked'` (`:461`) or `showAppleFallback` (`:433-434`): `appleOutcome !== 'revoked' && (isAppleAccount || (appleOutcome !== null && appleOutcome !== 'not_requested'))`.
  - `isAppleAccount` (`:375`) is false whenever `getSignInProviders()` returns null. That is a designed state (`utils/authProviders.ts:35-58`): the token has no `app_metadata` providers, and the form then offers every method.
  - If the person then confirms with Apple and (a) the authorization code is null, the server answers `not_requested` (`apple-token-revocation.service.ts:114`); or (b) the response carries no `apple_revocation`. Either way, neither card renders.
- **Grade:** I found this path myself (my draft rated it C before I read the Sol verdict). I raise it to B because the job requires every public sentence to be true of the code, and this sentence is new in this diff.
- **Probe:** run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219296106 (branch `audit/AUD-OPUS-FU2-118/368-applenote`; head `389950f2` = this head + one probe block appended to `DeleteAccountScreen.test.tsx` + lane files).
  - 2 failed and 48 passed.
  - Both promise tests fail with "Expected: true, Received: false" (no `apple-revoked` and no `apple-fallback`).
  - The control (Apple confirm, code sent, `not_configured`, shows the fallback) and all 47 existing tests pass.
- **Fix rule:**
  - Track that the person confirmed with Apple (method `apple`) and show `APPLE_FALLBACK` whenever Apple was used, or the provider is unknown, and the outcome is not `revoked`. Do not rely only on the provider lookup.
  - Alternatively, word the note so it is true without that guarantee.
  - Add tests for providers-null + Apple confirm with `not_requested`, with a missing outcome, and with password; plus known non-Apple and `revoked` controls.
- **Verify:** the probe block passes.

## C (optional)
- **C-368-1: in non-revoked outcomes, the "not removed" part of the note is shown only by omission.**
  - `APPLE_FALLBACK` starts "You can also remove...".
  - Fix rule: start the fallback card with "Apple has not confirmed that this app's access was removed.", then give the steps.
- **C-368-2 (same file, outside this diff): first person left on this screen.**
  - `:80` (`KEPT_RECORDS`): "Our own copies keep only ...".
  - `:138`: "We could not check your account deletion status ...".
  - Fix rule: "The app's own copies ..." and "The account deletion status could not be checked ...". Keep `KEPT_RECORDS` worded the same as the backend manifest and policy.
- **C-368-3 (outside this diff; the builder disclosed it): "Apple ID" and first person in sign-in copy.**
  - `src/lib/signupRoleNotice.ts:53` and `src/screens/auth/CreateAccountScreen.tsx:1015`.
  - Fix rule: say "Apple Account", with no "we".

## Merge note
- Land #368 together with backend #700 so the app and /privacy give the same steps.
- Neither depends on the other at runtime. Live /privacy still has the #611 sentence, without the iOS 18 qualifier.

## Evidence reuse (G09)
None. This lens had not approved #368 before, so I audited every line.
