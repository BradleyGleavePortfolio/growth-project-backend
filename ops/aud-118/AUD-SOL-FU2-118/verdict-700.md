AUDIT GPT-6.1 Sol — growth-project-backend#700 @ 66569a616fed254e2d5022bbc277013e4652788b — VERDICT: REQUEST CHANGES
A/B/C = 0/2/1

Independent T4 audit: AUD-SOL-FU2-118, agent 118; complete 24-file diff reviewed, 936 changed lines, with no candidate implementation edit. [Reviewed comparison](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/b644198b90bb9ab1dc62a78794e12cf09f8ace7c...66569a616fed254e2d5022bbc277013e4652788b)

## B-700-1 — replacing addresses does not make arbitrary error text safe

**File:line:** `src/observability/log-pii.ts:33-35`; `src/email/email.service.ts:182-188,231-240`; `src/notifications/digest.service.ts:166-168,227-229,451,478,503`; same new boundary at `src/storefront/checkout-recovery.service.ts:278-281`. [New helper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fobservability%2Flog-pii.ts), [email consumers](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Femail%2Femail.service.ts), [digest consumers](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fnotifications%2Fdigest.service.ts), [recovery consumer](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fstorefront%2Fcheckout-recovery.service.ts)

**Counterexample/proof:** a synthetic Resend 422 body containing `Invalid recipient Patricia Quill <patricia.quill@example.test>; private consultation details` loses the address but preserves the person's name and the private text in the emitted email log, `EmailSendLog.error` and `SendEmailResult.error`; DigestService also logs/stores the name/text, and a render exception retains them in its stored/returned error. Three independent assertions fail on these surfaces while the original privacy guard passes. [Executed exact-head probe 37218198321](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218198321)

**Minimal fix rule:** normalize provider/exception failures to server-owned diagnostic codes, stage, provider/HTTP status and opaque correlation IDs before logging, storing or returning them; do not preserve arbitrary body/message text through an email-only regex. Apply that rule at every new helper consumer and add name/free-text controls for provider, render and digest/checkout failures without changing send/idempotency behavior. [Affected helper consumers](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/b644198b90bb9ab1dc62a78794e12cf09f8ace7c...66569a616fed254e2d5022bbc277013e4652788b)

## B-700-2 — webhook “shape” still publishes attacker-controlled names

**File:line:** `src/scheduling/scheduling-webhook.controller.ts:95-108`, used by both handlers at `:60-61,84-85`; character/length regexes are not finite provider event/key allowlists. [Webhook source](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fscheduling%2Fscheduling-webhook.controller.ts)

**Counterexample/proof:** with the optional secret absent, both public stubs accept `{ event: "Patricia-Quill", "Patricia-Quill": { ... } }` and log `event=Patricia-Quill keys=event,Patricia-Quill`; both no-name assertions fail. This is a leak through the replacement logging implementation, not a request to implement the separate webhook integrations. [Executed probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218198321)

**Minimal fix rule:** log only finite, server-owned recognized event/key labels; map unknown event/key strings to a fixed label or numeric count without logging their contents, preserving the current no-op acknowledgment behavior. Re-run both public-handler probes and a recognized-event control. [Affected logging boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fscheduling%2Fscheduling-webhook.controller.ts)

## C-700-1 — outside this diff: encoded email in finance federation paths

**File:line:** `src/admin/federation/finance-admin.client.ts:89-95,165-167`; on a degraded `setCoachPracticeByEmail("pat@example.test", ...)`, the path log includes `/by-email/pat%40example.test/practice`, which remains personal data despite having no `@`. [Existing federation client](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src/admin/federation/finance-admin.client.ts)

**Fix rule:** operator tickets a separate finite-route-label/opaque-ID logging fix with an encoded-address regression; do not expand this frozen PR for the outside-diff C. The new identifier-pattern guard is useful but is not proof that all `src/` logs are PII-free. [Guard limitations](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/test%2Fprivacy%2Fno-pii-in-logs.spec.ts)

## Prior findings, Apple truth and evidence applicability

Prior Sol B-611-17 remains closed; original direct-recipient logging and old Apple-menu issues are improved, but the broader no-name/free-text boundary is incomplete as above. Existing unaffected deletion, page routing/rendering and Sentry/logger inputs are byte-identical to prior Sol-approved #611 `b09f2061` (account-deletion README terminology excepted); only that unchanged evidence is reused, not approval of the new runtime code. [Prior Sol attestation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5976633102), [current change](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/b644198b90bb9ab1dc62a78794e12cf09f8ace7c...66569a616fed254e2d5022bbc277013e4652788b)

The new iOS 18+ qualifier, distinct web route and Apple Account terminology match Apple's official current support article and versioned iPhone guides, and both public pages still share the same constant/link; no automatic revocation claim was added. [Apple Support 102571](https://support.apple.com/en-us/102571), [iOS 18 guide](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/18.0/ios/18.0), [iOS 17 guide](https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/17.0/ios/17.0), [changed shared copy](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/66569a616fed254e2d5022bbc277013e4652788b/src%2Fpublic-pages%2Ftrust-pages.html.ts)

## CI

Required contexts are **11/11 green** at the exact candidate SHA; full CI reports 729 passed suites, 23 skipped, 12,555 passed tests, 241 skipped and 5 todo. [Exact-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37181000501/job/111373393514)

The independent lane is deliberately red on the two findings: **5 failed / 26 passed**, with all three original control suites passing; its source is exact candidate + probe-only commit `adafb47e67a43173ce82741def003aa33011b397` + lane-only commit `59cdbd4ab439cad415c5fd9e91ec6bf49a05ec57`, not an implementation modification. [Probe run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218198321), [lane commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/59cdbd4ab439cad415c5fd9e91ec6bf49a05ec57)

The builder's failing-before run was independently checked (19 failed / 77 passed, plus the expected missing new helper module), and its test-only predecessor is on the stated base; no release, production deletion, device flow or vendor setting verification is claimed. [Builder before-run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180400375)
