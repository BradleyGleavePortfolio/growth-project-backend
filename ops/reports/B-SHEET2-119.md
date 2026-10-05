# B-SHEET2-119 — builder (agent 119), mobile payment sheet P1 #342 + P2 #343 (+ #344 merge-only restack)

Started 12:32 PDT 10-04. Lock ops/lanes119/locks/sheet taken 12:30.

## Start heads
| PR | head | base |
|---|---|---|
| #342 P1 | 56f281ad3aa977882c962a6591d3594899cdd5a1 | main cc4ceeed (BEHIND) |
| #343 P2 | fd739d5819c232764e0389afd778860bf452b41c | #342 branch |
| #344 P3 | e7fcc5d2504e8c3948494ee847e16ff4937b78c3 | #343 branch |

## Open findings
- #342 Sol B-342-1 (no-status transport = offline/no charge), B-342-3 (zero/three-decimal currency exponent).
- #343 Opus B-343-6(O) claimFree saleKind; Sol B-343-1 rejected poll fence, B-343-3 Open your plan truth, B-343-6(S) ended != unpaid (+Opus C-343-4).

## Progress log
- 12:30 rules read; worktrees wt/B-SHEET2-119-{1,2,3}.

- 12:40 S1: merged main (69de3c2), test 9498144, fix 0b1985f (local). Lanes: before 37229072837, after 37229115669.

- 12:47 pushed: #342 0b1985f46ae2d4baadfcc6a02f8257c2f504249d, #343 19678ce780d497513764a7827447c106fb14205e, #344 25af65691fbf60a3501a77624de8eafd0ccd81d3 (restack).
  S1 lanes: before 37229072837 (19 failed / 63 passed), after 37229115669 (81/82; only held C-342-1 isCombo probe red).
  S2 lanes: before 37229398426 (16 failed / 86), after 37229423237 (tsc pass; 101/102; only the historical openPlanAction copy's old offline assertion, superseded by B-342-1).
  S2 size 2,933 after moving PackageSelectionSheet.contrast.test.tsx (71) byte-identical to #344. Waiting for PR CI.

- 12:53 FIX ROUND 2 + READY posted on #342 and #343, READY (restack) on #344; PR bodies updated (tier header, Fix rounds row 2).
- 12:54 notify/sheet.txt written; lock released; ci/B-SHEET2-119-* branches deleted; worktrees and local branches removed. Comment bodies: ops/aud-119/B-SHEET2-119/fixround2_34{2,3,4}.md.

## Result
| PR | head | round | size | CI | comment |
|---|---|---|---|---|---|
| #342 S1 | 0b1985f46ae2d4baadfcc6a02f8257c2f504249d | FIX ROUND 2, READY | 2,153 | Typecheck/lint/test 37229614904, CodeQL 37229614891 green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5983790118 |
| #343 S2 | 19678ce780d497513764a7827447c106fb14205e | FIX ROUND 2, READY | 2,933 (67 headroom) | Typecheck/lint/test 37229616131 green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5983790258 |
| #344 S3 | 25af65691fbf60a3501a77624de8eafd0ccd81d3 | FIX ROUND 2 restack, READY (restack) | 2,156 | Typecheck/lint/test 37229617205 green | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5983790388 |

Closed: B-342-1 (no-answer copy), B-342-3 (per-currency minor units, utils/currency.ts), B-343-6 Opus (claimFree saleKind free), B-343-1 Sol (rejected-read fence, pollPlan tri-state), B-343-6 Sol + Opus C-343-4 (ended -> endedWhileConfirming), B-343-3 Sol + Opus C-343-3 (label "Continue to the app" + onDismiss when no onOpenPlan).
Expected red probes: Opus C-342-1 isCombo (held C); the old offline assertion inside Sol's openPlanAction copy (superseded by B-342-1).

## Follow-ups (C)
- C-SH2-1 src/screens/coach/payments/CoachPackageEditScreen.tsx:133,299 via src/utils/currency.ts parseDollarsToCents: multiplies by 100 for every currency (a JPY coach entering 4900 would store 490000). Fix rule: parse with currencyMinorUnits(currency).exponent.
- C-SH2-2 src/entitlements/PaywallSheet.tsx:361 `pkg.price.toFixed(2)` and src/api/clientPaymentsApi.ts:338 `price = amountCents / 100`: major-unit price is not exponent-aware. Fix rule: display from formatCurrencyCents(amountCents, currency).
- C-SH2-3 Day1WinScreen.tsx:190-194, 229-233 and RootNavigator.tsx:908-912: pass an onOpenPlan that lands on Membership (after onboarding completes) so the action can read "Open your plan" there too.
- Opus C-343-5 (inFlightRef not epoch-tagged) and C-343-6 (CTA live after a completed notice) unchanged; Opus C-342-4/5/6 unchanged; held C-342-1, C-342-2, C-343-2.

## Operator decisions
1. #344 round carries two test-only commits (contrast test moved byte-identical from #343 for size; one offline expectation follows B-342-1). Recommended default: accept as the restack; short lens delta on #344.
2. formatCurrencyCents change is global (coach earnings/packages screens now also use the right exponent). Recommended default: accept (correct for every Stripe minor-unit caller; USD output unchanged).
3. #343 has 67 lines of headroom. Recommended default: any further #343 test goes to #344 or a new piece.

## HANDOFF
- Builder done: READY FOR AUDIT at #342 0b1985f4, #343 19678ce7, READY (restack) at #344 25af6569; all required checks green. Next: Opus 5.5 + Sol audits at those exact heads (short delta on #344).
- Nothing running; lock released; notify written; ci/* branches and worktrees removed.
