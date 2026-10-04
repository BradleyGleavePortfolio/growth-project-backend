# B-PRIVFU2-118 (builder, agent 118 wave) — backend #700 + mobile #368

Started 10:16 PDT 10-04 (from `TZ=America/Los_Angeles date`). Notes and scan script: ops/aud-118/B-PRIVFU2-118/.

## Backend #700 (branch b-privfu-117/no-email-in-logs)
Open findings at 66569a61 (both lenses RC): Sol B-700-1 (provider/exception text keeps names and free text), Sol B-700-2
(webhook event/key tokens), Sol C-700-1 (finance path, = Opus B-700-2b); Opus B-700-1 (coach name in coach-brief logs; guard
misses camelCase), Opus B-700-2 (Supabase reset/generateLink echo the address; finance path), Opus C-700-2 (raw exception
text), C-700-3 (redactEmailAddresses keeps names), C-700-5 (webhook allow-list). Out of round: Opus C-700-1 (owner reason,
needs migration), C-700-4 (calorie values).

Commits:
- 64ad9438 merge main 2af682ca (clean, merge-only).
- 6946f0b9 tests only (failing-before): test/privacy/log-pii.spec.ts (rewritten for describeFailure/ProviderFailure),
  test/privacy/no-pii-probe-replays.spec.ts (new: every Sol and Opus probe shape + controls),
  test/privacy/no-pii-in-logs.spec.ts (expectations to codes; guard: person-name token inside identifiers, path rule,
  exception-text rule with LEGACY_EXCEPTION_TEXT baseline of 141 files / 306 calls that must match exactly),
  test/email.service.spec.ts (code instead of body).
- d8ee379f fix: src/observability/log-pii.ts (describeFailure, ProviderFailure, providerErrorCode; redactEmailAddresses
  removed), email.service, email.types, digest.service, checkout-recovery, auth.service (11 log sites), notifications.service
  (4), coach-brief (coach id/mode/date; describeFailure), finance-admin.client (route labels), scheduling webhook (finite
  event/key lists), gdpr-scrub service+scheduler, account.service (log + audit metadata), observability README.

CI-lane runs:
- failing-before 37221266107 (test commit + 4 lens probe specs verbatim): 8 suites failed, 43 failed / 21 passed.
- after: 37222059865 (fix + lens probes + 20 affected suites) — pending.

Size: 2,009 changed lines vs main (669 non-test, 1,340 test) -> 1,500-3,000 band, operator SIZE ASSESSMENT.

## Mobile #368 — in progress

## Follow-ups (C)
- C-700-2 remainder: 306 legacy log calls in 141 files still print exception text (list = LEGACY_EXCEPTION_TEXT in
  test/privacy/no-pii-in-logs.spec.ts). Fix rule: replace with describeFailure(err[, module codes]) file by file and lower the
  baseline; behaviour change for ops (codes instead of messages), so a separate PR.
- Opus C-700-1 (owner free-text reason in coach-ai-budget logs; needs migration) and C-700-4 (kcal values in macros/coach-ai
  logs): untouched, per job entry.

## HANDOFF
- #700: head d8ee379f pushed 10:5x PDT; waiting for required checks and the after-lane; then FIX ROUND 2 comment + body.
- #368: not started.
