FIX ROUND 1 (B-SHEET-118, agent 118) — growth-project-mobile#342 @ 56f281ad3aa977882c962a6591d3594899cdd5a1

Answers AUDIT GPT-6.1 Sol (REQUEST CHANGES, issuecomment-5976926407) and AUDIT Claude Opus 5.5 (REQUEST CHANGES, issuecomment-5977006434) at `72821495`. Tier T4 (payments).

First, merge-only: main `7fdb629a` merged into this branch (`43f6bfad`, no conflicts, no overlap with the PR's files). Then one test commit (`2212e9e5`, failing before) and one fix commit (`56f281ad`).

Size: +2,009 / -9 = 2,018 changed lines (tests included), inside the 1,500-3,000 band. Stated per the size rule.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test (src/lib/__tests__/packagePayment.replyCodes.test.ts) |
|---|---|---|---|
| B-342-1 (both): recurring PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR, SUBSCRIPTION_SETUP_UNAVAILABLE and any unmapped answer said "nothing was charged" | On `subscription_intent` these codes now give `notConfirmed`: "The last attempt to start this plan did not finish, and its result is not confirmed yet. Open your plan in Membership to check whether it started before you start again. If it is still unclear, email support and quote reference X." (support, reference, Sentry, `openPlan`, key kept; no "trial" wording for paid plans). The default branch, the 200 shape error and unknown sheet failures use a neutral `unknown` copy (no charge claim, Open your plan, support, reference). One-time `payment_intent` PAYMENT_RETRY keeps the proven no-charge copy (the key was freed before any secret) | 56f281ad | "B-342-1 ..." 3 codes + 4 steps of unmapped 500 + control (one-time) + control (definite refusal) |
| B-342-2 (Sol): #661 replay codes unmapped | PAYMENT_ALREADY_COMPLETE: "This payment already went through, so nothing more was charged. Open your plan to use it." + `openPlan`, `completed`, `retireKey`. PAYMENT_REFUNDED_OR_IN_REVIEW: refunded or under review, cannot be paid again here, status in Membership, support + reference, key kept. PAYMENT_CHECKOUT_CLOSED: checkout closed, choose the plan again for a new checkout, `retireKey`, no charge claim | 56f281ad | "B-342-2 ..." 3 cases |
| Job scope: recurring codes | CHECKOUT_KEY_OTHER_PLAN: own copy + `retireKey`. SUBSCRIPTION_ATTEMPT_EXPIRED: `retireKey` flag. PLAN_CHANGE_UNCONFIRMED: "The change to this plan was sent, but the payment service has not confirmed it yet. Pull down in a minute to refresh your plans, and choose the change again if your plan still shows the old state." (`reload`) | 56f281ad | "recurring reply codes" 3 cases |
| Job scope: today's production backend (643817b3 has no subscription-intent route; Nest answers a bare 404 `error: "Not Found"`) | Bare 404 on `subscription_intent` -> `renewingUnavailable`: "This plan renews automatically, and renewing plans cannot be started from the app yet, so this plan did not start and nothing was charged. Message your coach to arrange it." (the route is absent, so nothing ran). PACKAGE_NOT_FOUND 404 still maps to its own copy | 56f281ad | "today's production backend ..." |
| C-342-1 (Sol, same lines as the B-342-1 default branch) | Only UPPER_SNAKE backend codes and short Stripe identifiers reach Sentry (`machineCode` / `machineLabel`); unknown codes become `http_<status>` with `code: null` | 56f281ad | "C-342-1 only machine labels reach Sentry" |
| B-343-4 (Sol, library half; the hook half is on #343) | `PurchasablePackage.trialEndsAt` (optional), `IntentTerms.trialEndsAt`; `planTerms` shows a pinned date; `reconcileIntentTerms(pkg, plan, mode, now)` flags `trialDateMoved` when the setup-mode pinned date is a different calendar date from the one shown, and the adopted package carries the pinned date | 56f281ad | "B-343-4 a resumed trial keeps its pinned first-charge date" 2 cases (midnight-crossing 12-hour-old pin) |
| Copy rules | Every PACKAGE_PAYMENT_COPY string checked: no first person, no exclamation marks, no generic error text | 56f281ad | "copy rules" |

Failing before (test commit on the PR head, no fix): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37218790538 — 16 failed, 4 passed (the 4 are controls / copy rules).
After: required checks at this head — Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351230 pass; Analyze (javascript-typescript), Analyze (actions) https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351237 pass.

## Prior probes replayed at this head (both lenses)

Lane run with `tsc --noEmit`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219370245 (type-check pass; 38 of 39 tests pass).

| Probe | Origin | Result |
|---|---|---|
| PAYMENT_RETRY not confirmed, never no charge | Opus audOpusP12117.probe342 (run 37180147690) | pass |
| STRIPE_CHECKOUT_ERROR without proven no charge | Opus probe342 | pass |
| SUBSCRIPTION_SETUP_UNAVAILABLE while closing unconfirmed | Opus probe342 | pass |
| C-342-1 one-time package with $0 recurring part sells one-time | Opus probe342 | FAIL — C finding, not fixed under the freeze (planTerms.ts:83-88 not touched by a B fix); listed as a follow-up C in ops/reports/B-SHEET-118.md |
| 3 codes on subscription-intent never claim no charge | Sol audSolP12117.paymentContract (run 37179727433) | pass |
| unknown 500 after retry is not proof | Sol paymentContract | pass |
| #661 complete / closed / refunded-review copy | Sol paymentContract | pass |
| free-form unknown code cannot enter a scrubbed Sentry event | Sol paymentContract | pass |
| control: definitive decline-before-create stays specific | Sol paymentContract | pass |

## Money list self-check
- Webhook order and redelivery: the app consumes no webhooks and never infers paid from event order; it reads entitlement / purchases / plan after the sheet, and PAYMENT_ALREADY_COMPLETE only triggers an idempotent entitlement refresh.
- Concurrency (two workers, lock order): server-side locks are the backend's; on the client one in-flight guard and one key per package + sale kind (#343) make every replay hit the same backend reservation.
- Terminal states (refunded, disputed, canceled, deleted account): PAYMENT_REFUNDED_OR_IN_REVIEW shows status + support and never opens a new charge; a canceled sheet makes no claim; account change is fenced on #343.
- List pagination and completeness: no Stripe list in S1; the purchase / plan reads on #343 fail closed to "outcome unknown", never to "nothing was charged".
- Currency: amounts are the backend's minor units (`amount_cents`) in the backend's currency, formatted only; no conversion on the device.
- Copy truth: "nothing was charged" now appears only where the backend or the missing route proves it (definite refusals, one-time PAYMENT_RETRY, renewingUnavailable); every unconfirmed answer says so and offers Open your plan plus support with a reference.

Follow-up Cs (not fixed, freeze): Opus C-342-1 (planTerms.ts:83-88 `isCombo` needs `recurringAmount > 0`), Opus C-342-2 (land #342-#344 as one for main's old ClientPackagesScreen), Opus C-342-3 (now partly covered by the new S1 test file). Details in ops/reports/B-SHEET-118.md.

READY FOR AUDIT
