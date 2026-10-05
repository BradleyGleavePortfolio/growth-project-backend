# AUD-OPUS-L12-117: mobile dunning lockout pieces #352 (L1) and #353 (L2)

Lens: Claude Opus 5.5, agent 117. Tier T4. Job entry: JOBS117.md "AUD-OPUS-L12-117 / AUD-SOL-L12-117". Written 2026-10-03, about 22:55 PDT.

## Verdicts (one per PR per head, re-read right before posting)
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#352 (L1, base main) | 58b80914feb62101aca2c7b5e8985d32912b80b0 | APPROVE | 0/0/6 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5977022730 |
| mobile#353 (L2, base agent115/lockout-split-1-dunning-data) | e22acc84b3ee99c94f3ec77793b38ca0c8157241 | REQUEST CHANGES | 0/4/5 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5977022872 |

The Sol lens had already posted REQUEST CHANGES on both PRs when these verdicts went up (seen in `prstate.sh`). Its text was not read, so these verdicts are independent of it. Verdict bodies: `/home/user/workspace/ops/aud-117/AUD-OPUS-L12-117/verdict_352_58b80914.md` and `verdict_353_e22acc84.md`.

## Split faithfulness (proven)
- **Same tree as the approved original.** The #354 stack top `37ed3d56` has tree `8f0a2730`, which equals `git merge-tree --write-tree 23435ec2 367e6c48`. That is #322's dual-approved head merged with main.
- **Each file in exactly one piece.** Each file appears in exactly one of #352, #353 or #354 with its final content.
- **Byte-identical except `app.json`.** Every file matches `23435ec2`, except `app.json`: the 9-line intent filter is identical, and the rest is main #305 (`runtimeVersion` fingerprint, `updates`, `versionCode 5`).
- **Main merge overlap.** The main delta `1f8981dd..367e6c48` (#305, #326, #327) overlaps #322 only in `app.json`.
- **Current main.** Main is now `7fdb629a` (#315). The stack top merges cleanly with it. #315 touches `SupportEmailFallback.tsx` (L2), `src/screens/client/README.md` (L2) and `src/services/README.md` (L1).

## Evidence reuse (G09)
- **What was reused.** The Opus approval of #322 @ `23435ec2` ([5964778187](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/322#issuecomment-5964778187)), but only for the closures of B-322-1, B-322-2, C-322-1 and C-322-2. All four still hold in the pieces.
- **What was audited fresh.** Every line of both pieces at T4. The semantic effect of main #305, #326 and #327. The paired backend at #691 `e0afe678`, including two changes made after #322 was approved:
  - backend `67096788` (2026-10-04 03:18 UTC): "disputed cancel is 2A";
  - main #315: the "write to us" copy fix.

## Probe evidence
CI lane [run 37180275904](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180275904), on branch `audit/AUD-OPUS-L12-117/353-probes` built from `e22acc84`. The branch added one probe spec only (`src/entitlements/dunning/__tests__/aud117OpusL12.probe.test.tsx`; copy kept at `/home/user/workspace/ops/aud-117/AUD-OPUS-L12-117/probe_353_aud117OpusL12.probe.test.tsx`).
- **Result:** Suites 1 failed, 1 passed. Tests 9 failed, 40 passed, 49 total.
- **Probe file:** 9 PROBE cases fail as predicted and 3 CONTROL cases pass.
- **Head's own suite:** `dunningLockout.test.tsx` passes 37 of 37.
- **Log:** `/home/user/workspace/ops/aud-117/AUD-OPUS-L12-117/run_37180275904.log`.

## Findings
### #353 (B = 4)
- **B-353-1: a lockout carries over to the next account on the same phone.**
  - Cause: the module store (`dunningLockoutStore.ts:27-28`) is never reset at sign-out or sign-in. The providers start from the stale value (`DunningLockoutProvider.tsx:73`, `EntitlementProvider.tsx:68` hiding the paywall at `:172`). The reset at `:107-108` never runs, because `RootNavigator.tsx:950,980` always passes `enabled`. `refresh` (`:86-93`) writes the store after an `await` without checking the session. The previous account's request id is shown as the reference (`:199`).
  - Effect: account B sees A's lockout until B's status read succeeds. If that read fails, B stays on it.
  - Probes: 2 fail.
  - Fix: reset on `authEvents` logout/login or on provider unmount. Never show a stale store value. Use a session-generation guard. Add tests.
- **B-353-2: a dispute lock is described as a declined payment that a new card fixes.**
  - The lockout screen, the Update card intro and the banner all say this (`DunningLockoutScreen.tsx:37-44,88,120,138-139`; `UpdateCardScreen.tsx:76-90`; `DunningBanner.tsx:13-18`).
  - The end-plan dialog for a dispute says access lasts to the end of the paid period (`UpdateCardScreen.tsx:104-107`). Backend #691 `67096788` made a disputed cancel 2A, ending access now (`client-billing.service.ts:1549-1552,1636,1645`).
  - Probes: 4 fail.
  - **This is cross-repo contract drift.** The backend changed after mobile #322 was approved, so the job's premise that the contract is "unchanged" does not hold for disputes.
- **B-353-3: first person in client copy.** "We charge it right away" (`DunningLockoutScreen.tsx:138`, pinned at `dunningLockout.test.tsx:182`) and "Stripe, our payment provider" (`UpdateCardScreen.tsx:461`). Probes: 2 fail.
- **B-353-4: the lockout overlay does not block screen readers (WCAG 2.2 AA).** It is a plain absolute `View` over `{children}` (`DunningLockoutProvider.tsx:184-187`), with no `accessibilityViewIsModal` and no hidden subtree. Screen readers reach the covered app. Probe: 1 fails; its CONTROL passes.

### #353 (C = 5)
- **C-353-1:** copy says "Tap Update card", but the Update card screen's buttons read "Add a card" or "Try a different card".
- **C-353-2:** "card on file ... was declined" can describe a newly saved card.
- **C-353-3:** for `lock_waived` cycles the banner shows a lock date that has already passed.
- **C-353-4:** C-322-3 carried (see the operator section).
- **C-353-5:** release order. The fingerprint change means a new binary is needed. The backend AASA must deploy first.

### #352 (B = 0; C = 6)
- **C-352-1:** main #326 reference conventions are not adopted (`supportReferenceOf`, `shortReference`, Sentry `reference` tag). The lost-confirm path shows no reference.
- **C-352-2:** L1's behaviour tests live in L2 and L3. Land #352 -> #354 as one (rule 11).
- **C-352-3:** `RATE_LIMITED` says "Wait a minute", but the bucket is 20 per hour and `Retry-After` is 3600. The `step` branches are dead code.
- **C-352-4:** the interceptor `LOCKED_DUNNING` message is false for a dispute lock.
- **C-352-5:** outcome copy drops the server's dispute facts and `quote.disputes`. This is the L1 half of B-353-2.
- **C-352-6 (outside this diff):** #342 adds a second PaymentSheet theme builder and a second SDK loader. Whichever merges second unifies them.

## Cross-PR notes for the operator
1. **#334 split (#342/#343).** Neither touches `ClientPackagesScreen.tsx` now. C-322-3 still applies to whichever later piece brings the #334 past-due banner: keep the native `UpdateCard` route and never bring back the portal call.
2. **#342** duplicates the PaymentSheet theme builder and SDK loader (C-352-6).
3. **Backend #689/#691 B-689-4 (disputed cancel = 2A)** makes the mobile dispute end-plan copy false (B-353-2). Tell the dunning builder that this contract change has mobile consequences. No backend change is requested.

## CI state
| PR | Checks | Merge state |
|---|---|---|
| #352 @ 58b80914 | Typecheck, lint, test; Analyze (javascript-typescript); Analyze (actions); CodeQL: all SUCCESS | BEHIND main `7fdb629a` |
| #353 @ e22acc84 | Typecheck, lint, test: SUCCESS (only check on a stacked base) | CLEAN |

## Operator decisions (defaults)
1. **Where the B-353-1 fix lives.** Default: in L2 (provider unmount/login reset plus a session guard), which keeps #352's head. If the builder edits the L1 store or interceptor, #352 needs a new verdict.
2. **Dispute next step in copy.** Default: mirror the backend ("Saving a card does not settle that; contact support"), and keep the card action hidden for disputes. Fix C-352-5 in L1 in the same round. That moves #352 and needs a new #352 verdict.
3. **#352 update-branch to main `7fdb629a`.** This is not byte-identical, because `src/services/README.md` changes (rule 12). Default: update once after the fix round, then get short merge-only delta verdicts.
4. **Landing.** Default: land #352 -> #354 as one, after backend #687-#691 deploy, with `FEATURE_DUNNING_V2` OFF. Native PaymentSheet, 3DS and redirect acceptance on devices are release gates.

## Cleanup
- Remote branch `audit/AUD-OPUS-L12-117/353-probes` deleted. No other `AUD-OPUS-L12-117` branches remain.
- Worktrees `/home/user/workspace/wt/AUD-OPUS-L12-117-1` and `-2` removed.
- Claims kept: `/home/user/workspace/ops/lanes117/claims/mobile-352-58b80914-opus`, `mobile-353-e22acc84-opus`.
- Nothing pushed to a PR branch, nothing merged, no production action, no money spent.

## HANDOFF
- #352 @ `58b80914`: Opus APPROVE 0/0/6 ([comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/352#issuecomment-5977022730)).
- #353 @ `e22acc84`: Opus REQUEST CHANGES 0/4/5 ([comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/353#issuecomment-5977022872)). Open: B-353-1 cross-account lockout, B-353-2 dispute copy and 2A contract drift, B-353-3 first person, B-353-4 overlay accessibility.
- **Next:** the builder fixes B-353-1..4 (and C-352-5 if decision 2 is accepted), then lenses re-audit the new heads. Use the probe spec above as the regression oracle: all 9 PROBE cases should pass after the fix.
- Notes: `/home/user/workspace/ops/aud-117/AUD-OPUS-L12-117/`. Lane ended.
