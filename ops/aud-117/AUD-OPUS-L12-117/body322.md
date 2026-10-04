**Tier: T4.** These are client money surfaces: the payment lockout screen, the Days 0-9 banner, and the native card update through the themed in-app PaymentSheet (OR-110-2, no hosted portal), with 1A pay-on-save and 2A End my plan. This PR pairs with backend #628.
**Why T4:** the app approves exact invoices for charging, starts a 3DS bank step, and shows money truth after a charge.
**T4 trigger scan:** money movement through the backend (yes), the payment SDK (yes, `@stripe/stripe-react-native`), lockout gating (yes). PII: none added; Sentry carries codes and references only.
**T3 trigger scan:** client-facing copy (yes: Quiet Luxury, no first person, no exclamation marks), cross-repo contract with #628 (yes: paired fixture), shared support email helper (yes: optional body added to `supportMailto` / `useSupportEmail`, existing callers unchanged).
**Bounded T1:** none.
**Builder-owner:** agent 114 lane S-DUNNING-R6 (Claude Opus) from round 6; agent 113 (S-DUNNING-R5) before. The only writer of #322 and #628.
**Acceptance evidence:** `npx jest --runInBand src/entitlements/dunning` (76/76) through `ops/heavy.sh`; failing-before log for every R5 test; eslint and prettier clean on changed files; required CI at the final head.
**Promotion triggers:** this PR merges together with backend #628 (OR-112-13). It renders nothing while `FEATURE_DUNNING_V2` is off; the flag stays **OFF**.

Never merge from an agent. Main merged in as merge commits, with no rebase: `e3986e89`, then `79ea4d2` (main 17e4c11), then `91c1941` (main 1f8981dd).

## R6 fix round (S-DUNNING-R6, agent 114): CI after the main merge, R5 verified
| Finding | Change | Commit | Test |
|---|---|---|---|
| CI: `supportEmail.guard` (second support literal) | `dunningErrorCopy` re-exports `SUPPORT_EMAIL` from `src/constants/support.ts` | e12d40c0 | `supportEmail.guard.test.ts`; `dunningLockout.test.tsx` "re-exports the one support address" |
| CI: `supportEmail.guard` Sol B-324-1 (direct `mailto:` opens) | Lockout + Update card screens use the shared `useSupportEmail` + `SupportEmailFallback`; optional mail body keeps the request reference, plus an "Include reference X" note in the fallback | e12d40c0 | `dunningLockout.test.tsx` "Email support on the lockout opens one draft with the reference ..." |
| CI: `rootNavigatorConsultation{ColdBoot,Complete}` | Navigation mocks gained `getCurrentRoute` / `addListener` | e12d40c0 | both suites |
| housekeeping | removed a `node_modules` symlink committed by mistake | 23435ec2 | n/a |
| B-322-1/5/7, C-322-2 (R5) | verified in code and the named R5 tests at this head | 2d808dc | "S-DUNNING-R5 ..." blocks in `nativeCardUpdate.test.tsx` |

Overlap: mobile #334 conflicts in `src/screens/client/ClientPackagesScreen.tsx` (past-due banner); the second to merge keeps the native UpdateCard path.


## R5 fix round (Sol RC @ 0b4813dc: B-322-1, B-322-5, B-322-7, C-322-2; plus the copy rule)

| Finding | Change | Commit | Test (failing before -> passing after) |
|---|---|---|---|
| B-322-1: a failed bank step said "nothing was charged" after a partial payment or an unknown result | `bankStepCopy(response, verified)` builds the copy from the retained `paid_totals` and `due_totals`. When the bank step fails or rejects, the app first re-asks the server with the same SetupIntent and approval, which never charges twice. If the server already settled, it shows the real outcome. If the payment still waits for the bank, the copy says "$150.00 went through ... the payment of $90.00, so that amount was not charged". If the server cannot be asked, `BANK_RESULT_UNCONFIRMED` says "is not confirmed yet" (reported, with a reference). "Confirm with my bank" passes `lastKnown`, so a retry keeps naming the paid amount. Confirm with my bank and Use a different card both stay. The unconditional "nothing was charged" local copy is removed. | 2d808dc | `nativeCardUpdate.test.tsx` "S-DUNNING-R5 B-322-1" (5 cases, including the screen retry and a remount-style `confirmWithBank` with `lastKnown`) |
| B-322-5: incomplete or inconsistent quote failed open | `normalizePaymentQuote` requires `complete: true`, `lines` and `totals`, unique invoice ids and unique total currencies. Per-currency totals must equal the per-currency line sums, so the button label and the approved invoices always describe the same money. An invalid quote stops before the card form with `QUOTE_NOT_VALID` ("The amount you owe did not load in full, so the card form did not open and nothing was charged...", with a reference, reported). A complete empty quote is still "Save card". | 2d808dc | "S-DUNNING-R5 B-322-5" (9 rejected shapes; multi-currency and empty accepted; screen stops before the sheet) |
| B-322-7: backend `in_progress` was not accepted | New `in_progress` outcome in types, validation and copy: "Your card ending 4242 is saved and $150.00 went through. Another change to your other plan was still being processed... Tap Check again". The "Check again" button repeats the same confirm. The paired fixture `__tests__/fixtures/backend628-in-progress.json` is the real #628 response (`DUMP_R4_CONTRACT=1`, backend 342283da). | 2d808dc | "S-DUNNING-R5 B-322-7" (fixture normalize + copy; screen Check again -> paid, same confirm body, one sheet) |
| C-322-2: processing copy hid what was paid | `processing` with `paid_totals` leads with "$150.00 went through. The payment of $90.00 is processing." The title becomes "Part of your payment went through". | 2d808dc | "S-DUNNING-R5 C-322-2" |
| Copy rule: no first person | All dunning copy rewritten without "we/our/us" (error copy, intro, banner). A static test scans the string literals in the four copy files. | 2d808dc | "client-facing dunning copy never speaks as we / our" |

