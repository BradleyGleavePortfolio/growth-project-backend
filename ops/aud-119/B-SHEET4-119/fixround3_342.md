FIX ROUND 3 (B-SHEET4-119, agent 119) — growth-project-mobile#342 @ e3226f3b50a1f609aea7805600ec124324cd12aa

Answers AUDIT GPT-6.1 Sol (REQUEST CHANGES 0/1/6, issuecomment-5983977653) and AUDIT Claude Opus 5.5 (APPROVE 0/0/6, issuecomment-5983935012) at `0b1985f4`. Tier T4 (payments, money copy). One test commit (`ab41a59`, failing before) and one fix commit (`e3226f3`). No main merge needed (base main unchanged).

Size: +2,190 / -17 = 2,207 changed lines (tests included). Grandfathered PR, under its 3,000 ceiling.

## Finding -> change -> commit -> test

| Finding | Change | Commit | Test (src/lib/__tests__/packagePayment.replyCodes.test.ts) |
|---|---|---|---|
| B-342-1 (Sol, residual): PACKAGE_NOT_FOUND said "nothing was charged" (packagePayment.ts:499-502, :838-848), though production 3e9a9a75 checks availability before the key lookup, so after an unclear card step an archived package proves nothing about the same-key attempt | `packageUnavailable(ref)` / `packageUnavailableShareLink(ref)` never claim no charge: "This plan is no longer offered, so it cannot be started from here. If an earlier payment for it did not show a clear result, open your plan in Membership to check it, or email support and quote reference X. Pull down to see your coach's current plans, or message your coach." (share link: own first sentences, ends "Otherwise, message the coach who shared the link."). Notice: support + openPlan, key kept (no retireKey), reload on the sheet surface only. The reference is the attempt key's own (the one the unclear notice showed), else the server request id. No Sentry event (an expected refusal) | e3226f3 | "B-342-1 (Sol, 119) ..." 5 tests: payment_intent and subscription_intent (no NO_CHARGE, reference, support, openPlan, reload, no retireKey, no Sentry), share link, reference fallback and no-reference wording, authoritative replay controls |

The hook flow (unknown card step -> same-key retry -> archived package, one-time and renewing; key reused, notice keeps the unclear reference, the next tap still replays the same key) is covered in #344 `src/hooks/__tests__/usePackagePurchase.nativeFence.test.tsx` (size: #343 has 65 lines left).

Failing before (test commit on the PR head, with both lenses' probes): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232648574 — 6 failed / 157 (4 new + 2 Sol probe).
After (tsc + same specs): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232722067 — 165 / 165.
Required checks at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747197 pass; Analyze (javascript-typescript), Analyze (actions) https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37232747242 pass; CodeQL pass.

## Probes replayed at this head (both lenses)

| Probe | Origin | Result |
|---|---|---|
| archived package refusal says nothing about the earlier same-key charge | Sol audSolS12119.replayRefusal (run 37231087077) | pass (failed before) |
| share-link availability cannot prove an earlier attempt unpaid | Sol replayRefusal | pass (failed before) |
| controls: no-answer keeps uncertainty and reference; completed replay stays completed | Sol replayRefusal | pass |
| R1 minor units per currency, R2 copy rules over every string (new copy included), noAnswer reference | Opus audOpusS12119.probe342 | pass |
| R3 INFO (C-342-7) no-answer wording records today's copy | Opus probe342 | pass (unchanged, follow-up C) |
| Prior rounds, top tree https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37233619554: Sol Sh118 transportUnknown, minorUnits; Opus Sh118 probe342; Sol P12117 paymentContract; currency | earlier lenses | pass |
| Opus P12117 C-342-1 isCombo | earlier Opus | FAIL, held C (red by design, planTerms.ts not touched) |

## Money list self-check
- Webhook order and redelivery: the app consumes no webhooks; a refusal after an unclear step now keeps the key, so a replay reaches the same backend attempt once the package is available again.
- Concurrency (two workers, lock order): server locks are the backend's; one key per package and sale kind, single in-flight guard; this refusal no longer retires or replaces the key.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged (PAYMENT_REFUNDED_OR_IN_REVIEW + support; 401 session ended); an archived package is not told as a terminal or unpaid state.
- List pagination and completeness: no Stripe list on the device in S1.
- Currency: unchanged from round 2 (per-currency exponent for display, request integers untouched, no FX).
- Copy truth: "nothing was charged" remains only where a definite refusal before any attempt, the missing production route or Stripe's own state proves it; PACKAGE_NOT_FOUND joins no-answer, unmapped and unconfirmed answers in claiming nothing about money.

Opus Cs on these lines: none (C-342-7 sits at :459-460, not folded). Follow-up Cs for the operator: ops/reports/B-SHEET4-119.md.

READY FOR AUDIT
