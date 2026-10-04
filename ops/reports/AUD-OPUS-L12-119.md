# AUD-OPUS-L12-119: mobile lockout L1 #352 and L2 #353

Lens: Claude Opus 5.5, agent 119. Tier T4. Started 12:43 PDT 10-04; verdicts posted 12:57 PDT 10-04.
Claims: `lanes119/claims/mobile-352-ac244d22-opus`, `mobile-353-05d84f27-opus`.

## Verdicts
Both heads were re-read right before posting.

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#352 (L1, base main) | ac244d22e107e93209a5e1d206d2951d3392fe38 | REQUEST CHANGES | 0/1/5 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983819724 |
| mobile#353 (L2, base #352 branch) | 05d84f27261f1f764214be5a379785ba8f690d3e | REQUEST CHANGES | 0/2/6 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5983819833 |

Verdict bodies: `ops/aud-119/AUD-OPUS-L12-119/verdict_352_ac244d22.md` and `verdict_353_05d84f27.md`.

## Evidence
- **#352 evidence reuse.** The earlier Opus APPROVE at `58b80914` is reused for the unchanged lines. The main merge `fe2fa580` has the same tree as `merge-tree 58b80914 7fdb629a` (`52f98331`). Fix `ac244d22` was audited line by line.
- **#353.** Full T4 audit, no evidence reused. The L1 merge `1fbb7837` has the same tree as `merge-tree e22acc84 ac244d22` (`2eda16d8`).
- **Main.** `cc4ceeed` (#368) overlaps no file in #352 or #353, so an update-branch is eligible for the rule 12 tree check.
- **CI lane runs** (probe specs only; branches deleted):

| Run | Head | Result |
|---|---|---|
| [37229725928](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229725928) | #352 | 4 PROBE fail as predicted; CONTROL and the L1 suites pass (19/23) |
| [37229737102](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229737102) | #353 | Probes plus the head's suites (90 tests). One CONTROL failed on a probe date regex (harness error); fixed in the next run |
| [37229975212](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229975212) | #353 | 7 PROBE fail as predicted; 2 CONTROL pass; replay of the AUD-OPUS-L12-117 probe passes 12/12 |

- **Probe files:** `ops/aud-119/AUD-OPUS-L12-119/aud119OpusL12_352.probe.test.ts` and `aud119OpusL12_353.probe.test.tsx`. Run logs are in the same folder. These are the regression oracle: after the fix, every PROBE must pass.

## Prior Opus findings decided
- **#352:**
  - C-352-4: closed.
  - C-352-5: closed for the dispute facts; the wording is now B-352-7.
  - C-352-1, C-352-2, C-352-3, C-352-6: open.
- **#353:**
  - B-353-1, B-353-3, B-353-4: closed.
  - B-353-2: closed against the old dispute contract, but superseded by R-DISPUTE-PAUSE (now B-353-6 and B-353-7).
  - C-353-3: closed.
  - C-353-2: closed for the current visit; the remainder is open.
  - C-353-1, C-353-4, C-353-5: open.

## Open B findings (builder must fix)
- **B-352-7** (`dunningErrorCopy.ts:456-460`, `:496-498`, `:531`, `:588-592`): the dispute copy says "Email support to sort it out". It never says that access has ended, that billing is paused, or that the coach decides on restarting.
  - Fix: one shared R-DISPUTE-PAUSE sentence in L1. The next step is to message the coach.
- **B-353-6** (`DunningBanner.tsx:25-33`, `UpdateCardScreen.tsx:85-88`): a dispute shows a lock date and a grace period ("Access pauses on <date> unless it is sorted out by then").
  - Fix: never show a lock date or keep-access wording for a dispute, in any state.
- **B-353-7** (`DunningLockoutScreen.tsx:57-60, 74-77, 90-92, 193, 208-225, 273`; `UpdateCardScreen.tsx:88, 338`; `DunningBanner.tsx:31`): the dispute surfaces send the client to support "to sort it out" and never state the coach-restart rule. They also show "Already paid? Pull down", Update card, and "used for your future payments".
  - Fix: on every dispute surface:
    - use the shared ruling sentence;
    - make "Your access has ended" the title and messaging the coach the primary action;
    - hide Update card and the footnote;
    - drop "access ends now" from the end-plan dialog.
  - Update the dispute tests that pin the old wording (`dunningLockoutOwnership.test.tsx:390-472`).

## Follow-ups (C)
Frozen; the operator tickets these.

| ID | Where | Problem | Fix rule |
|---|---|---|---|
| C-352-1 | `updateCard.ts` / `dunningErrorCopy.ts` reference handling | Support references do not follow the shared conventions | Use `supportReferenceOf` / `shortReference` and the Sentry `reference` tag |
| C-352-2 | process | — | Land #352 -> #354 as one unit |
| C-352-3 | `dunningErrorCopy.ts` RATE_LIMITED | "Wait a minute" while `Retry-After` is 3600; dead `step` branch | Use `Retry-After`; remove the dead branch |
| C-352-6 | outside this diff (#342) | #342 duplicates the PaymentSheet theme builder and SDK loader | Converge on one module |
| C-352-8 | `dunningLockoutStore.ts:17-19, 111-114` | The 'login' listener never fires: nothing emits the named 'login' event | Fix the comment, or emit 'login' on sign-in |
| C-353-1 | `dunningErrorCopy.ts` | "Tap Update card to try again" on a screen whose buttons read "Add a card" / "Try a different card" | Copy names the buttons that are on screen |
| C-353-2 (remainder) | `UpdateCardScreen.tsx:352-354` | On a later visit with a bank step pending, "was declined" can describe the new card | Carry a server flag for the declined card |
| C-353-4 | `ClientPackagesScreen.tsx` (= C-322-3) | Ordering against #334 | Keep the native UpdateCard route; no hosted portal |
| C-353-5 | release order | — | New binary (fingerprint), and backend AASA `/billing/update-card` before the universal link ships |
| C-353-6 | `DunningLockoutScreen.tsx:103-107` | Support email body says "after a failed payment" for a dispute | Kind-aware or neutral body |
| C-353-7 | `src/screens/client/README.md:165` | Says "Stripe Billing Portal" | Say native UpdateCard screen |

## For other jobs
For B-DUNSPLIT-119 / D2c: the mobile needs to know how a dispute pause is reported. Recommended default: `GET /v1/checkout/dunning` returns `state: 'locked', kind: 'dispute'`, with `lockout_at` null, for the paused plan. The mobile then shows the dispute lockout with the ruling copy. If D2c ends access through entitlement instead, the paywall shows and the mobile dispute copy is never reached; tell the mobile builder either way.

## CI state
| PR | Required checks | Merge state |
|---|---|---|
| #352 @ ac244d22 | All 3 pass (Typecheck, lint, test; Analyze JS/TS; Analyze actions) | BEHIND main `cc4ceeed` (no overlap) |
| #353 @ 05d84f27 | Typecheck, lint, test pass (only required check on a stacked base) | CLEAN |

## Operator decisions
Recommended default for each:
1. **Where the fix lives.** One builder round on #352 and #353:
   - L1 holds the shared ruling sentence (B-352-7).
   - L2 uses it and fixes B-353-6 and B-353-7.
   - Then restack #354 merge-only.
   - Both lenses re-audit; #354 gets a short delta.
2. **Dispute contract for D2c:** as in "For other jobs" above. The mobile copy fix does not need to wait for it: the copy depends only on the ruling.
3. **#352 update-branch to `cc4ceeed`:** after the fix round, using the MERGE-ONLY TREE CHECK.
4. **Landing:** unchanged. #352 -> #354 land as one, after the dunning backend (including D2c) deploys, with `FEATURE_DUNNING_V2` off.

## Cleanup
- Branches `audit/AUD-OPUS-L12-119/352-dispute-pause` and `353-dispute-pause` deleted (0 remain).
- Worktrees `wt/AUD-OPUS-L12-119-1` and `-2` removed.
- Nothing pushed to a PR branch, nothing merged, no production action, no money spent.

## HANDOFF
- **#352 @ ac244d22:** Opus REQUEST CHANGES 0/1/5 ([comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5983819724)). Open: B-352-7.
- **#353 @ 05d84f27:** Opus REQUEST CHANGES 0/2/6 ([comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5983819833)). Open: B-353-6, B-353-7.
- **Next:**
  1. A builder fixes B-352-7, B-353-6 and B-353-7, replays both probe specs above (every PROBE must pass), and restacks #354.
  2. A fresh Opus lens audits the new heads. It can reuse this verdict for everything outside the dispute-copy delta, after a delta check.
  3. L3 #354 (f084cc0f) still needs its short delta from a lens.
- Lane ended 12:58 PDT 10-04.
