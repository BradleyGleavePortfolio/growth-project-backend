# AUD-OPUS-D12-118 (lens: Claude Opus 5.5, agent 118 wave) — backend #687 (D1) and #688 (D2)

Started 2026-10-04 09:46 PDT. Finished 2026-10-04 10:17 PDT. Claims: `lanes118/claims/backend-687-f8e47bf4-opus` and `backend-688-b17f514c-opus`.
Prior Opus verdicts: #687 RC 0/1/3 @ c2a901a8 (5975919378); #688 RC 0/1/4 @ 6627044c (5975919515). Earlier report: AUD-OPUS-D12-116.md.

## Verdicts posted
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #687 (D1) | f8e47bf40fe81064d679fc2831cedf3b1cd90b2c | REQUEST CHANGES | 0/1/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5982478903 |
| #688 (D2) | b17f514ccd8da195d18588ca4b7ca407a789f20e | REQUEST CHANGES | 0/2/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982479051 |

Both heads were re-read at 10:16 PDT, right before posting, and were unchanged. The bodies are saved in `/home/user/workspace/ops/aud-118/AUD-OPUS-D12-118/verdict_687.md` and `verdict_688.md`. Sol's verdicts at these heads (5982357490 and 5982357473, posted 10:01 PDT) were not read before these verdicts were written.

## PR state and CI
- **#687:**
  - Base is main `d23fa317`. The PR is BEHIND main `b644198b` but not DIRTY.
  - Size is 2489+/228- = 2,717 lines, in the 1,500-3,000 band, so it needs an operator SIZE ASSESSMENT.
  - All 11 required checks are green (build-and-test run 37174418115).
- **#688:**
  - Base is #687.
  - Size is 2313+/613- = 2,926 lines, in the band, with 74 lines of headroom.
  - The 7 applicable checks are green (run 37178687237). The 4 checks that run only on main-based PRs are absent by design.

## Prior findings decided
- **B-687-1** CLOSED: commit 41404998; failing-before run 37172705221.
- **C-687-2** CLOSED.
- **C-687-3** closed by main #694: the identical jest.config.js hunk is now on main.
- **C-687-4** note only (OR-113-4).
- **B-688-1** CLOSED: commit 09d4038f; failing-before run 37173207695. The 116 probe replayed at this head passes 5/5, plus a card_update control (run 37219161671).
- **C-688-2** CLOSED (env doc).
- **C-688-3** CLOSED: commit 6718d211; failing-before run 37173955536.
- **C-688-4** closed with Sol B-688-2 (due-only sweep and sweep_checked_at rotation).
- **C-688-5** CLOSED (formatMinor).

