Tier: T3
Why: every customer email (receipts, invites, dunning notices, digests, guest welcome with the account invite link) depends on the From address being on the Resend-verified domain; before this PR two env names held the sender and two code paths fell back silently to unverified domains.
T4 trigger scan: none (no auth, RLS/tenancy, PII, money movement, credential or destructive-data change; the sender address is not a secret). The retired RESEND_FROM_EMAIL leaves prodHardenedFeatureVars; the production sender gate stays where it already is: EmailService refuses to boot EMAIL_TRANSPORT=resend without a valid EMAIL_FROM_ADDRESS (now also checks the address shape).
T3 trigger scan: core flow (email delivery for pay, invite and guest-checkout sign-in).
Bounded T1: NO (touches four senders and the boot env gate).
Canonical builder: Claude Opus 5.5 (B-EMAILFROM-126, agent 126)
Parent owner: agent 126 (operator)
Acceptance evidence: test/b-emailfrom-126-sender.spec.ts (10 tests; 4 fail on main: digest sent from [redacted email] with EMAIL_FROM_ADDRESS unset, guest welcome used RESEND_FROM_EMAIL over EMAIL_FROM_ADDRESS, guest welcome sent from [redacted email] with no sender set, EmailService booted the resend transport with a malformed sender). Local targeted runs green: b-emailfrom-126-sender, email.service, s-fee-r19-refund-cas-send-window, support-email.guard, env-validation, prod-readiness/env-registration, privacy/no-pii-in-logs, privacy/no-pii-probe-replays. Full suite and tsc in this PR's CI.
Promotion triggers: any change to Resend transport auth, or to who receives a message.

## What changes

- New `src/email/email-sender.ts`: the one resolver for the From address. Reads `EMAIL_FROM_ADDRESS` only. Accepts `noreply@domain` or `Name <noreply@domain>`; rejects blank, multi-address and CR/LF values.
  - Live transport (resend / sendgrid / postmark) with no valid value: throws `EmailSenderConfigError`, nothing is sent, the caller logs a line naming `EMAIL_FROM_ADDRESS`.
  - `log` transport (dev/test): falls back to a dev sender, so local and test runs need no email env.
- `EmailService`: resolves the sender once at boot (never throws mid-send); the boot check now validates the address shape (was only "truthy") and logs one line `outbound sender domain=<domain> transport=resend` so the sender domain can be confirmed in Fly logs (domain only, no local part).
- `DigestService._send`: no more `?? '[redacted email]'`; a live transport with no sender fails closed (the NotificationDigestLog row records `error=EmailSenderConfigError`) and logs `digest not sent: EMAIL_FROM_ADDRESS is not set to a valid sender address`.
- `GuestCheckoutService.sendWelcomeEmail`: uses `EMAIL_FROM_ADDRESS` like every other email. No longer reads `RESEND_FROM_EMAIL` or falls back to `[redacted email]`. With no sender it skips and logs `Welcome email not sent for <checkout id>: EMAIL_FROM_ADDRESS is not set to a valid sender address`.
- `env-validation.ts`: EMAIL_FROM_ADDRESS reason/default rewritten; RESEND_FROM_EMAIL marked RETIRED (still registered so an old Fly value is recognised) and removed from prodHardenedFeatureVars.
- Tests: fixtures that use a live transport now set EMAIL_FROM_ADDRESS (env-validation, privacy/no-pii-in-logs, privacy/no-pii-probe-replays, b-guest-126-guest-checkout-claims); the support-email guard allow-list swaps the two retired fallback addresses for `[redacted email]`.

Overlap: b#816 (merged to main during this PR) edited `src/storefront/guest-checkout.service.ts` in other hunks; main is merged in cleanly. Its new test `test/b-guest-126-guest-checkout-claims.spec.ts` counts welcome emails with a config that had no sender, so this PR adds `EMAIL_FROM_ADDRESS` to that test's config (one line).

## B / U fixed

- U-EF-2 (consistency, not a verified failure): the guest-checkout welcome email (account activation link) read a second env name, `RESEND_FROM_EMAIL`, with a `[redacted email]` code fallback. Fly Env Truth shows both `EMAIL_FROM_ADDRESS` and `RESEND_FROM_EMAIL` present and non-empty; their values were not read, so no current sender is claimed wrong. After this PR the welcome email uses the same `EMAIL_FROM_ADDRESS` as every other email, so the two can no longer drift apart.
- U-EF-1 (consistency, loud failure): the sender lived in three places with three defaults (`[redacted email]` twice, `[redacted email]` once). Now one resolver; a live transport with no valid sender sends nothing and logs a line naming `EMAIL_FROM_ADDRESS`; boot logs the sender domain. The digest fallback itself is not reachable in production today (EmailService refuses to boot without EMAIL_FROM_ADDRESS while EMAIL_TRANSPORT=resend), so it is removed rather than counted as a B.
- Digest evidence, for the operator: all 6 failed NotificationDigestLog rows ran at the default crons (06:00 / 07:00 UTC = 23:00 / 00:00 PDT), before the owner verified growthprojectapp.com (about 12:02 PDT 10-06), and the 10-02..10-04 rows name growthprojectapp.com, so the digest sender was already on that domain. Nothing here shows the current sender is wrong; the first digest after verification is the 23:00 PDT 10-06 coach digest, and its row is the proof.

## Env the operator must stage (names and values only; no secret values)

The owner verified `growthprojectapp.com` in Resend and named the sender `[redacted email]` (10-06, agent 124).

| Name | Value | Manifest entry (.github/fly-env-desired-state.json) |
|---|---|---|
| `EMAIL_FROM_ADDRESS` | `The Growth Project <[redacted email]>` (bare `[redacted email]` also works) | `secrets.EMAIL_FROM_ADDRESS: "github-secret"`, with the GitHub Actions secret `EMAIL_FROM_ADDRESS` set to that value and the name added to both env blocks of `.github/workflows/fly-env-sync.yml` (as GOOGLE_CLIENT_IDS is). This pins the exact value; `"present"` would only check that a value exists. |
| `EMAIL_TRANSPORT` | `resend` | Already on Fly. `secrets.EMAIL_TRANSPORT: "present"` (or `"github-secret"` with value `resend`). |
| `RESEND_API_KEY` | (secret, already on Fly) | `secrets.RESEND_API_KEY: "present"`. |
| `RESEND_FROM_EMAIL` | retired | `secrets.RESEND_FROM_EMAIL: "unset"` ONLY after this PR is deployed (until then production boot still requires it). Leaving it on Fly is harmless. |

Not backend env: Supabase auth emails (sign-up confirmation, password reset via `resetPasswordForEmail`) go through the Supabase custom SMTP settings; the owner saved Resend SMTP with a growthprojectapp.com sender on 10-06 12:24.

Check after the next deploy: Fly logs show `outbound sender domain=growthprojectapp.com transport=resend` once per machine boot.
