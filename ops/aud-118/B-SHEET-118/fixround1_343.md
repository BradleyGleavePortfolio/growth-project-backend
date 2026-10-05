FIX ROUND 1 (B-SHEET-118, agent 118) — growth-project-mobile#343 @ fd739d5819c232764e0389afd778860bf452b41c

Answers AUDIT GPT-6.1 Sol (REQUEST CHANGES, issuecomment-5976959713) and AUDIT Claude Opus 5.5 (REQUEST CHANGES, issuecomment-5977006549) at `af984441`. Tier T4 (payments).

Merge-only first: #342 at `56f281ad` (its FIX ROUND 1: truthful reply-code copy, #661 codes, notice flags, pinned trial terms) merged in as `f3e63d33`. Then one test commit (`a69e7954`, failing before) and one fix commit (`fd739d58`).

Size: +2,553 / -260 = 2,813 changed lines against the new #342 (tests included), inside the 1,500-3,000 band. Stated per the size rule.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-343-1 (Sol): no lifetime fence; a held POST / initStripe / initPaymentSheet could present a payable sheet after unmount | `start` captures an auth epoch; `live()` = still mounted and same epoch. Checked after every await (payment-intent, subscription-intent incl. the expired retry, claim-free, price / existing-plan reads, initStripe, initPaymentSheet, presentPaymentSheet, entitlement poll); a dead flow returns `stale` with no side effect. `authEvents` logout / login bump the epoch, drop all keys and pending reads and reset the state | fd739d58 | usePackagePurchase.boundary: unmount during held intent; unmount during held initPaymentSheet; logout and login during held intent (no sheet, idle, new key after) |
| B-343-2 (Sol): single-slot key; A unknown -> B -> A minted a second A key | Keys kept per package + sale kind (`attemptsRef` map); retired only when the attempt is proven finished (success, ended plan, finished card step, retireKey answers) | fd739d58 | boundary: A unknown -> B canceled -> A replays A's key |
| B-343-3 (Sol): PAYMENT_CHECKOUT_CLOSED key never retired; completed / refunded had no next action | The hook consumes the #342 notice flags: `retireKey` (checkout closed, key for another plan, attempt expired), `completed` (entitlement refresh via onEntitled), `openPlan` (PurchaseFeedback shows Open your plan) | fd739d58 | boundary: CHECKOUT_CLOSED retires the key; ALREADY_COMPLETE refreshes + offers the plan; REFUNDED_OR_IN_REVIEW keeps the key, support, no sheet |
| B-343-1 (Opus): an unclear one-time result showed "Payment received. Setting up your plan." | New `checking` state set while an unclear one-time result is read (also on Check again); PurchaseFeedback shows "Checking whether the payment went through."; cleared by every end state | fd739d58 | boundary: checking while the purchase read is held; contrast file: sheet text, never "Payment received" |
| B-343-4 (Sol): pinned trial_ends_at ignored | Hook passes `now` to `reconcileIntentTerms`; a moved pinned date opens the terms review before any card step with "The free trial on this plan started when this checkout first opened, so the first charge date differs from the one shown. Nothing was charged yet. Review the date, then confirm to continue."; the review shows the pinned date and confirming replays the same key | fd739d58 | boundary: pinned date review, no initPaymentSheet, same key on confirm |
| B-343-5 (Sol): selected card #D6E4DA with muted text, dark 2.10:1 / light 4.28:1 | Selected card keeps `bgSurface` (light 5.54:1, dark 6.29:1); selection shows as a 2 px accent border, padding 15 so content does not shift | fd739d58 | PackageSelectionSheet.contrast: light and dark >= 4.5:1, border 2 |
| Existing test asserting the old false claim | PackageSelectionSheet.payment "anything else" now expects the neutral copy and Open your plan | a69e7954 | same |

Failing before (tests on `f3e63d33`, no S2 fix): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219282995 — 12 failed, 1 passed (the REFUNDED_OR_IN_REVIEW control).
After: required check at this head — Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219352660 pass.

## Prior probes replayed at this head (both lenses, plus the S3 suites per C-343-1)

Lane run with `tsc --noEmit`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219714087 — type-check pass, 9 suites, 120 of 120 tests pass.

| Probe | Origin | Result |
|---|---|---|
| native call threw: no "Payment received" while the purchase is read | Opus audOpusP12117.probe343 (run 37180210458) | pass |
| unconfirmed result never "nothing was charged" | Opus probe343 | pass |
| unmount while one-time intent held: no payable sheet | Sol audSolP12117.purchaseBoundary (run 37179726110) | pass |
| unmount while subscription sheet init held: no present | Sol purchaseBoundary | pass |
| A uncertain -> B canceled -> A replays A key | Sol purchaseBoundary | pass |
| PAYMENT_CHECKOUT_CLOSED retires the key | Sol purchaseBoundary | pass |
| control: same-package unknown retry keeps the key | Sol purchaseBoundary | pass |
| control: double start creates one request | Sol purchaseBoundary | pass |
| C-334-3 closure: unmount during confirming GET, no entitlement callback | Sol purchaseBoundary | pass |
| selected card terms AA in dark | Sol audSolP12117.paymentTheme (run 37179872241) | pass |
| resumed unpaid trial with earlier first-charge date requires review | Sol recur3 + B-343-4 test (run 37179991390) | pass |
| S3 recur3 suite (all cases) and S3 subscription suite against this head | C-343-1 | pass (copies with the trial fixture set to today + 7; the old fixed 2026-10-10 now correctly triggers the B-343-4 review, see #344) |

## Money list self-check
- Webhook order and redelivery: no webhook handling on the device; success is shown only after the entitlement / purchase / plan read confirms it, and a completed replay only refreshes the entitlement.
- Concurrency (two workers, lock order): one in-flight guard per hook; one key per package + sale kind, so a replay always reaches the backend's existing reservation; an account change drops the keys so they are never sent under another account.
- Terminal states (refunded, disputed, canceled, deleted account): refunded / in review -> status + support, key kept, no sheet; canceled sheet -> idle, same key; ended plan -> key retired; sign-out or account switch -> flow stops, state cleared.
- List pagination and completeness: the purchase and plan reads fail closed (outcome unknown with Check again and support), never "nothing was charged".
- Currency: backend minor units and currency only; no conversion on the device.
- Copy truth: one-time progress after an unclear card step reads "Checking whether the payment went through."; no charged / not charged / paid claim before the backend or Stripe answer proves it.

Follow-up Cs (not fixed, freeze): C-343-1 (S3 suites must be replayed against S2 each round: done here), C-343-2 (`handleURLCallback` never called: iOS 3DS return needs a device check). Details in ops/reports/B-SHEET-118.md.

READY FOR AUDIT
