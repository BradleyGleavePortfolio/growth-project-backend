# B-APPLE-123 — W3-04 Sign in with Apple on production (agent 123)

Builder: Claude Opus 5.5. Started 21:30 PDT 10-05 (time box 30 min).
PR: growth-project-backend#748 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/748
Head: f6b3e1915c4ff49453ac06bd9958cbd18aa136c9 (branch fix/apple-signin-manifest-123, base main 5230306c). 76 changed lines.
CI: see "CI state" below.

## Evidence (names only, no values)
- env-truth run 37405459790, artifact 11386574775 (value-free JSON saved at ops/aud-123/B-APPLE-123/env-truth-report.json):
  - APPLE_AUDIENCES: present, non-empty, length 16-31, shape check `first-entry-is-ios-bundle-id` = **fail**.
  - APPLE_NONCE_REQUIRED: present, length 1-7, duplicate group D3 together with FEATURE_AI_CONSENT_LEDGER_ENABLED,
    FEATURE_MWB_TEMPLATES, FEATURE_MWB_AUTOSAVE_UNDO, FEATURE_NAMED_REGIMES, FEATURE_WEARABLES_INGEST_POST (all declared and live
    as `true`), so its value is `true`.
  - APPLE_TEAM_ID present (8-15). APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY, APPLE_SIGNIN_CLIENT_ID: missing on Fly.
- GitHub Actions secrets (repo level, names + dates only): APPLE_SIGNIN_KEY_ID (2026-10-01 16:11Z), APPLE_SIGNIN_PRIVATE_KEY
  (2026-10-01 16:11Z), APPLE_NONCE_REQUIRED (2026-05-20). No APPLE_AUDIENCES secret. fly-apple-signin-set.yml has never run.
- Mobile main a727eb49: app.json ios.bundleIdentifier `com.growthproject.app`, usesAppleSignIn true; src/utils/appleAuth.ts
  `signInWithApple` calls `AppleAuthentication.signInAsync` with no nonce and `buildAppleAuthBody` sends only token/full_name/invite_code
  (no raw_nonce).

## What each env name is for (code)
| Name | Read by | Used for | If wrong/missing |
|---|---|---|---|
| APPLE_AUDIENCES | src/auth/apple-verifier.service.ts `getAudiences` | audience pin for every Apple identity token: POST /auth/apple (sign in/up, auth.service.ts:1160) and the Apple re-auth for account deletion (auth.service.ts:1991); also gates `apple` in /auth/signup-policy (auth.service.ts:944) | unset: Apple hidden, 503. Wrong value (today): Apple button shown, every attempt 401 |
| APPLE_NONCE_REQUIRED | auth.service.ts:1181 | when exactly `true`, rejects tokens without raw_nonce | `true` (today) + app sends no nonce: every sign-in 401 |
| APPLE_SIGNIN_KEY_ID / APPLE_SIGNIN_PRIVATE_KEY (+ APPLE_TEAM_ID) | src/account-deletion/apple-token-revocation.service.ts `readConfig` | deletion-time revocation of the app's Apple tokens (ES256 client secret, /auth/token + /auth/revoke) | missing (today): revocation skipped, outcome `not_configured` in deletion_audit; deletion still completes. Not a login dependency |
| APPLE_SIGNIN_CLIENT_ID | same | client id for the revocation exchange | optional; defaults to `com.growthproject.app` (DEFAULT_APPLE_SIGNIN_CLIENT_ID). Nothing to set |

## Findings
- **B-APPLE-1** (core flow sign in/sign up + in-app deletion; store review): an iOS user taps Sign in with Apple, approves the sheet and
  gets an error, never an account; Apple-only users also cannot pass the re-auth step of in-app account deletion. Cause: production
  APPLE_AUDIENCES does not start with (and by length almost certainly does not contain) `com.growthproject.app`, the audience of every
  native token. App Review taps Sign in with Apple; a failure is a Guideline 2.1 rejection, and broken deletion is 5.1.1(v).
- **B-APPLE-2** (same flow): with the audience fixed, the same tap still fails with 401 "nonce is required but was not provided",
  because APPLE_NONCE_REQUIRED is `true` on Fly and the app sends no raw_nonce. Source of the value: fly-db-secrets-set.yml pushed the
  GitHub secret APPLE_NONCE_REQUIRED alongside DATABASE_URL/DIRECT_URL.
- **B-APPLE-3** (store/legal, does not block login): APPLE_SIGNIN_KEY_ID / APPLE_SIGNIN_PRIVATE_KEY are GitHub secrets since 10-01 but
  were never pushed to Fly, so account deletion does not revoke Apple tokens (App Store 5.1.1(v) asks apps that offer Sign in with Apple
  to revoke tokens on deletion). Fix is an operator dispatch, not code (below).
- C (edge, deferred): mobile should send a hashed nonce (`signInAsync({ nonce: sha256(raw) })` + `raw_nonce`), then flip
  APPLE_NONCE_REQUIRED to `true` once that build is the oldest supported. Replay defence on an already-verified path.
- Observation for the operator (outside W3-04, not analysed): D3 (= `true`) also contains DIAGNOSTIC_AI_ENABLED, GOOGLE_CALENDAR_ENABLED,
  GOOGLE_MEET_ENABLED, ZOOM_ENABLED, FEATURE_SCOUT_INGEST, FEATURE_EXTENSION_PAIRING, FEATURE_GOOGLE_CALENDAR_SYNC, which the manifest's
  `excluded` reason describes as "stays off".

