# AUD-SOL-SH-118 — payment sheet lens (agent 118)

## Status

Audit in progress at the two assigned heads: #342 `56f281ad3aa977882c962a6591d3594899cdd5a1` and #343 `fd739d5819c232764e0389afd778860bf452b41c`; both have successful applicable checks, with #343 CodeQL still a final-main landing gate. ([#342 fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5982491578), [#343 fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5982491752))

## Scope and evidence

- Independent T4 review of payment-contract copy, account/lifecycle fences, idempotency recovery, trial consent, and piece boundaries; no candidate-source changes.
- Prior Sol findings to disposition: #342 B-342-1, B-342-2, C-342-1 and #343 B-343-1 through B-343-5, plus original B-334-3/4 and C-334-3. ([Prior #342 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5976926407), [prior #343 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5976959713))
- Builder claims failing-before proof and replay of both lenses' probes; these are inputs to review, not an inherited verdict. ([#342 fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5982491578), [#343 fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5982491752))

## Findings

- B-342-1 appears only partly closed: coded failures and unknown HTTP statuses are neutral, but any request without `response.status` is still classified as offline and claims “nothing was charged,” even on a replay following an unclear native result. ([Exact mapper](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/56f281ad3aa977882c962a6591d3594899cdd5a1/src/lib/packagePayment.ts#L789), [probe run pending](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220350807))
- B-343-1 native fences repair the original held intent/sheet counterexamples, but rejected plan reads bypass the post-read account fence; poll exhaustion may call `showSlow` and publish the previous account's confirmation UI after logout/login. ([Exact poll/callback boundary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fd739d5819c232764e0389afd778860bf452b41c/src/hooks/usePackagePurchase.ts#L501-L566), [probe run pending](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220350184))
- B-343-3's flags are consumed, but the new “Open your plan” action on uncertain/replay notices takes the actual Day 1 caller's `onPaymentSuccess` fallback; that callback exits onboarding to the main app/logger, not Membership. ([Sheet fallback](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fd739d5819c232764e0389afd778860bf452b41c/src/components/PackageSelectionSheet.tsx#L247-L254), [actual caller](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fd739d5819c232764e0389afd778860bf452b41c/src/screens/client/Day1WinScreen.tsx#L189-L194), [root handoff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/fd739d5819c232764e0389afd778860bf452b41c/src/navigation/RootNavigator.tsx#L772-L797))

## Execution

- Own test-only probes run in the CI lane: S1 `2710c184` and S2 `b55c2da7`; pending execution results, not claimed failures. ([S1 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220350807), [S2 lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220350184))
- Builder S2 replay reports successful execution and S1 replay fails only the explicitly deferred legacy zero-recurring-amount combo case; logs and tree applicability remain to be independently verified. ([S2 replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219714087), [S1 replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219370245))

## Follow-ups (C)

Pending classification; preserve the freeze and report unrelated Cs rather than requesting builder scope expansion.

## HANDOFF

- Claims acquired for both assigned heads; isolated detached worktrees under `wt/AUD-SOL-SH-118-{342,343}`.
- Next: finish full piece/delta and call-site review, verify prior closures, run any new focused counterexamples in the CI lane, re-read heads/checks, and post one verdict per PR.
