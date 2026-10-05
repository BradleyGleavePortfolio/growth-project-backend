# AUD-SOL-MON1-122 — coach Money screens

Job: AUD-SOL-MON1-122, agent 122, GPT-6.1 Sol independent lens.

Start: Mon Oct 5 15:42:24 PDT 2026. Time box: 60 minutes, including the restack wait.

## Scope and state

First full T4 review of [growth-project-mobile #348](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348), [#349](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349), [#350](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350), and [#351](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351), restricted to ordinary-use money accuracy, payout/Connect dead ends, data boundaries, false claims, and store/legal failures.

Initial exact heads:

| PR | Head | Review status |
|---|---|---|
| 348 | 90501f847e03cf4cc1071503436acdd459643103 | Full review completed, then restacked |
| 349 | 35aa81634d377acebf55d1b497abadc4b7b8e7db | Full review completed, then restacked |
| 350 | 6fb21216ce40f92ae0369034bfb6268e7c026bac | Full review completed, then restacked |
| 351 | 352d768ef2a72c59458286f9274bec3ad132e0c4 | Full review completed, then restacked |

No Opus lens notes, report, or verdict comments read. No evidence reuse is claimed. No local test/build commands run, no PR branch pushes, and no production access.

## Restack verification

The new PR heads were fetched and independently checked; all four merge parents are the prior piece head plus the newly restacked lower slice, and the per-PR changed-line sizes remain unchanged. [#348](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348), [#349](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349), [#350](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350), [#351](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351).

| PR | New exact head | Posted verdict | A/B/C | Comment |
|---|---|---|---|---|
| 348 | d55e6f56d0d7328e12042413005cf40d40fa98c9 | REQUEST CHANGES | 0/1/0 | [Sol #348 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6005027474) |
| 349 | 53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4 | REQUEST CHANGES | 0/2/0 | [Sol #349 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6005027837) |
| 350 | 040a6a4efd8c9ea635861df718d32d6e5e418d46 | APPROVE | 0/0/0 | [Sol #350 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350#issuecomment-6005028186) |
| 351 | f30c5dbb4cb4e6211111291c2f6ca2f1598dffe3 | APPROVE | 0/0/0 | [Sol #351 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351#issuecomment-6005028501) |

Four exact-head verdicts were posted by Mon Oct 5 16:05:11 PDT 2026, after each head was re-verified immediately before its individual comment. [#348 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6005027474), [#349 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6005027837), [#350 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350#issuecomment-6005028186), [#351 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351#issuecomment-6005028501).

Every Money API/copy/role/status blob, Money screen, Home card, Money navigation test and N3 behavior test is unchanged; the only explicit #348 conflict is the checklist first-payment detail, correctly retaining the Money link and replacing first-person pre-payment text. [N1 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348), [N2 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349), [N3 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350).

The inherited `errors.ts` changes preserve the Money-specific mappings; #349's single wizard conflict keeps the Money first-payment body and “Go to your dashboard”; #351 retains the new lower-slice package-save work while removing only the old earnings adapter. [N1 builder restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6004975484), [N2 builder restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6004975915), [N4](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351).

At Mon Oct 5 15:57:31 PDT 2026, the new required checks and builder's targeted restack lane were running; READY comments had not yet appeared. [N1 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385316983/job/112017037209), [N2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385318013/job/112017040267), [N3 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323085/job/112017057227), [N4 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323691/job/112017058719), [builder lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385399180).

At Mon Oct 5 16:01:48 PDT 2026, N1/N4 required CI had passed, N2/N3 had failed, and the builder lane had failed; READY comments were still absent. [N1 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385316983/job/112017037209), [N2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385318013/job/112017040267), [N3 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323085/job/112017057227), [N4 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323691/job/112017058719), [builder lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385399180).

The follow-up failed-run job/log requests returned GitHub HTTP 403 “API rate limit exceeded”; the new red-run failure details and builder-lane reason are not yet independently established, rather than assumed from the initial red-by-design runs. [N2 run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385318013/job/112017040267), [N3 run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323085/job/112017057227), [builder lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385399180).

Recovery completed before posting: the built-in `gh pr view` route re-verified the heads; direct job-log endpoints established that the new N2/N3 red checks are exactly the same three stale Earnings/Business assertions, with N2 463 other suites / 6,416 tests passing and N3 464 other suites / 6,489 tests passing. [N2 current CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385318013/job/112017040267), [N3 current CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323085/job/112017057227).

The builder's READY comments document that the separate targeted lane has four expected obsolete probe failures, while its typecheck and 19 suites / 329 tests pass; it does not replace the green required N4 CI. [N1 READY](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6004975484), [N2 READY](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6004975915), [N4 required CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323691/job/112017058719).

## Independent findings

### B-348-1 — a normal free trial is labelled as a processing payment

Normal-user story: A coach opens Money while a client's card-upfront free trial is active and sees the future subscription price labelled “Processing,” even though the client has not been charged. [N1 money copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/90501f847e03cf4cc1071503436acdd459643103/src/lib/money/moneyCopy.ts), [live Money read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [subscription checkout contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/checkout/subscription-checkout.service.ts).

- Location: `src/lib/money/moneyCopy.ts:119-120`.
- Evidence: The read model lists positive-price trial purchases, maps a `trialing` purchase with no posted destination slice to `pending`, and keeps the future recurring amount; mobile calls every such row “Processing.” [Money read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [money copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/90501f847e03cf4cc1071503436acdd459643103/src/lib/money/moneyCopy.ts).
- Minimal fix: Use truthful generic pending copy such as “Not paid yet” unless a confirmed payment-in-progress/trial distinction is supplied.
- Verify: A normal paid-package free trial displays its scheduled price without claiming a payment is processing; an actual paid purchase still reads “Paid.”

### B-349-1 — an unpaid free trial claims “Clients paid” and shows a false fee equation

Normal-user story: A coach opens a client's normal $49 free-trial purchase and is told “Clients paid $49.00” with zero deductions and “Net to you $0.00,” although no payment has happened. [Charge detail](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/35aa81634d377acebf55d1b497abadc4b7b8e7db/src/screens/coach/money/MoneyChargeScreen.tsx), [live Money read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts).

- Location: `src/screens/coach/money/MoneyChargeScreen.tsx:139-177`.
- Evidence: `getChargeBreakdown` returns the package amount as `price_cents` for an unsettled purchase, with zero fees/net; the detail hides the paid-money breakdown only for `failed` and `canceled`, and pending instead renders the “Clients paid” row and “once the payment clears” copy. [Backend breakdown](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [charge detail](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/35aa81634d377acebf55d1b497abadc4b7b8e7db/src/screens/coach/money/MoneyChargeScreen.tsx).
- Minimal fix: For an unpaid/unsettled pending purchase, show the package price as scheduled/not yet paid and suppress the paid-money equation until confirmed billing data exists; do not say a trial's payment is clearing.
- Verify: The ordinary trial fixture in `ordinary-use-evidence.json` produces no “Clients paid” or payment-clearing claim; a settled paid charge retains its actual fee breakdown.

### B-349-2 — the held balance is falsely explained as fees only

Normal-user story: A coach refunds a $100 sale after its payout has reached the bank and Money describes the resulting $100 future-sales hold as the 2% TGP fee and Stripe fees, although it also contains $94.80 of unrecovered payout principal. [Money held-balance copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/35aa81634d377acebf55d1b497abadc4b7b8e7db/src/screens/coach/money/MoneyScreen.tsx), [refund recovery implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/connect/fees/charge-settlement.service.ts), [adjusted financial targets](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/payouts-v2/platform-fee.service.ts).

- Location: `src/screens/coach/money/MoneyScreen.tsx:891-901`.
- Evidence: `heldFromNextSale` sums all open `PayeeRecovery` rows, and an ordinary insufficient-balance reversal opens a recovery for the unrecovered original transfer as well as retained fees; the UI's fixed explanation names only 2% and Stripe fees. [Money hold read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [recovery production path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/connect/fees/charge-settlement.service.ts), [Money copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/35aa81634d377acebf55d1b497abadc4b7b8e7db/src/screens/coach/money/MoneyScreen.tsx).
- Minimal fix: Explain the amount as the outstanding refund/chargeback recovery balance, potentially including retained fees and amounts not recovered from the original payout, collected from future sales.
- Verify: Fee-only and paid-out-refund holds both receive accurate copy; keep the backend's exact amount.

## Checks and split boundaries

Initial #348 and #351 required checks are green. [#348 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153258259/job/111291299197), [#351 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153263885/job/111291315451).

The initial #349/#350 red checks contain exactly three stale navigation assertions in two suites (`paymentsConnectPackages.test.ts`, `coachSaasBlockers.test.ts`); lint/typecheck and all other tests pass, and #351 replaces those assertions and is green. [#349 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153260624/job/111291305680), [#350 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37153262080/job/111291309625), [#351 retirement diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351).

Initial changed-line sizes are 1,343 / 2,587 / 1,722 / 1,851; all four PRs were opened before the 1,500-line cutoff and remain under the applicable 3,000-line cap. [#348](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348), [#349](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349), [#350](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350), [#351](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351).

Recommended operator defaults: one item-list fix round for the three copy/financial-display Bs; no backend behavior change is required for the minimal fixes; land the four slices as one train only after both exact-head lens approvals and green integrated CI.

## HANDOFF

Complete: independent full review plus both conflict hunks and restack delta checked; four exact-head verdicts posted, aggregate A/B/C = 0/3/0, with no other-lens notes/report/verdict read. [#348](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6005027474), [#349](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6005027837), [#350](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350#issuecomment-6005028186), [#351](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351#issuecomment-6005028501).

Operator next step: assign one item-list fix round for **B-348-1**, **B-349-1**, and **B-349-2**, update their directly affected assertions, restack the train, then request delta re-review only of those Bs and changed lines. Recommended defaults are pending copy “Not paid yet,” scheduled-price/no-paid-equation display until billing is confirmed, and an accurate total-recovery explanation; no backend behavior changes are needed for those minimal fixes. Do not treat the two clean later-slice verdicts as approval to land the unresolved earlier money findings.

Evidence remains under `ops/aud-122/AUD-SOL-MON1-122/`: initial/restack diffs, per-slice blob comparison, ordinary-use JSON, direct current N2/N3 CI logs, exact posted comment bodies, and `posted-comment-URLs.tsv`. No own CI branch or lock was created, no source code was changed, and no mobile branch was pushed. The read-only worktree was verified clean and removed by Mon Oct 5 16:06:41 PDT 2026; claims are retained as the exact-head audit trail. All four posted comment bodies/counts were read back and confirmed.
