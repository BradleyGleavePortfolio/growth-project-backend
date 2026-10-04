## Tier
- **Tier:** T4 (from round 2; assigned by operator 118 for job B-PRIVFU2-118)
- **Why:** G12 privacy. Log lines in auth, email, digest, push, storefront recovery, coach alerts, practice type, the scheduling webhook stub and the talent-marketplace audit events wrote email addresses, names or free text. The published `/privacy` and `/help/delete-account` Sign in with Apple steps were correct on iOS 18 and later only.
- **T4 trigger scan (round 2):** the email send path now throws `ProviderFailure` and stores code strings in `EmailSendLog.error` and `SendEmailResult.error`; the auth service's Supabase and verifier error log lines change. No auth decision, idempotency key, send condition, RLS, migration, schema, payment logic, CI gate file, workflow, env, dependency or lockfile change. **Round 0 scan:** none. No auth decision changes: three `warn` lines in `auth.service.ts` change text only; the refusal and the exception are unchanged. No RLS, migration, schema, payment logic, CI gate file, workflow, env, dependency or lockfile change. All 11 required check names are untouched.
- **T3 trigger scan:** G12 (log content, plus the stored `EmailSendLog.error` and `notification_digest_log` error text, which are now redacted), and public legal copy (the shared `SIGN_IN_WITH_APPLE_DELETION_TEXT`).
- **Bounded T1:** NO (privacy).
- **Canonical builder:** Claude Opus 5.5 (job B-PRIV-FU-117, operator 117); round 2 job B-PRIVFU2-118 (operator 118).
- **Parent owner:** operator 117. Follow-up to #611 findings C-611-17 and C-611-18 (`ops/reports/AUD-OPUS-PRIV3-117.md`).
- **Acceptance evidence:** failing-before CI-lane run at the test-only commit `af5b6f20`, a passing CI-lane run at the fix head, and all 11 required checks green at the head named in the READY comment. Round 2: failing-before run 37221266107 at `6946f0b9`, passing run 37222059865 at `d8ee379f`, 11/11 at `5e3dabb0`.
- **Promotion triggers:** T4 if a later round changes auth decisions, email idempotency or send logic, or the deletion flow. Re-grade if the Apple copy is changed to claim that deletion revokes Sign in with Apple.

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `a634aaef` | Initial PR (tests `af5b6f20`, fix `a634aaef`) |
| 1 | `66569a61` | Own CI: `test/deploy-readiness.spec.ts` stub scanner flags the token PLACEHOLDER in `src/`, so `EMAIL_PLACEHOLDER` is renamed `REDACTED_EMAIL` (same value); two CodeQL test-file alerts cleared (bare host name in `includes()`, template syntax in a guard sample) |
| 2 | `5e3dabb0` | Sol RC 0/2/1 and Opus RC 0/2/5 at `66569a61`: merge `main` `2af682ca`; tests `6946f0b9`, fix `d8ee379f`, R75 test fix `5e3dabb0`. `describeFailure` and `ProviderFailure` replace `redactEmailAddresses` (B-700-1, C-700-2, C-700-3); coach brief logs the coach id, not the name (Opus B-700-1); Supabase reset and generateLink errors log status and code, and finance federation logs a route label (Opus B-700-2, Sol C-700-1); webhook stubs log known labels only (Sol B-700-2, C-700-5); guard catches camelCase name tokens, address paths and exception text (per-file legacy baseline) |

## Findings
| Finding | Problem on `main` `b644198b` |
|---|---|
| C-611-17 | `email.service.ts` logged `to=<address>` and the rendered subject (first names), and the provider error body (which echoes the address) was logged, stored and returned. `digest.service.ts` logged `to=<address> subject=...`, and the Resend/SendGrid/Postmark error bodies were stored and logged as they came back. A static scan of every log call under `src/` found 17 such sites (list below). |
| C-611-18 | The policy said "on your iPhone open Settings, tap your name, then Sign in with Apple". That path exists on iOS 18 and later only; the app supports iOS 16.4 and later, where the menu is under Settings > [your name] > Password and Security (iPhone User Guide 16.0 and 17.0). |

## Changes
**C-611-17.** Each site logs a stable id or a code instead:

