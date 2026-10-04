AUDIT Claude Opus 5.5 — growth-project-backend#661 @ 6fdc35de61a26a0c9e8b3741044a3ec223dc9ab4 — VERDICT: APPROVE

A/B/C = 0/0/5

Lens: AUD-OPUS-661-117 (operator agent 117). Tier T4 (money-path credentials, entitlement, webhook ordering); the PR body says T4 and this lens agrees. This lens did not read the other lens's verdict at this head before posting.

### Scope and evidence
- **Round-4 delta, every line read:** `a193d7e1..6fdc35de` limited to the PR's files changes 3 files only: `src/checkout/checkout-webhook-handler.service.ts` (+132/-13, fix 0e079bb8), `test/checkout-hosted-activation-once.spec.ts` (new) and `test/checkout-webhook-handler.spec.ts` (tests 56c3d156). The tests are byte-identical between 56c3d156 and 0e079bb8 (the fix commit touches src only).
- **Traced:** every caller of the changed paths through `BillingService.handleEvent` (prefetch before `$transaction`, dedup row in the tx, rethrow of non-P2002 errors) and `StripeWebhookController`. Also checked: the PaymentSheet row write (`checkout.service.ts:734-742` sets `stripe_checkout_session_id` and `stripe_payment_intent_id` to the same PaymentIntent id in one update), the hosted row write (`:429-456`, no PaymentIntent id), guest rows (`guest_pi_<pi>`), every `status: 'paid' | 'canceled' | 'expired'` writer of ClientPurchase, and raw SQL updates of ClientPurchase in `src/` (none).
- **Merges:** d2399d2e (main f57baba3, deps) and 6fdc35de (main a5b605d1, community voice) are automatic. Each tree equals `git merge-tree --write-tree` of its parents (56131f4b and 462ea4b3), and main touched no PR file. Main has since moved to 0b0f5b82 (#611), so the PR is BEHIND. 0b0f5b82 also touches no PR file and merges cleanly, so the update qualifies for a rule-12 MERGE-ONLY TREE CHECK.
- **Evidence reuse (G09):** the other 10 PR files and the unchanged parts of the handler are byte-identical to a193d7e1. This lens audited every line of those at a193d7e1 (comment 5976157987) and found only B-661-5 plus C items. That evidence still applies because its inputs are unchanged.
- **CI:**
  - All 11 required checks are green at 6fdc35de.
  - build-and-test attempt 1 crashed with a jest worker out of memory in `test/community/rls/community-message-shape.live.spec.ts`, an unrelated file: 716 suites passed, 0 assertions failed. This is the known infra failure (#694). Attempt 2 is green, and both of this PR's suites pass there (run 37175620562).

### Prior findings of this lens
- **B-661-5: closed.**
  - The fix is `activatesOnPaymentIntentSuccess` (:30-39). It is applied in `applyPaymentIntentSucceeded` (:1110) and in the charge-id prefetch (:584). A `payment_failed` row is activated only when `stripe_checkout_session_id === pi.id` (PaymentSheet). Hosted ids are `cs_…` and guest ids are `guest_pi_…`, so neither can match.
  - Hosted rows get `claimed: false`, `checkout_session_activates`, with no split and no fanout. The completion then activates once, with its access window and the `in_app_hosted` entrypoint.
  - Failing-before: [run 37175121818](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175121818), source = a193d7e1 + main, 13 failed / 51 passed. This lens read the job log.
  - The lens probe, run verbatim after the fix in [run 37175513324](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175513324) (log read by this lens): both DEFECT cases now fail at `expect(s.claimed).toBe(true)` with Received false, which means the defect is gone. The PaymentSheet control passes.
- **C-661-6: closed.** A 4xx other than 429 now gives `payment_intent_unreadable` (:654-659, :1287-1290), and 429/5xx/timeouts still give 503. Tests cover a 404 and a 429 control. The class is wider than needed: see C-661-8.
- **C-661-7: closed.**
  - The read fence (:696) answers `already_progressed` for `paid`, `canceled`, `expired`, `refunded`, `disputed` and `chargeback_lost`.
  - The activation write carries `status notIn` the same list (:733). A refund or deletion that commits between the read and the write makes Prisma throw P2025, so the event rolls back and its redelivery hits the fence.
  - No writer can make a one-time hosted row `paid` before its completion. Dispute-won writes `paid` only from `disputed`; account deletion writes `canceled`, and blocking re-activation there is correct.
  - Recurring `active` stays unfenced, which is correct.
- **C-661-2 (operator backfill):** still open, unchanged.
- **C-661-3 (merge order with #678-#680):** still open. See C-661-3 below.

### Sol B-661-3 (late decline vs paid retry): closed for every reachable state, checked independently
- **How the fix works:**
  1. The prefetch reads the purchase version (`id`, `status`, `updated_at`) before calling Stripe (:617-641).
  2. In the tx, the settled branch acts on the prefetched Stripe status only when the in-tx row is the same version (:1280). Otherwise it answers 503 `purchase_changed`, and the dedup row rolls back.
  3. The revoke is a compare-and-set on id + status + `updated_at` (:1297-1300).
  4. The no-tx path reads the row, then asks Stripe, then runs the same compare-and-set.
- **Version precision:** `updated_at` is `TIMESTAMP(3)` (migration 20260601000000), so a JS `Date` round-trips exactly. The field is `@updatedAt`, which Prisma Client sets on its writes, and the round's own writes (activation, touch) also set it explicitly. `src/` has no raw-SQL writer of ClientPurchase. Any status change also breaks the version through its `status` part.
- **Interleavings checked (READ COMMITTED, no isolation level set on BillingService's `$transaction`):**
  - A success commits between the witness read and the in-tx read: the version differs, so the result is 503, and the redelivery reads `succeeded` (`stale_failure`).
  - A success commits between the in-tx read and the compare-and-set: the touch (:1116-1119) or the activation write holds the row lock. The decline's UPDATE re-evaluates against the new `updated_at`, gets count 0 and answers 503.
  - The decline's compare-and-set commits first: the Stripe status read after the witness was `requires_payment_method` / `canceled`.
    - A PaymentSheet row cannot be `paid` with such a PaymentIntent.
    - A provisional hosted row then really failed asynchronously.
    - A later success re-activates a PaymentSheet row through `activatesOnPaymentIntentSuccess`.
- **Hosted variant of the Sol sequence (failure revoked, then the same PaymentIntent succeeds):** the hosted row is no longer activated. Stripe Checkout never retries a failed async payment of a completed session, and this backend never confirms hosted PaymentIntents, so that sequence cannot happen through the product. The draft body names this limit. The Sol probe fails at exactly that step in run 37175513324.
- **Same sequence on a PaymentSheet row:** passes. Tests: `round 4: a decline whose Stripe status was read before ...` and `round 4 (no transaction) ...`.
- **Credentials:**
  - The success path still erases them (`CLEARED_PAYMENT_SECRETS`, plus the explicit `updated_at` at :1139).
  - Hosted rows never hold credentials.
  - A `payment_failed` PaymentSheet row keeps them for the in-sheet retry, and the replay classifier is unchanged.
  - No new log line carries anything beyond ids, statuses and `stripe_<http>_<code>`.

### C findings
- **C-661-3 (carried, merge order):** GitHub still shows the round-3 PR body. The drafted round-4 body (ops b661-116/r4-body-after.md) adds two items: the round-4 composition note (the stack applies `activatesOnPaymentIntentSuccess` to recurring PaymentSheet / first-invoice rows and keeps the C-661-7 fence for one-time rows) and the raw-SQL `updated_at` promotion trigger. Rule: apply that body before merge (operator).
- **C-661-8 (new, optional), `:654-659`:** the permanent class covers 401 and 403, which the operator can fix.
  - Counterexample: during a revoked or rotated live key (401), a real async failure of a provisionally paid hosted purchase is acknowledged as `payment_intent_unreadable`. Stripe then never redelivers it, so after the key is fixed the client keeps access that was never paid for. The only signal is a warn line.
  - Rule: treat only 404 (and 400) as permanent, keep 401/403 as 503, and log the drop at error level with ids and the code.
  - Verify: a 401 mock throws `ServiceUnavailableException`, and the 404 test still passes.
  - This refines this lens's own earlier C-661-6 wording.
- **C-661-9 (new, optional):** the write-side fence (`status notIn`, :733) has no test. Add one where the status changes to `refunded` between the `findUnique` and the update: the update rejects, nothing is activated, and a redelivery returns `already_progressed`.
- **C-661-10 (outside this diff, pre-existing on main, narrowed by round 3):**
  - Setup: two open hosted sessions for the same client and package (possible across the UTC day bucket, `checkout.service.ts:299-300`). The metadata fallback (:1208-1242) can then stamp session A's PaymentIntent onto session B's row.
  - Consequence: later lookups by `stripe_payment_intent_id` become ambiguous. These are the decline `findFirst` (:1205, which has no `orderBy` and no index) and the refund fallback (`refund-dispute-handler.service.ts:896-899`). For example, a real async failure of A's PaymentIntent can rewrite B and leave A entitled.
  - Rule: on `checkout.session.completed`, release that PaymentIntent from other non-entitled `payment_failed` rows of the same client and package (or adopt only when exactly one candidate exists). Add an index on `stripe_payment_intent_id`. This is a follow-up and does not block.
- **C-661-2 (carried):** operator backfill in a deploy window after merge.

APPROVE: no A or B findings at this head. Round 4 closes B-661-5, C-661-6 and C-661-7 with code and failing-before tests, and the late-decline/paid-retry boundary holds under every reachable interleaving.
