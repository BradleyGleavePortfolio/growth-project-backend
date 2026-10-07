# B-EMAILFROM-126 — every TGP email actually sends (Claude Opus 5.5, builder, agent 126)

Start 18:33 PDT 10-06. Hard stop 19:25. Read on backend main f71bb9a4 (RO); built on origin/main 35c22212.

## Scope traced (every email sender in src)

| Sender | Path | From-address source (main) | Today |
|---|---|---|---|
| EmailService templates: coach invites client (invite-codes.service.ts:1349, single + bulk invite share it), payment receipt (storefront/checkout-receipt.service.ts:149), payment failed (billing.service.ts:1196), dunning v1 (checkout/dunning.service.ts:589, 1183), dunning v2 client + coach (dunning-v2.dispatcher.ts:260, 389), payout notice (checkout/payout-notice.service.ts:593), checkout recovery (storefront/checkout-recovery.service.ts:256), trial ending (packages/trials/trial-notice.service.ts:801), nudges (nudge-engine.service.ts:447), report alert (report-alert.service.ts:116) | src/email/email.service.ts:187 | `input.from ?? (EMAIL_FROM_ADDRESS \|\| '[redacted email]')`; no caller passes `from` | With EMAIL_TRANSPORT=resend, boot already requires EMAIL_FROM_ADDRESS (email.service.ts:337), so production uses the Fly value |
| Digests (client/coach daily, weekly) | src/notifications/digest.service.ts:420 own Resend/SendGrid/Postmark fetch | `EMAIL_FROM_ADDRESS ?? '[redacted email]'` | Same Fly value (present, non-empty); 6/6 rows failed 403. All ran before the owner verified the domain (crons 06:00/07:00 UTC = 23:00/00:00 PDT; verified ~12:02 PDT 10-06). 10-02..04 errors name growthprojectapp.com, so the Fly value is on that domain |
| Guest-checkout welcome (activation invite link) | src/storefront/guest-checkout.service.ts:2010 own Resend fetch | `RESEND_FROM_EMAIL ?? 'Growth Project <[redacted email]>'` (separate env, prodHardened) | Present and non-empty on Fly (Env Truth); value not read. Failure would only show as Fly log `Resend send failed (status=403) for <checkout id>` (no EmailSendLog row) |
| Auth: sign-up confirm, password reset (auth.service.ts:1494 resetPasswordForEmail), pair redeem generateLink | Supabase | Supabase custom SMTP settings (owner saved Resend SMTP, growthprojectapp.com sender, 12:24 10-06) | Not backend env |
| Data export SMTP_FROM | src/data-export/README.md:132 only | Doc only; no code sends | n/a |
| Support | SUPPORT_EMAIL = owner gmail (public-pages/trust-pages.html.ts:31) | Contact address, not a sender | n/a |

## B list
- None verified. Operator correction (19:33): Fly Env Truth confirms BOTH EMAIL_FROM_ADDRESS and RESEND_FROM_EMAIL present and non-empty, and the prior digest failures happened BEFORE the owner verified the domain. No current sender is claimed wrong.

## U list
- U-EF-1: the sender lived in three places with three defaults and silent wrong-domain fallbacks. FIXED in b#819 with one resolver (src/email/email-sender.ts). A live transport with no valid sender sends nothing and logs a line naming EMAIL_FROM_ADDRESS. Boot logs `outbound sender domain=<d> transport=resend`.
- U-EF-2: the guest welcome email read a second env name (RESEND_FROM_EMAIL) with a trygrowthproject.com fallback, so it could drift from the other emails. Its value was not read and is not claimed wrong. FIXED in b#819: it now uses EMAIL_FROM_ADDRESS.

## C one-liners
- C: digest.service.ts:47-49 APP_URL / CONSOLE_URL default to thegrowthproject.app hosts when unset (links in digests); check they are set on Fly (not traced further).
- C: guest welcome email ignores EMAIL_TRANSPORT=log (sends whenever RESEND_API_KEY is set) — dev only.
- C (edge, deferred to 10k clients): digest logs the sender error once per recipient on misconfig.

## Covered by open PRs
- None. b#816 (now merged) edited other hunks of guest-checkout.service.ts; main merged cleanly.

## PRs opened
- backend b#819 `agent126/b-emailfrom-126`, head 1fcd9330c76e5629db4f06cd49b49d9f397a9c53, 323 changed lines (12 files).
  - Push 1 (5c5e5957): build-and-test red from this change: s-fee-r19-refund-cas-send-window patches transportKind='resend' onto a log-built EmailService, and the per-send resolver threw.
  - Push 2 (ce6685bb): EmailService resolves the sender once at boot. build-and-test red from main moving: b#816 merged with a new test (b-guest-126-guest-checkout-claims) whose config has no sender.
  - Push 3 (e63a5bba): main merged in, that test's config gets EMAIL_FROM_ADDRESS. All 16,301 tests green; build-and-test step "Env validation (simulated prod env)" red because EMAIL_FROM_ADDRESS had been added to prodHardenedFeatureVars and ci.yml's simulated prod env lacks it.
  - Push 4 (1fcd9330): EMAIL_FROM_ADDRESS taken back out of prodHardenedFeatureVars (EmailService's resend boot check is the gate, as before); RESEND_FROM_EMAIL stays out. No workflow edit. CI: see HANDOFF.

## Env the operator must stage (names and values only)
- EMAIL_FROM_ADDRESS = `The Growth Project <[redacted email]>` -> manifest `secrets.EMAIL_FROM_ADDRESS: "github-secret"` + GitHub Actions secret EMAIL_FROM_ADDRESS with that value + both env blocks in .github/workflows/fly-env-sync.yml (lines ~166 and ~290, like GOOGLE_CLIENT_IDS). ("present" would only check existence.)
- EMAIL_TRANSPORT = `resend` -> `secrets.EMAIL_TRANSPORT: "present"` (already on Fly).
- RESEND_API_KEY -> `secrets.RESEND_API_KEY: "present"` (already on Fly).
- RESEND_FROM_EMAIL -> retired; `"unset"` ONLY after b#819 is deployed (until then prod boot requires it). Optional.
- Optional follow-up (operator): add EMAIL_FROM_ADDRESS to prodHardenedFeatureVars together with the ci.yml simulated-prod env line, if a boot gate independent of EMAIL_TRANSPORT is wanted.

## Not fixed (needs operator)
- Confirm after tonight's 23:00 PDT coach digest (06:00 UTC 10-07) that the NotificationDigestLog row is `sent`. If it fails with 403 validation_error again, the Fly EMAIL_FROM_ADDRESS is not on growthprojectapp.com or the Resend API key belongs to a different Resend team than the verified domain: owner checks Resend > Domains (status Verified) and API Keys (same team, Full or Sending access for that domain).
- Stage the env above (operator flag PR + fly-env-sync), then deploy b#819.

## HANDOFF
- DONE 19:34 PDT. b#819 head 1fcd9330c76e5629db4f06cd49b49d9f397a9c53: CI 15 SUCCESS + 1 SKIPPED, 323 lines, mergeable clean. READY comment posted: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/819#issuecomment-6029681790
- Note for the operator: e63a5bba was NOT green (the "Env validation (simulated prod env)" step was red). The green head is 1fcd9330.
- Worktree removed after a clean check. No ci/* branches were created. PR body: /home/user/workspace/ops/reports/B-EMAILFROM-126-pr-body.md.
- Next (operator): audit b#819; the flag PR stages the env listed above; check the NotificationDigestLog row from the 23:00 PDT 10-06 coach digest.
