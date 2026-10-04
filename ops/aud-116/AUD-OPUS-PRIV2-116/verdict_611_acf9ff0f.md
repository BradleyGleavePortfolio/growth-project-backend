AUDIT Claude Opus 5.5 — growth-project-backend#611 @ acf9ff0f30117f6ea4ea00e79fccbd1fbfc0ad98 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/1

Job AUD-OPUS-PRIV2-116 (agent 116 wave). Tier T4 (public privacy/legal text, deletion guarantees). Scope: FIX ROUND 8 (`5eac8f21..357c40fe`, audited line by line) plus the operator's update-branch to `acf9ff0f` (main `a5b605d1`, #664 + #652), audited as a merge-only delta. The head moved while I was auditing `357c40fe`, so this verdict is posted at the current head and covers both.

## 1. Prior Opus findings at `5eac8f21` (verdict 5975902540): all closed

| ID | Status | Evidence |
|---|---|---|
| B-611-10 (help page "What we keep" shorter than /privacy) | **Closed** | `help-pages.html.ts:720-731` now lists the closed-account record, the provider ID during retries, the 30-day one-way code, Anthropic's 30 days, the Sentry/Resend/PostHog windows and de-identified data. All come from the shared constants `CLOSED_ACCOUNT_RECORD_TEXT`, `ONE_WAY_CODE_TEXT`, `ANTHROPIC_RETENTION_TEXT` and `DEIDENTIFIED_TEXT` (`trust-pages.html.ts:53-69`). My lens's probe B-611-10a/b/c, which failed at `5eac8f21`, passes at `357c40fe` ([run 37174293546](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174293546)). |
| B-611-11 (dump steps had no deletion rule) | **Closed** | `docs/deploy-runbook.md` §2 step 3 and §3 step 1 now state the §1.1 rules and link §1.1; the anchor `#11-our-own-database-dumps-operator-held-copies` resolves. "S3 bucket, etc." is gone. The BCP weekly export points to §1.1 and requires noncurrent-version expiry. §1.1 matches the runbook. Probe test B-611-11 passes. |
| C-611-12 (= Sol B-611-7, email in crash reports) | **Closed** | The bullet now says "linked to your account ID, with no name or email address attached". That is true of the code: on mobile main `367e6c48`, `setSentryUser` sets `{ id }`, `scrubEvent` reduces the user to `{ id }`, breadcrumbs are scrubbed and `sendDefaultPii: false`. The backend `beforeSend` allow-list (`sentry-config.ts:139-195`) carries no `user`. |
| C-611-13 (Mux device data) | **Closed** | True of the code. Only direct uploads are used (`mux.service.ts:84-103`), playback goes to `stream.mux.com` directly, and there is no Mux Data SDK in mobile. |
| C-611-14 (PostHog asynchronous deletion) | **Closed** | The owner deadline is now 21 days, inside the published 30 (procedures §8/§9). |
| C-611-15 (RCW "process") | **Closed** | Both policies and the help page say "keep and use". |
| C-611-16 (absolute "kept while open") | **Closed** | The sentence now opens "Unless a shorter period is listed above"; the retention list does sit above it. |
| RG-1 (Apple revocation) | **Resolved per the operator ruling** | No policy page says "revoke" (checked with grep and pinned by the RG-1 test). "Deleting your account ends the app's link to your Apple ID" is true. Apple's `sub` exists only in the Supabase identity, which finalization deletes and retries (`account-deletion.service.ts:639-663, 869-915`). The backend stores no Apple refresh token (`apple-token-revocation.service.ts:7-10`). |

Other checks:
- **Approved paragraph (O-611-1).** Programmatic check: rendering the new concatenation and removing only the Apple sentence gives a string byte-identical to `5eac8f21` with the old Apple sentence removed.
- **Consumer health "Deletion" paragraph.** Byte-identical: the Anthropic sentence is now taken from the shared constant.
- **Failing-before run.** [Run 37172439577](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172439577) is genuine. Commit `09c637f5` = `783bf2d2` plus the lane files only, and `783bf2d2` = `aeb3b438` plus the two specs only. Result: 17 failed, 10 passed.
- **Merge `aeb3b438`.** It is pure: tree `9decfbd2` equals `merge-tree(5eac8f21, d23fa317)`.

## 2. New finding in this round's diff

**B-611-12. The new Sign in with Apple sentence gives an iPhone path that Apple's current iOS does not have.**

