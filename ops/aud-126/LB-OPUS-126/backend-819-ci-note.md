b#819 @ 5c5e5957: CI build-and-test FAILED (run 37559037109, job 112591881346). The failing test is
test/s-fee-r19-refund-cas-send-window.spec.ts:470, "EmailService: a send-log insert that returns past the claim never reaches the provider":
expected status 'failed' with 'aborted before send', got 'sending'.
The PR caused it: the fixture builds EmailService with config.get -> undefined and then forces transportKind 'resend' (spec :55-57), so the new
resolveEmailSender throws EmailSenderConfigError. Fix: set EMAIL_FROM_ADDRESS in that fixture.
Not reachable in production, because the resend boot check needs a valid sender.
If READY is posted at this head with this check red, the verdict is REQUEST CHANGES naming build-and-test.

e63a5bba (19:20 PDT): build-and-test FAILED again (job 112597387782). This time all 922 test suites pass, but the step
`node -e "require('./dist/common/env-validation').assertEnv()"` (NODE_ENV=production CI env) throws ENV_PROD_HARDENED_MISSING for EMAIL_FROM_ADDRESS.
The CI workflow env still sets RESEND_FROM_EMAIL but not EMAIL_FROM_ADDRESS. The PR caused this by moving the prod-hardened var.
Fix: add EMAIL_FROM_ADDRESS to that workflow env, and check any deploy pre-check that uses a static env.
Production Fly already has EMAIL_FROM_ADDRESS (Deployed), so this is CI only.
If READY is posted at e63a5bba, the verdict is REQUEST CHANGES naming build-and-test (assertEnv step).
