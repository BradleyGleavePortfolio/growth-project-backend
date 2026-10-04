FIX ROUND 1 (B-LOCK-118, agent 118) — growth-project-mobile#353 @ 05d84f27261f1f764214be5a379785ba8f690d3e

First merged the new L1 head (#352 @ `ac244d22`, merge commit `1fbb7837`), then fix `0dce9ed2` and a test-only tightening `05d84f27`. Size vs the L1 base: +2476 / -44 = 2,520 changed lines (1,500-3,000 band: operator SIZE ASSESSMENT needed). Flag stays off. Truthful on today's production backend (`643817b3`: no dunning status, card or cancel routes, guard a no-op): the status 404 shows nothing and reports nothing, `{ enabled: false }` is never a lock, and Update card says "not available yet, so nothing was charged".

| Finding | Change | Commit | Test (fails before -> passes after) |
|---|---|---|---|
| B-353-1 (Opus) lockout carries to the next account | Provider no longer seeds `locked` from the module store; the subscription effect syncs it. The store is retired at sign-out / sign-in (L1) and when the provider unmounts (client tree goes away). EntitlementProvider syncs after mount. Stale request reference cleared with the signal. | 0dce9ed2 | `dunningLockoutOwnership.test.tsx` "sign-out ... pending", "next account offline" |
| B-353-1 (Sol) retired / out-of-order reads mutate the lockout | Every status read is fenced by provider lifetime + auth generation + sequence (latest read wins; an older answer or failure never writes). Lock only on `enabled && state === 'locked' && !lock_waived`. `endPlan` answers for a retired owner return `{ ok: false, retired: true }`: no alert, no refresh. Disabled provider invalidates in-flight reads. | 0dce9ed2, 05d84f27 | "retired provider's late locked read", "read started before sign-out", "older clear answer", "older failure", "End my plan answered after sign-out" |
| B-353-2 (Sol) retired Update card screen launches setup / native / confirm | `claimOwner()` per action (mounted + generation); `isCurrent` passed into `runNativeCardUpdate` / `confirmWithBank` (L1 port); every post-await state write, alert, navigation and refresh is guarded; `retired` result is ignored. | 0dce9ed2 | "leaving while the quote is pending", "late card-form return after leaving", "sign-out while the card form is open" + CONTROL |
| B-353-2 (Opus) / B-353-3 (Sol) dispute shown as a declined, card-fixable payment; end-plan says period end | Dispute-aware lockout summary ("Your bank reversed an earlier payment of $X to <coach>, so your plan is paused"), next step (a new card does not settle it; email support or message the coach), Email support primary, no "declined"; dispute intro, banner (no Update card button, no keep-access promise) and outcome copy (reported disputes kept, "nothing was charged" on a dispute-only save). One shared `endPlanAlertBody`: dispute = access ends now + does not settle the reversal; payment = ends now + paid-in-the-meantime caveat (Sol: lockout alert now keeps it). | 0dce9ed2 | "a reversed payment is described as one" block (6) |
| B-353-3 (Opus) / C-353-3 (Sol) first person | "We charge it right away" -> "The card is charged right away"; "Stripe, our payment provider" -> "Stripe, the payment provider"; FIRST_PERSON guard over rendered lockout (payment, dispute, not loaded), Update card (locked, past due, dispute, clear), banner, summaries, next steps and end-plan bodies. Pinned test in `dunningLockout.test.tsx` updated. | 0dce9ed2 | "no first person in rendered client copy" (8) |
| B-353-4 (Opus) overlay not modal for screen readers | Overlay `accessibilityViewIsModal`; app content always wrapped in one flex:1 View (no remount) with `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"` while the lockout shows. | 0dce9ed2 | "the lockout is modal for screen readers" |
| C-353-2 Opus (same lines) | "was declined" only for a failed payment and before this visit saved a card. | 0dce9ed2 | dispute save test asserts no "was declined" |
| C-353-3 Opus (same lines) | Banner shows the lock date only while it is ahead and not waived; waived: "Update your card to settle it." | 0dce9ed2 | "a waived or passed lock date" (2) |
| Job: production truth | Status 404 envelope: no lockout, no banner, no Sentry; flag off never locks; card routes missing: not available, nothing charged, no request, no sheet. | 0dce9ed2 | "truthful against today's production backend" (3) |

Failing-before (tests only on the old head `e22acc84`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220987724 (30 failed, 39 passed; finding tests fail, CONTROLs and unchanged suites pass). Probe replay at `0dce9ed2` (source tree identical to 05d84f27; 05d84f27 changes one test only): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220800719 (89/89 pass).

Probe replay (both lenses):
| Probe | Lens run (old head) | Now |
|---|---|---|
| Opus B-353-1 CONTROL account A sees its lockout | pass | pass |
| Opus B-353-1 PROBE B not on A's lockout while B's read is pending | fail | pass |
| Opus B-353-1 PROBE B not on A's lockout when B is offline | fail | pass |
| Opus B-353-2 PROBE dispute lockout: no "has not gone through" / "was declined" / "charge it right away" | fail | pass |
| Opus B-353-2 PROBE dispute intro: no charge / comeback promise | fail | pass |
| Opus B-353-2 PROBE dispute banner: no keep-access card promise | fail | pass |
| Opus B-353-2 PROBE dispute end-plan: ends now | fail | pass |
| Opus B-353-2 CONTROL payment end-plan: ends now | pass | pass |
| Opus B-353-3 PROBE lockout no first person | fail | pass |
| Opus B-353-3 PROBE Update card no first person | fail | pass |
| Opus B-353-4 CONTROL app accessible without a lock | pass | pass |
| Opus B-353-4 PROBE app hidden while lockout shows | fail | pass |
| Sol CONTROL locked status shows the lockout | pass | pass |
| Sol B-353-1 retired provider cannot relock after its clear read | fail | pass |
| Sol B-353-1 older clear response cannot overwrite newer lock | fail | pass |
| Sol B-353-2 leaving during quote: no setup / sheet | fail | pass |
| Sol B-353-2 late native return: no confirm | fail | pass |
| Sol B-353-3 dispute lockout: dispute recovery, no card promise | fail | pass |
| Sol B-353-3 dispute-only save explains unresolved access | fail | pass |
| Sol CONTROL current mounted flow pays | pass | pass |

Money list:
- Webhook order and redelivery: no webhooks on mobile; status answers can arrive out of order, so the newest read wins and older answers never write.
- Concurrency: one card action at a time (busy gate); reads fenced by lifetime + generation + sequence; End my plan answers fenced by owner. No client locks, so no lock order.
- Terminal states: disputed: described as a reversal, no card fix, ending does not settle it; canceled in dunning (2A) ends now with the paid-in-the-meantime caveat; voluntary cancel keeps the paid period; deleted account: Delete my account stays reachable; sign-out retires the lock.
- List completeness: the quote stays fail-closed (L1); confirm disputes from `plans[]` and the quote are merged, never dropped.
- Currency: integer minor units, formatted per currency; disputed totals per currency only.
- Copy truth: no lockout the server did not decide; "charged right away / comes back when it clears" only for a failed payment (ruling D12); free / code grants never enter dunning, so status `none` shows nothing; no first person, no exclamation marks.

Checks at 05d84f27: Typecheck, lint, test pass (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220986976). Stacked base: this is the only required check.

Follow-up Cs (frozen, in ops/reports/B-LOCK-118.md): Opus C-353-1, C-353-4 (= Sol C-353-2), C-353-5; Sol C-353-1.

READY FOR AUDIT
