# AUD-OPUS-W12-119 — Claude Opus 5.5 lens, agent 119: mobile coach setup W1 #345 + W2 #346 (T4)

- **Window:** started 12:43 PDT 10-04; verdicts posted 12:59 PDT (times from `date`).
- **Notes:** ops/aud-119/AUD-OPUS-W12-119/
  - `verdict-345.md`, `verdict-346.md`: posted bodies
  - probe specs
  - lane logs
  - prior verdict and fix-round bodies, saved as `c<id>.md`
- **Claims:** ops/lanes119/claims/mobile-345-97c9005e-opus, mobile-346-2baea5b8-opus.
- **Footprint:** no heavy local work; probes ran in the CI lane only. Disk was 67 percent at start.

## mobile #345 @ 97c9005e644ebc13731d1477bfecc270a10552fd: APPROVE, A/B/C = 0/0/3
- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5983832209
- **CI at this head, all green:**
  - Typecheck, lint, test (run 37220125291)
  - Analyze js-ts and Analyze actions (run 37220125300)
  - CodeQL
- **Branch state:** behind main cc4ceeed. The newer main commits touch only account-deletion and support files, so nothing overlaps.
- **Size:** 2,580, grandfathered under the 3,000 ceiling.
- **Probe:** lane run 37229987672, 6/6 pass (3 verify cases, 3 observe cases).
- **Prior Opus findings:**
  - B-345-1: closed. Checked against production 3e9a9a75 `UpdatePackageDto` and the `update` raw row.
  - B-329-5 helper: closed.
  - C-345-1, C-345-2, C-345-3: closed.

## mobile #346 @ 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60: APPROVE, A/B/C = 0/0/4
- **Comment:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5983832366
- **CI at this head:** Typecheck, lint, test green (run 37220153099). Analyze runs only on the main-based piece.
- **Size:** 2,609, grandfathered.
- **Probe:** lane run 37229997527, 5/5 pass.
- **Prior Opus findings:**
  - B-346-1: closed.
  - B-329-5 caller: closed.
  - C-346-2: closed.
  - C-346-1: the GetPaidPanel part is closed; the checklist and invite parts stay open (listed below).
  - C-346-3 (land as one): still applies.

## Follow-ups (C)
Each is listed for the operator to ticket. None blocks.

- **C-345-4: editor saves rewrite cadences the app cannot represent**
  - Where: `src/api/packagesApi.ts:463-473` (billing now sent on every editor save), `:362` (`week` maps to monthly), `CoachPackageEditScreen.tsx:164` (`intervalCount: 1` hard-coded).
  - Effect: weekly, month x2, month x6 and year x2 rows are rewritten on a name-only edit, or refused with `PACKAGE_PRICING_LOCKED` when they have subscribers.
  - Fix rule: send billing fields only when they differ from the loaded row, or round-trip the raw interval and count.
  - Test: a name-only edit of each of those rows sends no billing fields.
- **C-345-5: legacy status payload tells the coach to "finish" eventually-due items**
  - Where: `src/api/coachSetupApi.ts:99-121`. With charges off and only eventually-due items, the screen shows "Finish your Stripe details" plus the list.
  - Fix rule: for a legacy payload that is not switched on, use a neutral "Stripe may ask for" list, or show the "last update" note on first load.
- **C-345-6: package update copy**
  - Where: `src/lib/coachSetup/errors.ts:255-262`. The `PACKAGE_UPDATE_NOT_APPLIED` body says "clients still see"; for a draft, no client sees anything.
  - `PACKAGE_PRICING_LOCKED` has no branch and falls to the unknown branch at `:273`.
  - Fix rule: add specific locked copy ("create a new package for new pricing") and narrow the NOT_APPLIED body.
- **C-346-4: checklist detail copy**
  - Where: `src/components/coach/setup/CoachSetupChecklist.tsx:120` says "You have been paid." (a paid charge is not a payout, and it can still be refunded or disputed).
  - At `:83-86` the Get paid detail comes from `state === "active"` alone. Pending verification with charges on reads "Connect Stripe so clients can pay you."; active with items due reads "ready".
  - Fix rule: use "Your first client payment came in." and derive the Get paid detail from the same states `connectCopy` uses.
- **C-346-5: privacy sentence overclaims**
  - Where: `src/screens/coach/setup/CoachSetupScreen.tsx:44-46` says "TGP never sees those details". The backend mirrors `PayoutMethod.last4` and `bank_name`.
  - Fix rule: "TGP never stores your full bank account number or your ID."
- **C-346-6: no trial choice on the first package**
  - Where: `src/components/coach/setup/FirstPackageForm.tsx:214` sends `trialDays: 0`, and `toBackendCreate` drops `trial_days`.
  - Fix rule: when trials T2/T3 deploy, add a 0-30 day trial choice to the Every month branch, with a body test.
  - Related, outside this diff: the editor on main validates trial days as 0-365. The binding rule is 0-30. Hand this to the trials stack.
- **C-346-1 (rest): async guards**
  - Where: `src/components/coach/setup/CoachSetupChecklist.tsx:140-158` and `InviteShareCard.tsx:61-96`.
  - Fix rule: capture the owner and mount at the start, and re-check after every await.
- **Carried from B-WIZ-118, W3 #347:**
  - `CoachWizardNavigator.tsx:343` "our payments partner"
  - `CoachPackageEditScreen.tsx:261` calls `createPackageOnce` without `isLive`
  - `:608` "It will not be made twice."

## Operator decisions (recommended default first)
1. **Follow-up Cs:** default is to ticket them all as one small T4 follow-up after #345-#351 land. Alternatively, fold them into the W3 #347 fix round, which already edits the editor and wizard copy.
2. **Coach-voice share text** ("Join my coaching ..." at `InviteShareCard.tsx:79-80`): default is to keep it, because it is the coach's own message, not app copy.
3. **Landing:** land #345-#351 as one, after the coach backend deploys (B-332-7 is fixed in #349, C-332-1 in #348). W2 is not inert: it puts the checklist on Home.

## HANDOFF
- **mobile #345** @ 97c9005e644ebc13731d1477bfecc270a10552fd: Opus APPROVE 0/0/3 (5983832209).
  - Next: Sol verdict (AUD-SOL-W12-119), then stack landing.
- **mobile #346** @ 2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60: Opus APPROVE 0/0/4 (5983832366).
  - Next: Sol verdict, then stack landing.
- **If a head moves:** a fresh Opus lens runs a delta from these heads. Probe specs to replay are in ops/aud-119/AUD-OPUS-W12-119/.
- **Cleanup done:**
  - audit/AUD-OPUS-W12-119/{345,346}-probe branches deleted.
  - Worktrees wt/AUD-OPUS-W12-119-{345,346} removed.
  - No locks held. The claims stay as records.
