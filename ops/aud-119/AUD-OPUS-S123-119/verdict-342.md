AUDIT Claude Opus 5.5 — growth-project-mobile#342 @ e3226f3b50a1f609aea7805600ec124324cd12aa — VERDICT: APPROVE

A/B/C = 0/0/7 (AUD-OPUS-S123-119, agent 119). Tier T4 (payments, money copy). Size +2,190 / -17 = 2,207 (grandfathered, under the 3,000 ceiling). Required checks green at this head: Typecheck, lint, test (run 37232747197), Analyze actions + javascript-typescript (37232747242), CodeQL.

## Prior findings
- My lens: APPROVE 0/0/6 at `0b1985f4` (issuecomment-5983935012). Those Cs are unchanged (C-342-1 and C-342-2 held; C-342-4, C-342-5, C-342-6, C-342-7 follow-ups).
- Sol residual B-342-1 (an archived-package refusal after an unclear same-key attempt claimed nothing was charged): **closed** in my reading.
  - `src/lib/packagePayment.ts:499-505, 841-857`: `packageUnavailable(ref)` and `packageUnavailableShareLink(ref)` make no no-charge claim. They point to Membership and support, and quote the attempt key's reference.
  - `support` and `openPlan` are set, and there is no `retireKey`, so the key is kept. The sheet reloads; a share link does not.
  - Test commit `ab41a59`; fix commit `e3226f3`.
  - The failing-before run (37232648574, 6 failed) and the after run (37232722067, tsc + 165/165) are confirmed. The lane commits add only probes and lane files over the test commit and the head.
- I checked the root cause in today's production backend `3e9a9a75`: `checkout.service.ts:444-490` checks `PACKAGE_NOT_FOUND` (no coach, inactive/archived/draft package, cross-coach) before the key lookup at :506. The fix rule fits the order the backend actually runs.

## Evidence reuse (G09)
- My APPROVE at `0b1985f4` is reused for every file that is byte-identical since then: 10 of the 12 PR files.
- I audited fully the 2-file delta (`packagePayment.ts` +24/-15, `packagePayment.replyCodes.test.ts` +45).
- No Sol verdict was reused.

## Probe (CI lane)
- `audit/AUD-OPUS-S123-119/342-probe`, run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234780670. Passed, 147/147. It replays my S12 probe and adds S4:
  - R1: currency minor units, Intl path and fallback path.
  - R2: copy rules over every string.
  - S4: PACKAGE_NOT_FOUND on `payment_intent`, `subscription_intent` and `claim_free` after an unclear attempt. No no-charge claim, the key is kept, the attempt reference and support are shown, and a share link does not reload.

## New finding
- **C-342-8** `src/lib/packagePayment.ts:506-507, 859` (accountMissing):
  - Problem: "Your account could not be found, so nothing was charged." Production checks `CLIENT_NOT_FOUND` before the key lookup too (`checkout.service.ts:445-453` @3e9a9a75). So after an unclear same-key attempt it proves nothing about that earlier payment.
  - Probe S4 records the copy. Risk is low: the account row has to vanish between two taps.
  - Fix rule: drop "so nothing was charged". Say "Your account could not be found. Sign out and sign back in, then check Membership for any earlier payment, or email support and quote reference <ref>." Support action and key kept.

## Job checks
- The #661 reply codes and recurring codes are unchanged since my last approval.
- The renewing bare-404 fallback for today's production backend is unchanged.
- No first person, no exclamation marks, no emoji (probe R2).
- Recurring is never one-time-only.
