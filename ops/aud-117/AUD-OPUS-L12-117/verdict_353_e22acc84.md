AUDIT Claude Opus 5.5 — growth-project-mobile#353 @ e22acc84b3ee99c94f3ec77793b38ca0c8157241 — VERDICT: REQUEST CHANGES
A/B/C = 0/4/5

Lens AUD-OPUS-L12-117 (agent 117), T4 (money, account state, session boundary, paired with backend dunning #687-#691). Piece L2 of the #322 split, base `agent115/lockout-split-1-dunning-data` (#352 @ `58b80914`). Independent of every builder and of the Sol lens.

### Split faithfulness and evidence reuse (G09)
- The stack top #354 @ `37ed3d56` has tree `8f0a2730`. That equals the clean merge of #322's dual-approved head `23435ec2` with main `367e6c48`.
- Every file in this piece is byte-identical to `23435ec2`, except `app.json`. Its 9-line intent-filter addition is identical, and the rest is main #305 (`runtimeVersion` fingerprint, `updates`, `versionCode 5`).
- The Opus approval of `23435ec2` ([5964778187](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964778187)) is reused only for the closures of B-322-1, B-322-2, C-322-1 and C-322-2, which still hold.
- The findings below come from a fresh full read at T4. They cover the session boundary, the dispute contract and the copy and accessibility rules. They also cover a backend change made after that approval: commit `67096788` (2026-10-04 03:18 UTC, "disputed cancel is 2A").

### Probe run
[run 37180275904](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180275904), branch `audit/AUD-OPUS-L12-117/353-probes`, probe spec only, from this exact head.
- Probe file `aud117OpusL12.probe.test.tsx`: 9 PROBE cases fail as predicted and 3 CONTROL cases pass.
- The head's own `dunningLockout.test.tsx`: 37 of 37 pass.

### B (must fix)
**B-353-1: the lockout carries over to the next account on the same phone.**
- Cause:
  - The lockout store is module state (`dunningLockoutStore.ts:27-28`) and is never reset at sign-out or sign-in. The codebase resets this kind of state on `authEvents` `logout`/`login` (`useCurrentUser.ts:87-98`, `useCoachRoleType.ts:68-75`).
  - `DunningLockoutProvider` starts from the old store value (`DunningLockoutProvider.tsx:73`), and so does `EntitlementProvider` (`EntitlementProvider.tsx:68`, which hides the paywall at `:172`).
  - The only reset (`DunningLockoutProvider.tsx:107-108`) runs when `enabled` is false. `RootNavigator.tsx:950,980` always passes `enabled`, and nothing resets on unmount.
  - `refresh` (`:86-93`) writes the shared store after an `await` with no check of who is signed in. The lockout shows the previous account's request id as the support reference (`:199`).
- Effect: after account A (locked) signs out, account B sees A's lockout screen, and its paywall is hidden, until B's status read succeeds. If that read fails (offline, 5xx, 404 before the backend deploys), B stays on A's lockout.
- Probes (FAIL at head):
  - "account B does not see A's lockout while B's status read is still pending": the overlay is rendered.
  - "account B is not left on A's lockout when B's status read fails (offline)": the overlay is rendered.
- **Fix rule:**
  - Reset the store on sign-out and on identity change (an `authEvents` listener, or the provider's unmount cleanup).
  - Do not show a lockout from a stale store value. Start unlocked and lock only from a signal raised in the current session.
  - Drop status answers and 403 signals from requests started under an earlier session.
  - Add tests for these three cases.
  - If the reset goes into the L1 store or interceptor, #352 needs a new verdict.

**B-353-2: a dispute lock is described as a declined payment that a new card fixes, and the end-plan dialog contradicts the paired backend.**
- Backend #691 `e0afe678`:
  - It returns `kind: 'dispute'` with `state: 'locked'` or `'past_due'` (`dunning-v2.service.ts:1551-1552`).
  - A card update does not end a dispute cycle (B-628-8). The backend's own copy says "Saving a card does not settle that" (`client-billing.service.ts:1424`).
  - Since `67096788`, "a cycle with an open dispute is 2A (end now), never option A" (`:1549-1552`, `:1636`, `:1645`).
- This head ignores `kind` everywhere except `endPlanAlertBody`. That function branches on the old rule:
  - `DunningLockoutScreen.tsx:37-44` says "has not gone through since ...".
  - `:120` says "The card ending 4242 was declined".
  - `:138-139` says "tap Update card ... We charge it right away, and your plan comes back".
  - `:88` says "The unpaid balance is canceled".
  - `UpdateCardScreen.tsx:76-90` says "$150.00 is charged to it right away. Your plan comes back as soon as it clears".
  - `DunningBanner.tsx:13-18` says "Update your card by Sunday, October 11 to keep access".
  - `UpdateCardScreen.tsx:104-107` tells a dispute-locked client "Your plan ends at the end of the period you already paid for". The backend ends access now.
- Every statement above is false for a dispute, and the main action does not work for one. The client confirms a destructive action on wrong facts.
- Probes (FAIL at head, with received strings in the run log): the lockout screen, the Update card intro, the banner, and the end-plan dialog for a dispute ("ends now" expected, period-end received).
- **Fix rule:**
  - When `kind === 'dispute'`, say the bank reversed an earlier payment, that a new card does not settle it, and that the next step is support or the coach thread. Hide or relabel the card action.
  - The end-plan dialog says access ends now.
  - Show `quote.disputes` on the Update card screen (L1 half: C-352-5).
  - Add tests per surface.

**B-353-3: first person in client copy (owner copy rule).**
- `DunningLockoutScreen.tsx:138`: "We charge it right away".
- `UpdateCardScreen.tsx:461`: "Stripe, our payment provider".
- Main applies the same rule in `src/lib/ai/__tests__/aiClientCopy.guard.test.ts:11` (`FIRST_PERSON`), and #315 just removed "write to us".
- `dunningLockout.test.tsx:182` pins "We charge it right away".
- Probes (FAIL at head): the lockout screen and the Update card screen match `FIRST_PERSON`.
- **Fix rule:**
  - Use "The card is charged right away" and "Stripe, the payment provider".
  - Update the pin.
  - Add a `FIRST_PERSON` guard over the rendered dunning screens.

**B-353-4: the lockout overlay leaves the locked app reachable by screen readers (WCAG 2.2 AA: 2.4.3, 2.4.11, 1.3.2).**
- The lockout is a plain `View` with `StyleSheet.absoluteFill` drawn over `{children}` (`DunningLockoutProvider.tsx:184-187`). It has no `accessibilityViewIsModal` / `aria-modal`, and the app underneath is not marked `importantForAccessibility="no-hide-descendants"` / `accessibilityElementsHidden`.
- VoiceOver and TalkBack move focus into the hidden home screen and tab bar, which are fully covered by the overlay, and read them in with the lockout.
- Probe (FAIL at head): `isHiddenFromAccessibility(app content)` is `false` while the lockout shows. The CONTROL (no lock, content accessible) passes.
- **Fix rule:**
  - Set `accessibilityViewIsModal` on the overlay and hide the `children` wrapper from accessibility while `showLockout` is true. Alternatively, render a `Modal` that blocks Android back as today.
  - Add a test using `isHiddenFromAccessibility`.

### C (optional)
- **C-353-1: copy names a button that is not on the Update card screen.** The copy says "Tap Update card again" (`dunningErrorCopy.ts:111,118,160,179,305,312,470-471`), but the screen's buttons read "Add a card" or "Try a different card" (`UpdateCardScreen.tsx:418`). **Fix rule:** use one label.
- **C-353-2: a new card can be described as declined.** "The card on file ends in X and was declined" (`UpdateCardScreen.tsx:313`) is computed from `status.card_last4`. After a new card is saved and the bank step or processing is pending, that is the new card, so the line contradicts the result box.
- **C-353-3: the banner can give a past date.** For `lock_waived` past-due cycles the banner says "Update your card by <past date>" (`DunningBanner.tsx:15-16`).
- **C-353-4: C-322-3 is carried for the operator.** When the #334 split lands its `ClientPackagesScreen.tsx` past-due banner, keep the native `UpdateCard` route and never bring back the portal call.
- **C-353-5: release order.**
  - The `app.json` intent filter changes the fingerprint `runtimeVersion` (main #305), so this ships only in a new binary.
  - The universal link needs the backend AASA path `/billing/update-card` (#690 `well-known.controller.ts`) deployed first.

### Verified OK
- Sentry extras carry codes and ids only.
- `@stripe/stripe-react-native` 0.64.0 calls match.
- Deep link parsing and the intent filter match the AASA paths.
- The `REACHABLE_WHILE_LOCKED` route names exist in the navigators.
- Android back is blocked on the lockout.
- The confirm sends `approved_invoices` built from the backend quote.

### CI at this head
Typecheck, lint, test: SUCCESS (the only check that runs on a stacked base). Merge state CLEAN against #352.

No push to a PR branch, no merge, no production action.