## New findings (B)
- **B-687-5:** dispute-cycle client emails promise that a card update pays the debt and keeps access.
  - Location: `dunning-v2-client.hbs:9`; `dunning-v2.dispatcher.ts:259-283` passes update_card_url for every cycle kind. The `lr_day3` body falls back to DAY1_EMAIL "attempted it again today", and LR_DAY7_ESCALATION says "Update your card now and I will restore everything at once".
  - Probe: run 37218769772. The payment-cycle control passes; the 2 dispute-cycle probes fail.
  - Fix rule: dispute-cycle surfaces never promise that a card update helps. They state what happened, what ends the cycle (the dispute closing in the client's favour), the lock date and the support path. Payment-cycle copy makes no success claim before the payment goes through.
- **B-688-6:** the tryLock CAS (`dunning-v2.service.ts:903-917`) fences `entered_at` only.
  - A v1 reopen keeps `entered_at` and sets step -1, so a stale sweep worker locks the reopened cycle on its Day 0. The v2 Day-0 claim then fails, and the client is locked with no notices.
  - Probe: run 37219161671, part 2. Both probes fail; both controls pass.
  - Fix rule: add `step_index: row.step_index` to the CAS (as advance does), or re-read under the lock and require step >= 0 with the same entered_at.
- **B-688-7:** unresolved tokens.
  - `buildDispatchContext` (`:1606-1617`) passes `cardLast4: default_card_last4 ?? undefined`. That field is null until the first card update, because checkout saves the card on the subscription. It also never passes `reason`.
  - Result: the Day-1 client email reads "The card on file ends {cardLast4}.", and the Day-7 coach email reads "declined ({reason})" four times.
  - Probes: runs 37219161671 and 37219503806, part 4. The control passes; the 2 probes fail.
  - Fix rule: take last4 from the payment method actually charged, or use a variant without the card clause. Use real attempt history or a variant without history. Add a test that renders every surface and variant and finds no `/\{\w+\}/`.

## Follow-ups (C)
- **C-687-6** `src/email/templates/dunning-v2-client.hbs:11` (same block as B-687-5): the 2A "End my plan" sentence does not say that access ends at once. Fix rule: add "Access ends right away." to that sentence.
- **C-687-7** `src/checkout/dunning-v2/dunning-v2.dispatcher.ts:337` with main `src/notifications/notifications.service.ts:598-599`: the coach push body shows the raw alertType `dunning_step7`. Fix rule: pushToCoach takes a display body (renderer.coachPush) and never puts the alertType in the body.
- **C-687-4** Migration order: note only, under OR-113-4.
- **C-688-8** `src/checkout/dunning-v2/dunning-v2.service.ts:1287,1344`: a not-won onDisputeClosed converts the active cycle even when the obligation was already terminal before this cycle. Fix rule: convert only when the upsert created the row or advanced it to terminal (priorStatus null or not terminal).
- **C-688-9** `src/checkout/dunning-v2/dunning-v2.service.ts:903,921-924` against `:944-949`: tryLock locks DunningState and then ClientPurchase; the invoice.paid transaction locks ClientPurchase and then DunningState, so a deadlock is possible. Both sides are retry-safe. Fix rule: lock ClientPurchase first in tryLock.
- **C-688-10** `src/checkout/dunning-v2/dunning-v2.service.ts:1617` (same lines as B-688-7): the coach email "full record" link is `tgp://`, which mail clients do not make clickable. Fix rule: use the https universal link.
- **Outside the diff (main):** the dispute-cycle copy in `dunning-v2.copy.ts:180-208` and `renderer.ts:185/200` makes the same promise as B-687-5. The COACH_EMAIL "four declines on Days 0/1/3/7" can be false on hard declines (covered by the B-688-7 fix rule).

## Operator decisions (recommended default first)
1. **SIZE ASSESSMENT for #687 (2,717) and #688 (2,926).** Default: accept both as cohesive, and move the B-688-6 and B-688-7 fixes so that #688 stays under 3,000. The B-688-7 renderer and copy fallback can land in D1 (283 lines of headroom), and the B-688-6 CAS line in D2 (about 5 lines).
2. **Main dispute-cycle copy (`copy.ts:180-208`).** Default: fix it in the same D1 round as B-687-5, because it is the same message.
3. **Stack landing.** Default: unchanged. Land D1-D5 as one, and deploy after D5. D2's change to the v1 email-link default needs D4's page.
4. **Next round.** Default: one builder FIX ROUND covering B-687-5 (D1), B-688-6 and B-688-7 (D2, renderer part in D1), with C-687-6 and C-688-10 on the same lines. Then a restack and fresh dual audits at the new heads.

## Evidence and cleanup
- **Probe specs** (copied to the notes folder): `aud-opus-d12-118-687.probe.spec.ts` and `aud-opus-d12-118-688.probe.spec.ts`. The log of run 37219503806 is saved there as `run_37219503806.log`.
- **Probe runs:**
  - 37218769772 (#687): 2 failed, 24 passed.
  - 37219161671 (#688, probe + 2 builder specs): 3 failed, 48 passed.
  - 37219503806 (#688, probe only): 4 failed, 10 passed.
  - Earlier: 37218746493 (#688 first run): 2 failed, 21 passed.
  - Every failure was a predicted probe case.
- **Cleanup:**
  - Branches `audit/AUD-OPUS-D12-118/688-probes` and `audit/AUD-OPUS-D12-118/687-copy` were deleted on origin; no ci/* branches were created.
  - Worktrees `wt/AUD-OPUS-D12-118-1` and `-2` were removed (no node_modules linked), and `git worktree prune` was run.
  - No money was spent.

## Progress
- 09:46 Read the rules and claimed both heads.
- 09:50-09:58 Read the D1 delta c2a901a8..f8e47bf4 (the 5f9d081b move is byte-identical to D2@6627044c) and the D2 delta 6627044c..b17f514c (09d4038f, 6718d211, merges).
- 09:58-10:10 Wrote the probes and ran CI: runs 37218746493, 37218769772, 37219161671, 37219503806.
- 10:16 Re-read the heads and posted both verdicts.
- 10:17 Cleaned up and finalized this report.

## HANDOFF
Done. Both verdicts are posted at the exact heads (REQUEST CHANGES; #687 0/1/3, #688 0/2/3). Open Bs: B-687-5, B-688-6 and B-688-7, each with a probe, a run URL and a fix rule. Claims stay in lanes118/claims for the operator to release. No branches or worktrees from this job remain.
