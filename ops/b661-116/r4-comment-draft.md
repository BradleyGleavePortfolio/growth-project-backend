DRAFT (not posted; post only when all 11 required checks are green at the cited head)

FIX ROUND 4 (B-661-R4-116, agent 116) — growth-project-backend#661 @ 6fdc35de61a26a0c9e8b3741044a3ec223dc9ab4

Merged origin/main f57baba3 (merge d2399d2e) and a5b605d1 (merge 6fdc35de); both automatic, main touched no file of this PR. Tests 56c3d156, fix 0e079bb8.

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-661-3 (Sol) stale prefetched PaymentIntent status revokes after failure + same-PI successful retry | Prefetch reads purchase version (id, status, updated_at) before the Stripe call (`paymentIntentWitnessById`); in-tx settled branch judged only on that version, else 503 `purchase_changed`; revoke is updateMany on id + status + updated_at; no-tx path asks Stripe after reading the row; a success that activates nothing moves updated_at on entitled rows of its PI | 0e079bb8 | round-4 cases in `B-661-3 ...` (test/checkout-webhook-handler.spec.ts) |
| B-661-5 (Opus) PI success activates adopted hosted Checkout row, completion activates again | `activatesOnPaymentIntentSuccess`: pending, or payment_failed only when stripe_checkout_session_id equals the PI id; same in charge-id prefetch; hosted row -> claimed false `checkout_session_activates`, completion activates once | 0e079bb8 | test/checkout-hosted-activation-once.spec.ts |
| C-661-6 (Opus) Stripe 4xx -> 503 forever | 4xx other than 429 -> `payment_intent_unreadable`, logged ids + Stripe code, row unchanged; 429/5xx/network still 503 | 0e079bb8 | `C-661-6: Stripe answers 404 ...`, 429 control |
| C-661-7 (Opus) late completion re-activates | Read fence (paid, canceled, expired, refunded, disputed, chargeback_lost) -> `already_progressed`; activation write carries `status notIn` the same list | 0e079bb8 | C-661-7 block (6 statuses) + adopted-decline control |
| C-661-2 / C-661-3 | No code (operator backfill; composition note in PR body) | - | - |

Failing-before (tests only, src = a193d7e1 + main): 13 failed / 51 passed, https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175121818 (failing list: /home/user/workspace/ops/b661-116/r4-failing-before-37175121818.txt). Local after: 64/64 in the two suites; 8 + 5 + 3 neighbouring suites green; ESLint clean; R75 net as any -1, as unknown as 0.

Lens probes verbatim after the fix: CI lane https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175513324 (concluded failure; logs NOT yet read). Expected: Opus DEFECT probes now fail at `claimed` true (the defect is gone), control passes; Sol control passes, Sol T1 fails at step 3 because its row has no stripe_checkout_session_id (hosted), and under the ruling "hosted Checkout purchases activate exactly once" a same-PI success no longer activates it; on a PaymentSheet row the stale delivery throws 503 and its redelivery resolves `stale_failure` (acceptance test). VERIFY the log before citing.

SIZE ASSESSMENT: 1,976 changed lines (+1,868 / -108, 13 files). Round 4 adds 548 (src 145, tests 403): four findings each with a failing-before test; no unrelated changes. Splitting would separate the hosted-activation rule from the decline fence it depends on.

Required checks at 6fdc35de: <fill in when 11/11 green>

READY FOR AUDIT
