FIX ROUND 3 (B-SHEET4-119, agent 119) — growth-project-mobile#343 @ 691e0cf02a48db3e2d62f7c502673d9f1ef62215

Answers AUDIT GPT-6.1 Sol (REQUEST CHANGES 0/1/6, issuecomment-5984020426) and AUDIT Claude Opus 5.5 (APPROVE 0/0/6, issuecomment-5983935229) at `19678ce7`. Tier T4 (payments, account fences). First the fixed S1 merged in (`40b8573`, clean, merge-only: #342 FIX ROUND 3 `e3226f3`), then one fix commit (`691e0cf`).

Size: +2,675 / -260 = 2,935 changed lines (tests included). Grandfathered PR, under its 3,000 ceiling (65 left). The new regression suite lives in #344 per the operator's size rule.

## Finding -> change -> commit -> test

| Finding | Change | Commit | Test (#344 src/hooks/__tests__/usePackagePurchase.nativeFence.test.tsx) |
|---|---|---|---|
| B-343-1 (Sol, residual): a rejected initStripe / initPaymentSheet await skipped live() in runSheet's catch (usePackagePurchase.ts:406-412 at the old head); logout/login then rejection published the old account's `stripe_sheet_init_threw` notice and reference and sent its Sentry event | The catch checks `live()` first and returns STALE before any notice is built or reported; both callers (one-time :820, subscription :1075) re-check `outcome.kind === "stale" \|\| !live()` after `await runSheet`, before any state, ref, key or callback effect. Every await in the sheet path is now fenced fulfilled and rejected | 691e0cf | 8 cases initStripe/initPaymentSheet x one-time/renewing x logout/login: state idle, no notice, no reference, no Sentry, no next native call; 2 unmount cases (no report); 2 same-account controls (actionable notice, reference, one report) |
| B-342-1 consumer (S1 copy) | PackageSelectionSheet.payment.test.tsx:346 now pins the new wording with the attempt reference | 691e0cf | same file |

Failing before (#343 head with S1 merged, no fix, plus the new suite and both lenses' probes): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232859355 — 20 failed / 73 (10 new, 8 Sol nativeRejection, Opus Q5 INFO, the old PACKAGE_NOT_FOUND copy pin).
After (same specs at this head): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233062601 — 97 / 98; the one red test is Opus Q5 INFO (C-343-8, red by design).
Top tree (#344 head, 21 suites, both lenses' probes, all package suites): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233045102 — 354 / 355, same Opus Q5 only.
Required check at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232961197 pass. Both Analyze contexts run only on PRs based on main (stacked base): final-main gate.

## Probes replayed at this head (both lenses)

| Probe | Origin | Result |
|---|---|---|
| 4 x rejected initPaymentSheet after logout/login (one-time, renewing) | Sol audSolS12119.nativeRejection (run 37231087091) | pass (failed before) |
| 4 x rejected initStripe after logout/login (one-time, renewing) | Sol continuation | pass (failed before) |
| archived package on a same-key retry after an unknown outcome (S1-owned) | Sol | pass |
| controls: fulfilled init after logout retired; same-account rejection actionable | Sol | pass |
| Q1 no answer keeps the key; Q2 ended copy neutral; Q3 Continue to the app; Q4 free reroute copy | Opus audOpusS12119.probe343 | pass |
| Q5 INFO (C-343-8) Open your plan without a destination | Opus | FAIL, red by design (follow-up C) |
| Prior rounds, top tree https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233619554: Sol Sh118 remainingBoundary, endedIsNotUnpaid; Opus Sh118 probe343; Opus P12117 probe343; Sol P12117 purchaseBoundary, paymentTheme | earlier lenses | pass |
| Sol Sh118 openPlanAction: old offline copy and old PACKAGE_NOT_FOUND copy pins | earlier Sol | 2 FAIL, superseded by Sol's own B-342-1 rules (round 2 and this round); its other cases pass |

## Money list self-check
- Webhook order and redelivery: the app consumes no webhooks; a retired operation can no longer publish or report, so a late native answer cannot overwrite the new account's state.
- Concurrency (two workers, lock order): one key per package and sale kind; a rejected native call of a retired epoch now ends silently; inFlightRef ownership by epoch stays C-343-5 (not these lines).
- Terminal states (refunded, disputed, canceled, deleted account): unchanged; logout/login (including account deletion sign-out) clears keys and refs and no old notice returns.
- List pagination and completeness: plan reads unchanged (bounded, fenced, fail closed to "not confirmed").
- Currency: unchanged (presentment minor units from S1).
- Copy truth: no old-account reference or notice after an account change; refusal copy from S1 makes no money claim.

Opus Cs on these lines: none (C-343-5 is start/finally, C-343-6/8 the sheet CTA; not folded). Follow-up Cs: ops/reports/B-SHEET4-119.md.

READY FOR AUDIT
