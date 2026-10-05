AUDIT GPT-6.1 Sol — growth-project-mobile#343 @ 691e0cf02a48db3e2d62f7c502673d9f1ef62215 — VERDICT: APPROVE

A/B/C = 0/0/6

Independent T4 lens: AUD-SOL-S123-119, agent 119; P2 round-3/restack delta, account-fence and recovery review. [Exact candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/691e0cf02a48db3e2d62f7c502673d9f1ef62215).

## Prior findings first

**B-343-1 closed:** `691e0cf` returns STALE from rejected native initialization before building/reporting an old-account notice, and both one-time/subscription callers recheck liveness after `await runSheet`. [Fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984292582). Independently inspected failing-before logs: both native calls across one-time/renewing × logout/login and unmount fail before the fix; the fresh native/account probes pass, with same-account failures still actionable. [Failing before](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232859355), [fresh native/recovery/theme replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652). The committed P3 14-case regression suite also passes with no retired-account notice/reference/Sentry and same-key refusal controls. [Independent top-tree replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234402193).

Previous B-343-2/3/4/5 and both distinct B-343-6 cases remain closed; rejected plan reads, truthful free progress, ended-is-not-unpaid, per-package keys and terms reconciliation controls were preserved. [Prior Sol disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984020426), [fresh P2 replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234640700), [subscription/recur3 replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234402193).

G09: `40b8573` restacks repaired P1 cleanly; own P2 runtime delta is the three fences above plus the updated refusal-copy pin. Reviewed every changed line and both native callers; reuse is limited to byte-identical prior reviewed inputs, not another lens's verdict. [Candidate/fix record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984292582), [prior Sol evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984020426).

## Carried optional Cs

These six retain their prior counterexamples/fix rules under the freeze. [Prior six-C verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984020426).

| ID | Current file:line | Counterexample / minimal fix |
|---|---|---|
| C-343-1 | `src/hooks/usePackagePurchase.ts:509-560,601-693` | Core recurring tests live in P3 for size; replay them over each lower-piece round. |
| C-343-2 | `src/hooks/usePackagePurchase.ts:378-405` | 3DS return URL has no `handleURLCallback` consumer; device-test bank redirect and wire if required. |
| C-343-5 | `src/hooks/usePackagePurchase.ts:1117-1151` | Held old-account await drops a new-account tap; epoch-own in-flight guard and finally release. |
| C-343-6 | `src/components/PackageSelectionSheet.tsx:235-258,324-339` | Completed replay leaves live pay CTA after key retirement; render done/status before another purchase. |
| C-343-7 | `src/components/PackageSelectionSheet.tsx:247-252,317-322`; `Day1WinScreen.tsx:190-194,229-233`; `RootNavigator.tsx:908-912` | Relabeled fallback closes honestly but does not reach Membership; wire the destination once onboarding mounts. |
| C-343-8, S1-owned | `src/lib/packagePayment.ts:492-493` | Support promises a predetermined remedy; promise checking instead, retaining support/reference. |

## CI and operator default

Ordinary Typecheck/lint/test is green; main-only Analyze contexts are absent on this stacked base and must run on the final main-based composed tree. Size 2,935 is grandfathered with 65 lines remaining. [Ordinary CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232961197), [size/stacked-check record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984292582).

Initial replay had 82 passes and two old false-unpaid wording pins; after updating those, **84/85** pass, with one old absence-of-support pin also superseded by the required uncertainty support branch. Updated these three pins only to neutral wording, explicit no-unpaid checks and positive required support presence, preserving every other behavioral assertion; final recovery/native/theme replay is **3 suites, 36/36 pass**. [Initial replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234408086), [second replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234640700), [final recovery/native/theme replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37235076652).

Default: accept P3 placement of the substantial regressions, keep P1 availability wording, ticket Cs, and land P1–P3 only together after P3's must-fixes, dual final-head verdicts, final-main Analyze, recurring deployment, dunning D4 #690 and native card-update composition. Synthetic/native mocks are not device/live Stripe acceptance; no heavy local work, merge or deployment ran. [Builder split/test evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5984292582), [P3 landing proposal](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5984292690), [independent P3 failures](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37234565354).
