AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#819 @ 1fcd9330c76e5629db4f06cd49b49d9f397a9c53 — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (15 SUCCESS, 1 SKIPPED); mergeable state clean. Graded as operator-named (19:25); no builder READY at this head yet. Size 323 lines (283+/40-), under the job's 400-line cap.

**Delta 5c5e5957..ce6685bb (one commit)**
- At 5c5e5957, build-and-test failed at `test/s-fee-r19-refund-cas-send-window.spec.ts:470`. That fixture forces `transportKind: 'resend'` with no env, so the per-send resolver threw.
- Now `EmailService` resolves the sender once in `_initTransport`: the `log` transport gets the dev sender, and `resend` gets the parsed `sender.value` from the same boot check that refuses a malformed value.
- `send` reads `this.fromAddress`, and a caller-supplied `input.from` still wins.
- There is no production behaviour change beyond 5c5e5957, and a new spec proves a malformed `EMAIL_FROM_ADDRESS` stops the boot with the variable named.

**Delta ce6685bb..e63a5bba**
- This is a merge of main (b#811, #816, #817, #818) plus one test commit: `test/b-guest-126-guest-checkout-claims.spec.ts` now sets `EMAIL_FROM_ADDRESS`.
- The PR's own diff in `guest-checkout.service.ts` is unchanged (+17/-13): `sendWelcomeEmail` resolves the shared sender, or logs and returns.
- That sits correctly on top of b#816's once-only `paid -> converted` claim. The welcome email is still best-effort and never throws into the claim.

**Delta e63a5bba..1fcd9330**
- At e63a5bba, build-and-test was red: the CI production `assertEnv()` step threw ENV_PROD_HARDENED_MISSING for EMAIL_FROM_ADDRESS.
- Now EMAIL_FROM_ADDRESS is removed from `prodHardenedFeatureVars` (`env-validation.ts`), and the retired RESEND_FROM_EMAIL is no longer listed there either.
- The sender boot gate is the EmailService constructor: `EMAIL_TRANSPORT=resend` without a valid `EMAIL_FROM_ADDRESS` refuses to boot, and the variable is named.
- Fly has both EMAIL_TRANSPORT and EMAIL_FROM_ADDRESS Deployed, so production keeps a hard sender gate.

**Checks**
- One sender: `resolveEmailSender` (`src/email/email-sender.ts`) reads only `EMAIL_FROM_ADDRESS`. It accepts `addr@domain` or `Name <addr@domain>`, and rejects a blank value, CR/LF (no header injection) and a comma (a second address).
  - EmailService (receipts, invites, dunning), DigestService and the guest-checkout welcome all use it.
  - No `thegrowthproject.app` or `trygrowthproject.com` From fallback is left in src; the only `SMTP_FROM` mention is a data-export README line with no code behind it.
- Fail closed:
  - With a live transport and no valid sender, nothing is sent. The digest rethrows, so its row records the error. The guest welcome logs a line naming the variable (with the checkout id only, no email or name) and returns.
  - The guest purchase itself is untouched: `sendWelcomeEmail` is still best-effort after the purchase.
  - The `log` transport keeps a dev sender, so local and test runs need no env.
- Production boot:
  - `prodHardenedFeatureVars` no longer lists a sender. The gate is EmailService's resend boot check (see the delta above). `EMAIL_FROM_ADDRESS`, `EMAIL_TRANSPORT` and `RESEND_FROM_EMAIL` are all Deployed on Fly (secrets list, run 37536038425, names only), so boot is not blocked by a missing name.
  - The digest errors of 10-02 to 10-04 ("growthprojectapp.com domain is not verified") show the current value is on the domain the owner has since verified. Resend parsed that From, so it is not malformed.
  - The new boot line logs only the domain, not the local part.
- Guest welcome now uses the same verified-domain sender as every other email, instead of a second variable that could drift onto another domain.

**For the operator**
- Land the manifest pin from the PR body (`EMAIL_FROM_ADDRESS: "github-secret"` = `The Growth Project <[redacted email]>`) with or before this deploy, and only then set `RESEND_FROM_EMAIL` to unset.
- After deploy, check the Fly log line `outbound sender domain=growthprojectapp.com transport=resend`.
- Recommended default: merge, then the manifest PR, then a single deploy.

**C (never block)**
- C-819-1: the stricter boot check (shape, not only truthy) runs in the EmailService constructor. A Fly value with a comma inside a quoted display name (for example `"Growth Project, LLC" <...>`), which Resend accepts, would stop the boot. There is no evidence the current value has one, and the manifest pin above removes the risk.
- C-819-2: `parseEmailSender` does not check that the domain is the verified one, so a well-formed value on an unverified domain still fails at Resend (403), as it does today. The new boot domain line makes this visible.
