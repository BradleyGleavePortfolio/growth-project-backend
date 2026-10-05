# AUD-OPUS-MON1-122 — Claude Opus 5.5 lens, coach money screens m#348-#351 (agent 122)

Started 15:42 PDT 2026-10-05; verdicts posted 16:02-16:03 PDT; report closed 16:04 PDT. Time box 60 minutes; about 22 minutes used.

## Verdicts (posted at the restacked heads; heads re-checked at 16:03 PDT, and they match operator mail 16:04)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #348 N1 | d55e6f56d0d7328e12042413005cf40d40fa98c9 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6004991573 |
| #349 N2 | 53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4 | REQUEST CHANGES | 0/1/4 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6004992019 |
| #350 N3 | 040a6a4efd8c9ea635861df718d32d6e5e418d46 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350#issuecomment-6004992329 |
| #351 N4 | f30c5dbb4cb4e6211111291c2f6ca2f1598dffe3 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351#issuecomment-6004992596 |
Verdict sources: ops/aud-122/AUD-OPUS-MON1-122/v348.md ... v351.md (posted.txt lists the comment URLs).

## Old heads (start of review)
#348 90501f84, #349 35aa8163, #350 6fb21216, #351 352d768e. Restack READY at 16:02 (notify/wizard.txt). Claims were made for both the old and the new heads.

## Delta check (restack)
- **#348:** merges #347 @ 08c7416e. Its own diff (08c7416e..d55e6f56) matches ea2c72d1..90501f84 except one conflict hunk in CoachSetupChecklist.tsx:117-121, which keeps "You have been paid. See it in Money." and #347's "This ticks when your first client payment arrives.". The errors.ts hunks moved 52 lines down and are otherwise unchanged.
- **#349:** merges #348 new. Its own diff is identical except the CoachWizardNavigator Step 5 hunk, which keeps #349's line. Only the base line changed.
- **#350:** merge-only; its own diff is byte-identical.
- **#351:** merge-only; only the packagesApi.ts hunk offsets moved. Nothing outside tests imports the deleted earnings code.
- **All four:** every non-merge commit is on the lower piece's new head. No conflict markers.
- **CI:** #348 green (run 37385316983) and #351 green (run 37385323691). #349 (run 37385318013) and #350 (run 37385323085) are red by design: Lint and Typecheck pass, and exactly 3 tests in 2 suites fail (the paymentsConnectPackages x2 and coachSaasBlockers x1 source scans that look for the Earnings routes). #351 updates both suites.

## The one B
**B-349-1: the charge detail presents a recurring plan's whole history as one payment.**
- **Mobile code:** MoneyChargeScreen.tsx:120 puts one period's price in the header. Lines 95-103 and 141 render the backend breakdown.
- **Backend cause:** getChargeBreakdown folds every ledger slice of the purchase (coach-money.service.ts:1548-1585, main 5cde6253). Renewals post their own slices on the same purchase (SplitLedgerEntry unique key includes stripe_charge_id; purchase-split-handler.service.ts:77-97).
- **Failed renewals:** a past_due plan maps to state "failed" (toCharge :1655, checked before the paid branch at :1656-1660). The page then says "the client was not charged and nothing from this charge reaches your payouts" and hides the breakdown.
- **Normal-user story:** a coach whose client has paid a $100 monthly plan three times taps that charge. The page shows a $100 charge with "Clients paid $300" and a $6 "TGP fee (2%)". After one failed renewal, it says the client was never charged and nothing reached payouts.
- **Fix rule (mobile copy only):** for recurring charges, show the price with its cadence in the header, head the breakdown "This plan so far" and label the first row "Clients paid so far". For a failed recurring charge with `settled` true, say the latest payment failed and keep the breakdown. Add a test for each.

## Cs
- **C-348-1:** the fixed "TGP fee (2%)" label does not reflect per-coach FeePolicy overrides (edge, deferred to 10k clients).
- **C-348-2:** the MONEY_PAYLOAD_INVALID branch sends the thrown error to captureError instead of the content-free report() (beforeSend scrubs it; no money or personal data).
- **C-349-2:** Recent charges lists purchases by start date, so renewals never show up there.
- **C-349-3:** a paid charge whose ledger has not posted yet shows a $0 net (edge, deferred).
- **C-349-4:** the empty Payouts copy says the first payout comes "a few days" after the first sale; Stripe usually takes 7-14 days for a new account.
- **C-332-4/5 (carried):** the CSV export is a text share; the file version is m#340.

## Prior Opus #332 Bs
B-332-7, B-332-8, B-332-9 and B-332-10 are all closed in the pieces (evidence is in the #349 verdict). No evidence was reused, because this lens never approved #332.

## Operator decisions
1. **How to fix B-349-1:**
   - (a) Mobile copy fix in #349 now. **Recommended default.**
   - (b) A backend per-Stripe-charge breakdown and charges list. This is a backend PR; it fixes C-349-2 too, but it is slower.
2. **Re-review scope after the fix round:** a delta re-review of #349 only, plus #348 if moneyCopy.ts changes, plus #350/#351 as merge-only. **Recommended default.**

## HANDOFF
- Done. All 4 verdicts are posted at the exact heads above. No probes or lane runs were made. The worktree /home/user/workspace/wt/AUD-OPUS-MON1-122-351 is removed. Local refs pm347new..pm351new in the mobile clone are read-only fetch refs and can be left.
- Next for a fresh Opus lens: when B-WIZ3 (or the builder) posts FIX ROUND for B-349-1, do the delta re-review (20 min):
  - check that the recurring header and breakdown wording follow the fix rule;
  - check that a failed recurring charge with settled=true keeps the breakdown;
  - check that one-time charges are unchanged;
  - check the new tests;
  - check that the merge-only deltas of #350/#351 are clean.
