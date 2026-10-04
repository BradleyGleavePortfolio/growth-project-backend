# AUD-OPUS-R3-116 (Claude Opus 5.5 lens, operator agent 116 wave): backend #680 (recurring R3, native subscription webhooks)

Claim: ops/lanes116/claims/backend-680-2b10687c-opus. Notes: /home/user/workspace/ops/aud-116/AUD-OPUS-R3-116/ (verdict-680.md, handler-680.ts, subcheckout-680.ts, handler.diff, probe spec copy, 680-audit-comments.md).

## Result
- PR: growth-project-backend#680, head `2b10687c63cf02e0181339b684634ff9cfbeb803` (unchanged from start to post). Base: #679 branch @ `958806d15af64863786337699020428cd89ffaf3`. Draft, merge CLEAN, required checks 10 pass / 1 skipping.
- Verdict: **REQUEST CHANGES, A/B/C = 0/2/5**: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976299710
  (The first POST went out with a literal `@verdict-680.md` body because `-f` was used instead of `-F`. The same comment was PATCHed to the full verdict within a minute. It is still one comment and one verdict.)
- GPT-6.1 Sol: REQUEST CHANGES 0/4/0 at the same head (comment 5976246125), posted before this verdict. Both lenses independently found the same two B defects. Sol also rates two more as B; this lens rates them C:
  - Sol B-680-3 (first-payment notice) = this lens C-680-6. It is gated by `FEATURE_ROMAN_FIRST_PAYMENT`, which is default OFF (prod-switches.yml: auto_flip false, unowned).
  - Sol B-680-4 (trial conversion-first skips the trial-used stamp) = this lens C-680-5. It needs a lost or late trialing grant event. Note: the binding ruling allows trials of 0-30 days, and a 1-3 day trial falls inside Stripe's 3-day retry window, so the operator may treat it as must-fix. It is a one-line fix either way.

## Probe evidence (test-only spec on the exact head; branches deleted)
- Final run, three suites: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175051866
  - 9 probes red, 3 controls green.
  - test/b-recur-subscription-webhooks.spec.ts and test/b-recur-116-fix-round-3.spec.ts green.
  - Totals: 45 tests, 36 pass.
- Earlier runs of the same spec: 37174514584 (6 red / 16 pass) and 37174790651 (7 red / 2 pass, adds the second-subscription case).
- Spec copy: ops/aud-116/AUD-OPUS-R3-116/probe-audit-opus-r3-116-680-order.spec.ts. Describe labels map one-to-one to the finding IDs.

## Findings (line numbers are in src/checkout/checkout-webhook-handler.service.ts at 2b10687c)
- **B-680-1: a stale subscription snapshot revokes a paid plan.**
  - Location: `:1002` and `:1020-1032` apply the payload status.
  - Failure: a retried `customer.subscription.created` (always `incomplete` for default_incomplete) arrives after `invoice.paid` or `updated(active)` granted access. Access is revoked until the next renewal.
  - Consequence: 23 h later, checkout `decide()` (subscription-checkout.service.ts:684-715) mints a second Stripe subscription, so the client is billed twice.
  - Fix: Stripe never returns a subscription to `incomplete`, so drop an `incomplete` payload for an entitled or progressed row. Treat canceled / expired / incomplete_expired rows as terminal for created/updated. Alternative: apply the live subscription prefetched outside the transaction for native rows.
- **B-680-2: a late first-invoice decline starts dunning.**
  - Location: `:1464`. `isNeverEntitledAttempt` is row-state based.
  - Failure: a late `invoice.payment_failed` (billing_reason subscription_create) puts a paid plan, or an ended attempt (incomplete_expired / expired), into past_due and `recordFailure`. The PaymentIntent early return (`:1278-1288`) also leaves the decline in `last_error` on an active plan, and that field is visible to client and coach.
  - Fix: `subscription_create` means first attempt regardless of row state. Write `last_error` only while never-entitled.
- **C findings:**
  - C-680-3: stale updated after deleted re-grants. Pre-existing on main; fix it with B-680-1.
  - C-680-4: the metadata fallback bind does not set `stripe_checkout_session_id = sub.id`, so an abandoned attempt is recorded as `canceled`. The PaymentIntent id is not bound either.
  - C-680-5: `trialStartPatch` stamps only on status trialing.
  - C-680-6: the first-payment notice fires on first entitlement (flag OFF).
  - C-680-7: the setup_intent lookup by `stripe_client_secret startsWith` is unindexed. Also a misplaced doc comment at `:499-505`.