## Is APPLE_AUDIENCES non-secret? Yes
It is a list of Apple bundle ids / Services IDs. The bundle id ships in the app binary and is the `aud` of every Apple token. So it is
declared as a literal in .github/fly-env-desired-state.json with an ENV_RULES closed set (`values: ['com.growthproject.app']`,
`unsetIs: 'off'`). APPLE_NONCE_REQUIRED is also non-secret (a switch) and is declared `unset`.

## PR #748 contents
- src/common/env-validation.ts: closed sets for APPLE_AUDIENCES and APPLE_NONCE_REQUIRED (descriptive only, no boot change); fixes
  the wrong example bundle id (`com.thegrowthproject.app`) in the APPLE_AUDIENCES reason, a likely origin of the bad value.
- .github/fly-env-desired-state.json: `APPLE_AUDIENCES: "com.growthproject.app"`, `APPLE_NONCE_REQUIRED: "unset"`, two gates.
- .github/workflows/fly-env-sync.yml: apply guard regex accepts dotted lowercase values (`=[a-z0-9]+([.][a-z0-9]+)*`); without it
  apply aborts on the bundle id. Values stay array args.
- .github/workflows/fly-db-secrets-set.yml: stops pushing APPLE_NONCE_REQUIRED (the manifest is its one path; enforced by the
  existing "one path: no other workflow mentions a managed flag name" test). fly-apple-signin-set.yml: comment only.
- docs/runbooks/launch-flags.md: two kill-table rows (generated), day-1 Apple sequence.
- Tests: fly-env-manifest.spec.ts (declared audience == classifier IOS_BUNDLE_ID == DEFAULT_APPLE_SIGNIN_CLIENT_ID, shape check pass;
  nonce unset) and fly-env-sync-behavior.spec.ts (apply stages APPLE_AUDIENCES=com.growthproject.app; verified failing with main's
  regex). Local runs via heavy.sh: fly-env-manifest 69/69, fly-env-sync-behavior 55/55, fly-env-workflows 15/15, env-registration
  30/30; eslint clean.
- Never ran any Fly workflow, env sync or fly-secrets-set.yml.

## Owner actions, in plain words
1. **Apple Developer: nothing new to create for sign-in.** The audience is the app's bundle id `com.growthproject.app`; it goes in the
   manifest (PR #748), not in a GitHub secret.
2. **The Sign in with Apple key: already done on 10-01.** GitHub Actions secrets `APPLE_SIGNIN_KEY_ID` and `APPLE_SIGNIN_PRIVATE_KEY`
   exist on growth-project-backend. Only confirm the key is the one made in Apple Developer > Certificates, Identifiers & Profiles >
   Keys, with "Sign in with Apple" ticked and primary App ID `com.growthproject.app` (team F8TL8N7SGQ). If not sure, make a new key
   there, download the .p8 once, and replace the two secrets: `APPLE_SIGNIN_KEY_ID` = the 10-character Key ID,
   `APPLE_SIGNIN_PRIVATE_KEY` = the whole .p8 file including the BEGIN/END lines. `APPLE_SIGNIN_CLIENT_ID` is not needed.
3. **Supabase (check only):** Authentication > Providers > Apple must be enabled and its Client IDs list must include
   `com.growthproject.app`; otherwise Supabase rejects the token after the backend accepts it. Agents cannot see this setting.
4. **Optional cleanup:** the GitHub secret `APPLE_NONCE_REQUIRED` is no longer read by any workflow after #748 merges; it can be deleted.

## Operator steps after #748 is audited and merged (production; owner go)
1. fly-env-sync plan: APPLE_AUDIENCES `set`, APPLE_NONCE_REQUIRED `unset`, nothing else unexpected.
2. fly-env-sync apply with deploy_staged=true (one rolling restart; can share the window with step 3).
3. fly-apple-signin-set.yml with confirm=SET (pushes the two key secrets; rolling restart).
4. fly-env-truth: APPLE_AUDIENCES shape check `pass`; APPLE_SIGNIN_KEY_ID / _PRIVATE_KEY present; APPLE_NONCE_REQUIRED absent.
5. Owner device pass (iOS): Sign in with Apple on a fresh account lands in the app; delete that account in-app (Apple re-auth passes).

## CI state
21:49 PDT: PR #748 @ f6b3e191 — 18/19 checks SUCCESS (build-and-test, test-deploy-readiness, schema parity, CodeQL, danger, live tests, actionlint, R75, audit), deploy-readiness-gate SKIPPED. Opening comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/748#issuecomment-6009561489 (READY FOR AUDIT).

## HANDOFF
- Done 21:50 PDT. PR #748 open at f6b3e1915c4ff49453ac06bd9958cbd18aa136c9, CI green, FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT.
- Next (operator): queue both lenses on #748 @ f6b3e191 (T3/T4 auth + production-env workflow). After APPROVE + merge, the production
  steps in "Operator steps after #748" need the owner's go (fly-env-sync apply, fly-apple-signin-set.yml, fly-env-truth, device pass).
- Owner decisions: (1) confirm the Supabase Apple provider Client IDs include com.growthproject.app (default: assume yes, check on the
  device pass); (2) go for fly-apple-signin-set.yml in the same window as the env-sync apply (recommended: yes, one window, two restarts).
- Worktree /home/user/workspace/wt/B-APPLE-123 removed; branch fix/apple-signin-manifest-123 is the PR head (keep). No ci/* or audit/* branches made.
- Evidence files: ops/aud-123/B-APPLE-123/env-truth-report.json, env-truth.md (value-free).
