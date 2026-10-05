AUDIT Claude Opus 5.5 — growth-project-mobile#346 @ 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60 — VERDICT: APPROVE
A/B/C = 0/0/4

Agent 119, job AUD-OPUS-W12-119 (Opus lens), T4. This is a full audit of W2 at its exact head (base: the W1 #345 branch at 97c9005e). No evidence is reused.
- Size: 2,609+/0-. The PR is grandfathered (opened 2026-10-03T20:49:33Z) and is under its 3,000 ceiling.
- Required check at this head is green: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220153099/job/111488678425). Analyze and CodeQL run only on the main-based piece.
- W2 is not inert: it adds the checklist to the Command Center Overview header and registers `CoachSetup` in SettingsStack. `FirstPackageForm` has no app importer until W3.

Probe: [CI lane run 37229997527](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229997527) runs this head plus one spec (`src/components/coach/setup/__tests__/audOpusW12_119_346.test.tsx`, never merge). It drives the real `FirstPackageForm`, `createPackageOnce`, `coachPackagesApi` and `coachSetupApi` over the builder's server double (one package per key, PATCH applies, publish refuses archived). Result: 5/5 pass.
- **P1:** the remembered package was deleted since; the coach changes the cadence. The PATCH gets 404 `PACKAGE_NOT_FOUND`, and exactly one fresh live package is made.
- **P2:** remembered paid monthly, then Free picked. One PATCH makes it one-time $0; it is published and bound once, with no second create.
- **P3:** a server that ignores the cadence. The coach sees "The new price or billing did not save"; nothing is published, there is no callback, and the made package stays remembered.
- **P4:** for a free package, a binding lost on the network is retried with one bind and no second create.
- **P5:** observe case behind C-346-4.

### Prior Opus findings (AUD-OPUS-S12-117, 5977036337)
- **B-346-1 (first-person copy): closed.**
  - `CoachSetupChecklist.tsx:120` now reads "This ticks when your first client payment arrives."; `CoachSetupScreen.tsx:44` now reads "Stripe, the payments provider TGP uses, ...".
  - The new guard test covers every checklist state and the rendered screen. No first person remains in any W1/W2 source string; the coach-voice share text is an operator item.
- **B-329-5 caller (form keeps working after the owner changed): closed.**
  - `FirstPackageForm.tsx:198-203` defines `stillOwner` as mount plus owner plus generation, and passes it as `isLive`.
  - It is re-checked at `:230`, `:248`, `:250`, `:259`, `:262`, `:268`, `:270` and `:275`.
  - An account change bumps the generation and resets the form (`:156-173`); a retired run's `finally` leaves the new account alone (`:291-296`).
  - Failing-before: [lane 37219889067](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219889067). My S12 form probe passes 7/7 in the [builder replay 37220273057](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220273057).
- **C-346-2 (archived remembered package): closed** at `:94` and `:254-264`. P1 extends the check to a PATCH 404.
- **C-346-1 (async writes without guards): partly closed.** The GetPaidPanel part is closed: epoch fence, an open sheet is dismissed on retire, and Retry repeats the failed action. `CoachSetupChecklist.tsx:140-158` (`setSnap(await ...)`) and `InviteShareCard.tsx:61-96` remain. That part stays open as a follow-up.
- **C-346-3 (land as one): still applies.** `CoachHomeCards.tsx:22-48` navigates without `initial: false` (B-332-7, fixed in #349). An active sub-coach gets 403 from `/coach/connect/status` (C-332-1, fixed in #348). Land #345-#351 together.
- **B-345-1 at the form level:** covered by the W1 fix, plus the form-level test and P2/P3.

### Verified against today's production backend (3e9a9a75)
- **Routes the panels use, all present:**
  - `/coach/connect/status` (legacy payload)
  - `POST /coach/connect/onboarding-link` (`CONNECT_NOT_CONFIGURED` maps to specific copy)
  - `/coaches/me/invite-link`
  - `PUT /v1/invite-codes/:code/package-binding`
  - `POST /v1/coach/packages/:id/publish`
  - `/coach/clients?status=all&take=1` (a bare array, which `rowCount` handles)
- **Routes that are missing, with truthful fallbacks:**
  - `status/refresh`: falls back to the saved status plus the "last update Stripe sent" note.
  - `/v1/coach/money/charges`: answers 404, so the device gate is used. It never ticks without proof.
- **Return URL:** the onboarding return URL is the server env value (not tgp://), so the sheet stays open until the coach closes it, and status is re-read either way. No copy claims an automatic return.
- **Sign-out handling:** `authEvents` generic listeners fire on login, bootstrap and logout, never on token refresh, so an open Stripe sheet is dismissed only on a real account change.
- **Recurring and fees:** recurring is first class (the form defaults to Paid, Every month). Fee copy matches the binding rule, and the $19.99 floor or Free mirrors the server.

### C-346-4: checklist detail copy says more than the status proves
- **Where:**
  - `CoachSetupChecklist.tsx:120` "You have been paid." A paid charge is not money in the bank, and it can still be refunded or disputed.
  - `:83-86` builds the Get paid detail from `state === "active"` alone. Charges on with payouts pending (`pending_verification`) reads "Connect Stripe so clients can pay you." even though Stripe is connected and clients can pay. Active with due items reads "Stripe is ready to pay you." while the panel says an update is needed.
- **Fix rule:** use "Your first client payment came in.", and derive the Get paid detail from the same state and switch logic as `connectCopy` (connected and checking; can take payments, update needed). Test every Connect state.

### C-346-5: privacy sentence overclaims
- **Where:** `CoachSetupScreen.tsx:44-46` "TGP never sees those details." The backend mirrors the payout bank name and last 4 digits (`PayoutMethod.last4` / `bank_name`, prisma schema around line 4345, fed by the external-account webhook).
- **Fix rule:** "TGP never stores your full bank account number or your ID."

### C-346-6: the first package has no free-trial choice
- **Where:** `FirstPackageForm.tsx:214` sends `trialDays: 0`, and `toBackendCreate` drops `trial_days`.
- **Why it is not a B:** the binding rule requires real trials (coach sets 0-30 days), but production does not accept `trial_days` today (backend T2/T3 #672/#673 are not deployed). A picker now would promise something the server cannot do.
- **Fix rule:** when the trials stack lands, add a 0-30 day trial choice to the Every month branch, with a test that the create body carries it. The operator should ticket this with the trials stack.

### C-346-1 (rest, retained)
- **Where:** `CoachSetupChecklist.tsx:140-158` and `InviteShareCard.tsx:61-96`.
- **Fix rule:** capture the owner and mount at the start, and re-check after every await before `setSnap`, `setLink` or `markShared`.
- **Why C:** cross-account display is bounded by the gate unmount on an identity change.

Head re-read immediately before posting: 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60.