- **Prior Cs from the #654 APPROVE (5972187301):**
  - C-654-8 closed: lookup-first mint, timed_out after the key window, tests green.
  - C-654-9 closed outside this repo: mobile #334 @ d466fd15 accepts mode 'none' (packagePayment.ts:190-200).
  - C-654-10 closed: `errorLabel` closed lists, used at `:541`, `:565`, `:1083`. No new log line in this diff carries a message.
- **Evidence reuse:** only for byte-identical code. `git diff pr/654 7e55cfcb` on the handler is empty, and 5 of 6 test files are identical. Both B findings are in those identical lines, so the 02c48de7 APPROVE is superseded for them. The handler was re-read in full at this head, and the delta `7e55cfcb..2b10687c` was read line by line.

## Operator items (cross-PR; not audited here)
1. **Never-entitled helper (#680 vs #628/#691).** Ship one exported helper `isNeverEntitledAttempt(purchase, billingReason?)`:
   - `subscription_create` means true.
   - Keep #680's `trial_started_at` guard.
   - Use it in `applyInvoicePaymentFailed` and `isUnpaidNativeAttempt`.
   - If #680 adopts the billing_reason rule for B-680-2, unification at the second merge is mechanical.
2. **C-661-3 (#661 vs this stack).** The second to land must:
   - Keep the recurring early return (`:1278-1288`) directly after the lookup by PaymentIntent and ahead of #661's decline check.
   - Skip #661's PaymentIntent status prefetch for recurring rows.
   - Clear PaymentSheet credentials at native first grant and on every subscription end. That includes `customer.subscription.updated` to `incomplete_expired`, which is how Stripe ends an unpaid attempt after 23 h, not only `deleted`.
3. **Trials convergence (#671/#672/#673).** #680 sells trials with its own `ClientPurchase` one-trial check in #679 `decide()`, while #672 adds PackageTrialUsage. The trials stack (second) must:
   - `reserve()` inside `decide()`.
   - `markStarted()` at #680's `trialStartPatch` sites in the same transaction. Fix C-680-5 first, or the ledger misses converted trials.
   - `release()` on attempt end.
   - Register TrialCheckoutCapability('subscription-checkout') at boot.
   - Use one stale-window value.
   - Backfill 'started' from `trial_started_at`.
   - Risk: with #671 landed but the capability unregistered, the app says "not offered yet" while `decide()` creates trial subscriptions.
4. **Size.** #680 has 86 lines left. The fixes live in #680's handler (about 15-20 lines) with regressions appended to test/b-recur-subscription-webhooks.spec.ts (about 50-60 lines), about 2,990 total. #679 (2,952) has no room. If the recount exceeds 3,000, move test/b-recur-116-fix-round-3.spec.ts (432 lines, #679 service tests) unchanged to a new tests-only piece on top of #680. Never delete tests.
5. **Stripe dashboard (owner).** The webhook endpoint must subscribe to `setup_intent.succeeded` before the recurring deploy, and to `customer.subscription.trial_will_end` for trials.

## HANDOFF
| PR | Exact head | State | Opus verdict | Next step |
|---|---|---|---|---|
| backend#680 (recurring R3) | 2b10687c63cf02e0181339b684634ff9cfbeb803 | OPEN draft, CLEAN, checks 10 pass / 1 skipping; Sol RC 0/4/0 | REQUEST CHANGES 0/2/5 (comment 5976299710) | Builder fixes B-680-1 and B-680-2 in #680 and should fold in C-680-3/4/5 (all small). Gate on probe spec ops/aud-116/AUD-OPUS-R3-116/probe-audit-opus-r3-116-680-order.spec.ts going green with controls green, and recount under 3,000. Then an Opus re-audit at the new head, reusing this verdict's evidence only for byte-identical files. |

- Recommended default for the operator: send #680 back to B-RECUR with both lenses' B lists. Treat Sol B-680-3/B-680-4 (= Opus C-680-6/C-680-5) as in-round fixes, since both are small. Keep the stack unmerged until both lenses approve one head.
- Cleanup: worktree /home/user/workspace/wt/AUD-OPUS-R3-116-1 was removed (no node_modules link). Remote branches audit/AUD-OPUS-R3-116/680-order, 680-order-resub and 680-order-final were deleted. The claim dir was kept. No other PR was audited. `df -h /` was 75% during the job.
