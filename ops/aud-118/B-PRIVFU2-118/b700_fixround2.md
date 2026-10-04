FIX ROUND 2 (B-PRIVFU2-118, agent 118) — growth-project-backend#700 @ 5e3dabb0d0b9adc3ecf53c06f7bccf11852745fb

Closes both lenses' request-changes reviews at `66569a61`: Sol 0/2/1 and Opus 0/2/5. This round fixes every B, plus C-700-2, C-700-3 and C-700-5 as the job entry asks. Sol's C-700-1 is the same as Opus's B-700-2 finance-path finding and is fixed with it. Opus C-700-1 (needs a migration) and C-700-4 are not in this round; they are in the report's follow-ups.

Commits on top of `66569a61`:
- `64ad9438` merges `main` `2af682ca` (clean, merge only).
- `6946f0b9` tests only (failing-before).
- `d8ee379f` the fix.
- `5e3dabb0` one test assertion. The forgotPassword replay checks the unchanged reply instead of swallowing a rejection, because R75 counted a new `.catch(() => undefined)`.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test (failing before, passing after) |
|---|---|---|---|
| Sol B-700-1 / Opus C-700-3: provider text in error logs kept names and free text after the address was removed (email render and send, `EmailSendLog.error`, `SendEmailResult.error`, digest failure rows, checkout recovery) | `src/observability/log-pii.ts`: `redactEmailAddresses` removed. `describeFailure(err)` prints only `error=<class> [status=] [code=] [claim=]`. Codes come from a finite list: Supabase Auth, jose `ERR_*`, Node and undici network codes, Prisma `P####`, plus module codes. Anything else is `other`, and the function never throws. Email and digest providers throw `ProviderFailure` (`provider=<p> status=<n> code=<c>`). The code is a documented Resend error name or `postmark_<n>`; any other value becomes `other`, `unparsed` or `missing_id`. | `d8ee379f` | `test/privacy/log-pii.spec.ts`, `test/privacy/no-pii-probe-replays.spec.ts` (Sol B-700-1 replay), `test/privacy/no-pii-in-logs.spec.ts`, `test/email.service.spec.ts` |
| Opus C-700-2: raw exception text in log lines | Every log line in the files this PR owns now uses `describeFailure`: auth.service (11 sites), notifications.service (4), email, digest, checkout-recovery, coach-brief, gdpr-scrub service and scheduler, and account.service (the log line and the export audit metadata). The static guard has a new `exception-text` rule. The 306 older calls in 141 other files are pinned in `LEGACY_EXCEPTION_TEXT`, which must match exactly, so the baseline can only go down. A test checks that no file fixed here is on that list. | `d8ee379f` | guard self-tests and `no-pii-in-logs.spec.ts` |
| Opus B-700-1: coach-brief logs the coach's full name (`safeCoachName`), and the guard missed camelCase | `coach-brief.service.ts`: the four log lines use `coach=<id> mode=<mode> date=<date>`. `errorMessageOf` is replaced by `describeFailure(err, BRIEF_ERROR_CODES)`. The guard now finds a person-name token inside identifiers (`safeCoachName`, `clientDisplayName`). | `d8ee379f` | Opus B-700-1 replay, guard self-test `safeCoachName` |
| Opus B-700-2a: Supabase error text echoes the address (`auth.service.ts` :879 generateLink, :1474 resetPasswordForEmail) | Both lines log `describeFailure(error)`, for example `error=Object status=400 code=email_address_invalid` | `d8ee379f` | Opus B-700-2 replay (forgotPassword) |
| Opus B-700-2b / Sol C-700-1: finance federation logs the request path, which holds the URL-encoded address | `finance-admin.client.ts`: the request methods take a fixed `FinanceRoute` label and log `route=<label>`. The guard has a new `path` rule for files that put an address into a URL. | `d8ee379f` | Opus B-700-2 replay (degraded + user search) |
| Sol B-700-2 / Opus C-700-5: webhook stubs log tokens the attacker controls as the event and key names | `scheduling-webhook.controller.ts`: `event=<known Zoom/Google event or other or none> keys=<known keys or none> other_keys=<n>` | `d8ee379f` | Sol B-700-2 replay plus a control (a recognised Zoom event is named) |

## Lens probes replayed (each one verbatim, at the fix head)

| Probe | At `66569a61` | At fix `d8ee379f` |
|---|---|---|
| Sol `audit-sol-fu2-118-boundary.spec.ts`: EmailService provider failure with a display name and free text | fail | pass |
| Sol: EmailService render exception that quotes the recipient name | fail | pass |
| Sol: DigestService provider failure with a name and free text | fail | pass |
| Sol: Resend body with an address across the old 500-character cut | pass | pass |
| Sol: zoom, crafted event name and key | fail | pass |
| Sol: googleCalendar, crafted event name and key | fail | pass |
| Sol: the other 25 tests in the same file (controls) | pass | pass |
| Opus `aud-opus-fu2-118-coach-name-probe.spec.ts`: Claude call error | fail | pass |
| Opus coach-name: contract failure twice | fail | pass |
| Opus `aud-opus-fu2-118-reset-email-probe.spec.ts`: forgotPassword with a Supabase error that echoes the address | fail | pass |
| Opus `aud-opus-fu2-118-finance-path-probe.spec.ts`: degraded log line | fail | pass |

- Failing before: CI-lane run [37221266107](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221266107). It ran the test-only commit `6946f0b9` plus the 4 lens probe specs, copied verbatim. Result: 8 suites failed; 43 tests failed and 21 passed.
- Passing after: CI-lane run [37222059865](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222059865). It ran fix `d8ee379f` plus the same 4 probe specs and 20 neighbouring suites (auth, apple, recent-auth, coach-brief, digest, checkout-recovery, finance-admin client, finance federation, gdpr-scrub, account, invite bulk email, deploy-readiness, notifications, google-calendar webhook). Result: 28 suites passed; 388 tests passed and 16 skipped.
- At this head, all 11 required checks are green. [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222341084/job/111495055067): 731 suites passed, 23 skipped; 12,592 tests passed, 241 skipped, 5 todo. R75: no positive token change.

## Money list (one line each)
- Webhook order and redelivery: N/A. The scheduling webhook stubs only acknowledge and log; handling is unchanged.
- Concurrency: N/A. Only log and diagnostic text changed; no state machine or transaction was touched.
- Terminal states: N/A. Email and digest still reach `failed` on the same paths; only the stored diagnostic text changed.
- List pagination: N/A.
- Currency: N/A.
- Copy truth: no user-facing copy changed. `SendEmailResult.error`, which can reach the coach invite response as `email_error`, is now a code string, for example `provider=resend status=422 code=validation_error`.

## Pre-push checklist
- Logs: no free text, address, name, token or path. The guard covers every log call under `src/`; older exception text is held by the exact-match baseline.
- Await and state-write identity recheck: N/A (no new async state writes).
- Unmount races: N/A (backend).
- Copy rules: kept (no first person, emoji or exclamation marks in the new strings).
- Failing-before test for every finding: yes (see above).
- Size: 2,012 changed lines (1,858 added, 154 removed; 669 non-test, about 1,340 test). This is in the 1,500–3,000 band, so it needs operator SIZE ASSESSMENT. About two-thirds is tests: the probe replays, guard self-tests and the 141-line legacy baseline.

READY FOR AUDIT