| Site on `main` | Before | After |
|---|---|---|
| `email/email.service.ts:195` | `to=<address> subject="<subject>"` | `row=<EmailSendLog id>` |
| `email/email.service.ts:215` | `to=<address>` | `row=<id>` |
| `email/email.service.ts:226` (and render error) | `to=<address>: <provider body>` | `row=<id>: <redacted body>`; stored and returned error redacted too |
| `notifications/digest.service.ts:423` | `to=<address> subject="<subject>"` | `user=<id> template=<key>` |
| `notifications/digest.service.ts` provider errors, both catch blocks | provider body stored and logged | redacted before it is stored or logged |
| `auth/auth.service.ts:1045, 1240` | `email=<address>` | `supabase_id=<id>` |
| `auth/auth.service.ts:1783` | `promoted <address> (id=...)` | `promoted user <id>` |
| `notifications/notifications.service.ts:689, 744` | Expo `message` (quotes the push token) | Expo error code (`details.error`); `detail` returns the code |
| `storefront/checkout-recovery.service.ts:235, 276` | first 3 characters of the address; raw error | `checkout=<id>`; redacted error |
| `coach/coach-alerts.service.ts:249` | alert `message` (names the client) | `alert=<id>` |
| `coach/practice-type/practice-type.service.ts:105` | coach address | `coach=<id>` |
| `scheduling/scheduling-webhook.controller.ts:59, 83` | the whole payload (Zoom participant name and address) | `event=<event> keys=<top-level keys>`, never a value |
| `talent-marketplace/admin-applications.service.ts:144`, `admin-moderation.service.ts:138` | the owner's note text | `note_length` (the note stays on the ledger row) |

New `src/observability/log-pii.ts`. **Round 2 (current):** `redactEmailAddresses` is gone, because removing addresses left names and free text (Sol B-700-1). `describeFailure(err)` logs only the error class, HTTP status and a code from a finite list; email and digest providers throw `ProviderFailure` (`provider=<p> status=<n> code=<c>`). The `<redacted body>` and "redacted error" cells above now read as these codes. The webhook stubs log `event=<known event or other or none> keys=<known keys or none> other_keys=<n>`. `src/observability/README.md` records the rule.

**C-611-18.** The shared sentence now reads: "To remove the app from your Apple Account as well, on an iPhone with iOS 18 or later open Settings, tap your name, then Sign in with Apple, choose the app, tap Delete and follow the steps on screen to confirm. On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose the app and stop using Sign in with Apple for it." Both pages still link [Apple Support 102571](https://support.apple.com/en-us/102571). Procedures section 0 (`docs/privacy/vendor-deletion-and-backups.md`) records the iOS 18.0 and 17.0 guide pages and the iOS 16.4 floor. `src/account-deletion/README.md` says "Apple Account".

## Tests (written first, commit `af5b6f20`)
- `test/privacy/no-pii-in-logs.spec.ts`: spies on every `Logger` level and drives EmailService (log transport, Resend success, Resend 422 that echoes the address), DigestService (log transport, Resend 422), CoachAlertsService, PracticeTypeService and both webhook stubs with a known address and name; no log line, stored error or returned error may hold `@`, the address or the name, and each line must name the id instead. A static guard reads every log call under `src/` (more than 500) and fails on an address, recipient, name or free-text interpolation. It found exactly the 17 sites above on `main` and none after.
- `test/privacy/log-pii.spec.ts`: `redactEmailAddresses` unit tests.
- `test/privacy-apple-ios-version.spec.ts`: the iPhone sentence says "iOS 18 or later" before "open Settings"; the earlier-version sentence is the web path only; no old menu names on the pages; procedures section 0 names iOS 18, iOS 16.4 and the 17.0 guide.
- `test/privacy-apple-unlink-path.spec.ts`, `test/privacy-round8-retention.spec.ts`: sentence pins updated.
- `admin-applications.service.spec.ts`, `admin-moderation.service.spec.ts`: the audit event carries `note_length` and no `note`, and no log call holds the note text.

## Out of scope (noted for the operator)
- Prisma validation errors can quote query arguments, and many `catch` blocks log `err.message`. Round 2 fixes the files this PR touches. The other 306 calls in 141 files are pinned by `LEGACY_EXCEPTION_TEXT` in `test/privacy/no-pii-in-logs.spec.ts`, which only shrinks; they are left to a separate PR.
- `macros.service.ts:95` logs calorie targets, and exercise names appear in some log lines. Health-adjacent but not addresses or names; a separate decision.