Failing-before: `ops/sdr5-113/mob_failing_before.log` (R5 tests against the 0b4813dc+main sources: 11 fail; 1 positive control, the multi-currency/empty quote acceptance, passes).

## R3 fix round

| Finding | Change | Commit | Test (failing before) |
|---|---|---|---|
| B-322-1 partial payment shown as "nothing was charged" | Outcome copy is built from per-currency `paid_totals` / `due_totals`; any amount that went through is named first; "active again" only when `access_state=restored`. New outcomes `approval_required`, `payment_uncertain`, `failed`. | 0b4813d | `nativeCardUpdate.test.tsx` "B-322-1" |
| B-322-2 lost confirm answer | Offline or bare 502/503/504 on confirm re-asks with the same SetupIntent and the same approval (backoff), shows "Confirming your payment", then refreshes status. If every answer is lost: `RESULT_NOT_CONFIRMED`, "we cannot tell yet whether the payment went through", plus "Check my payment again". Never "nothing was charged". Same for cancel. | 0b4813d | "B-322-2" (2 cases) |
| B-322-3 initial bank failure dropped the recovery | `bank_pending` keeps the SetupIntent id and the bank secret; "Confirm with my bank" and "Use a different card" both work. | 0b4813d | updated bank cases |
| B-322-4 native SDK rejections uncaught | Every `initStripe` / `initPaymentSheet` / `presentPaymentSheet` / `handleNextAction` call is guarded; rejections become specific copy plus Sentry; screen actions (autostart included) cannot leak a rejection. | 0b4813d | "B-322-4", autostart case |
| B-322-5 malformed successes; missing references | Strict normalisers throw `DUNNING_RESPONSE_SHAPE` (unknown outcome or state, non-integer money, bank step without secret, quote line without amount); the provider keeps its last state, so a bad body never clears a lockout. Every message shows `Reference: ...` when one exists; reported local failures get a client reference that also goes to Sentry. | 0b4813d | "B-322-5" (2 cases), status normaliser |
| B-322-6 stale or absent pre-charge amount | The screen reads `GET /v1/checkout/payment-method/quote` right before the sheet; the sheet button says "Save card and pay $150.00"; confirm sends `approved_invoices`; `approval_required` shows the fresh amount ("Pay $160.00") and re-confirms the same card. | 0b4813d | "B-322-6" (2 cases) |
| C-322-1 End my plan alert always said "access ends now" | `endPlanAlertBody`: "ends now" only while a payment is overdue; otherwise period end, no refund. A cancel that raced a paid retry shows "Your payment went through... you keep access until ..." (`paid_period_kept`). | 0b4813d | "C-322-1" |

Failing-before: the R3 cases call APIs that do not exist at the R2 head `8991ddf` (quote, approval, `bank_pending`, `unconfirmed`, strict normalisers), so they fail there by construction.

## Worked money examples (what the client reads)

1. **1A full.** Quote $150.00. Sheet button "Save card and pay $150.00". Result "Your card ending 4242 is saved and $150.00 went through. Your plan is active again."
2. **1A partial.** $150.00 paid, second plan not confirmed: "Your card ending 4242 is saved. $150.00 went through. We could not confirm the rest yet..." (no "active again").
3. **2A ended.** Alert: "The unpaid $150.00 is canceled... Your access ends now. If a payment went through in the meantime, you keep the period you paid for instead." Result "The unpaid $150.00 is canceled, so you will not be charged for it."
4. **2A paid before cancel.** "Your payment went through just before you ended the plan, so you keep access until Nov 1..."
5. **Voluntary cancel.** "Your plan ends at the end of the period you already paid for... There is no refund for the current period."
6. **Mixed currency.** Quote shows "$150.00 and 80.00 EUR"; never one summed number.

## Tests

`ops/heavy.sh npx jest --ci --runInBand --runTestsByPath src/entitlements/dunning/__tests__/nativeCardUpdate.test.tsx src/entitlements/dunning/__tests__/dunningLockout.test.tsx`; `tsc --noEmit` once. Results in the R3 report.