- **Where.** `src/public-pages/trust-pages.html.ts:80-81` (`SIGN_IN_WITH_APPLE_DELETION_TEXT`, rendered in /privacy "Deleting your account"). It says: "on your iPhone open Settings, tap your name, then Sign-In & Security, then Sign in with Apple, choose the app and stop using it with your Apple ID".
- **Counterexample.**
  - Apple's iOS 26 iPhone User Guide ([Sign in with Apple on iPhone](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/26/ios/26)) gives: "Tap your name, then tap Sign in with Apple ... Stop using Sign in with Apple: Tap Delete, then tap Stop Using." In iOS 26, Sign-In & Security is used only for the Hide My Email "Forward To" setting.
  - The iOS 18.0 guide gives the same path. So does Apple Support [102571](https://support.apple.com/en-us/102571) (updated 2026-09): "On your iPhone, open the Settings app, then tap [your name]. Tap Sign in with Apple. Select the app or developer, then tap Delete."
  - Sign-In & Security, then Sign in with Apple, is the path only on the web (account.apple.com).
  - Apple has called the account "Apple Account", not "Apple ID", since iOS 18.
  - Result: a person on a current iPhone who follows the published sentence does not find the setting.
- **Why B.** This is the sentence the operator ruling introduced so that the policy "states what is true today". The RG-1 test calls it "the true path". On the current OS the path is not true, and the job's bar is that every published sentence must be true of the vendors.
- **Minimal fix rule.**
  1. Use one shared constant for both `SIGN_IN_WITH_APPLE_DELETION_TEXT` and the `/help/delete-account` closing at `help-pages.html.ts:673`. The help-page line carries the same stale path; it is pre-existing, but it must match.
  2. Give Apple's current iPhone path. For example: "To remove the app from your Apple Account as well, on your iPhone open Settings, tap your name, then Sign in with Apple, choose the app, tap Delete and confirm." The web path (account.apple.com, Sign-In & Security, Sign in with Apple) may be added.
  3. Keep the first sentence ("ends the app's link"). Make no revocation claim.
  4. Pin both rendered sentences in a spec that also asserts neither page gives "Sign-In & Security, then Sign in with Apple" as an iPhone path. The spec must fail at `acf9ff0f`.
- **How to verify.** Read the rendered /privacy and /help/delete-account text against Apple Support 102571. The new pin fails before and passes after. The RG-1 no-"revoke" test still passes.
- **Nit, same edit (not counted).** The header of `test/privacy-diagnostics-disclosure.spec.ts:3` cites "Claude Opus C-611-10"; it should be C-611-12.
- **Cross-PR (not blocking #611).** Mobile `src/screens/settings/DeleteAccountScreen.tsx:88` (`APPLE_FALLBACK`, mobile main `367e6c48`) has the same stale path. It needs its own mobile copy fix; #315 does not touch it.

## 3. C finding (outside this diff)

**C-611-17. The recipient email address is written to application logs on every send.**
- **Where.** On main `a5b605d1`, and therefore at this head:
  - `src/email/email.service.ts:196` (`[email:log] to=${input.to}`);
  - `src/email/email.service.ts:216` (`email sent ... to=${input.to}`);
  - `src/email/email.service.ts:227` (`email send failed ... to=${input.to}`);
  - `src/notifications/digest.service.ts:423`.
- **Problem.** Fly log retention is still unverified (procedures §9). A deleted person's address therefore survives in logs that the "We keep only what we must" paragraph does not name beyond "security and audit logs". It also breaks the wave rule that no emails reach logs.
- **Fix rule.** In a separate backend PR, log the template, the provider id and the recipient user id or a keyed hash, never the address. Add a spec that these log lines contain no "@".

## 4. Merge-only delta `357c40fe..acf9ff0f` (operator update-branch, main `a5b605d1`)

- **Purity.**
  - The parents are `357c40fe` and `a5b605d1`.
  - Tree `01137042` equals `git merge-tree --write-tree 357c40fe a5b605d1`. The merge is clean, with no conflict hunks.
  - The files main changed since `d23fa317` and the files #611 changed do not overlap.
  - `git diff a5b605d1 acf9ff0f` is exactly the PR content (17 files, +2500/-243).
- **What main brings.**
  - #664: the multer 2.4.0 bump (package.json, lockfile, one spec).
  - #652 (UGC round 5):
    - voice-note soft delete and erasure recording are now in one transaction;
    - a completed erasure row that is re-opened starts with a clean failure count;
    - migration `20270301000000_community_win_coach_matcher`, a function and policy change only.
  - No new vendor, data category, telemetry field or public-page change arrives.
  - The deletion paragraph's voice-note and community claims still hold; erasure is stronger.

## 5. State and evidence reuse

- **CI.**
  - `357c40fe`: 11/11 required checks green. The first build-and-test attempt hit the known out-of-memory flake; the rerun was green.
  - `acf9ff0f`: when this verdict was posted, 5 checks had passed and 6 were pending. The operator has not yet posted its merge-only ready comment.
  - This verdict does not depend on CI: B-611-12 stands at any green.
- **Probe.**
  - [Run 37174293546](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174293546) ran on `357c40fe` plus my lens's probe spec only.
  - It ran three suites: `audit-opus-611-retention-probe`, `privacy-round8-retention` and `privacy-diagnostics-disclosure`. All 25 tests passed.
  - The audit branch is deleted after the run; the run URL still works.
- **Evidence reuse (G09).**
  - Policy text unchanged since `5eac8f21` rests on this lens's audit at `5eac8f21`, which re-confirmed O-611-1..6, and on its APPROVE at `1af96efa`.
  - Every line changed in `5eac8f21..acf9ff0f` was read here.
  - Nothing was copied from the other lens.

## 6. Next step

The builder fixes B-611-12, which is a single copy constant plus a pin, and posts a FIX ROUND with a failing-before run. C-611-17 and the mobile `APPLE_FALLBACK` copy are operator queue items. Mobile #315 links `https://app.trygrowthproject.com/privacy` and `/consumer-health-privacy`, the exact routes #611 serves; it waits for its merge-only refresh.
