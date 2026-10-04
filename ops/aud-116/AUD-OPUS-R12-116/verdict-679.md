AUDIT Claude Opus 5.5 — growth-project-backend#679 @ 958806d15af64863786337699020428cd89ffaf3 — VERDICT: APPROVE

A/B/C = 0/0/2 (C-679-1, C-679-2)

This is a full T4 audit of R2 of the #654 split; T4 because it is the money path. It sits on #678 @ `b89c199d`. The builder round is [FIX ROUND 3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/679#issuecomment-5976053666). Paths below are in `src/checkout/subscription-checkout.service.ts` unless named.

### Prior findings (this lens; #654 @ `02c48de7` APPROVE 0/0/3, [5972187301](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/654#issuecomment-5972187301))

**C-654-8: closed.**
- The terms pin comes first. Terms are pinned (`:819-822`) before the only create (`:861`). So an unpinned attempt (`firstTry`, `:795`) never reached Stripe, while a pinned one may have.
- Every pinned retry looks Stripe up first (`findAttemptSubscription`, `:846-858`):
  - found: it is bound and never re-created;
  - Stripe unreadable: the retry marker is set and the answer is PAYMENT_RETRY, with nothing sent;
  - none, and `now - created_at >= 23 h` (`:854`): the attempt ends with ATTEMPT_EXPIRED `timed_out`;
  - none inside the window: the identical pinned request goes out under the same key.
- Every path into a resend runs this lookup:
  - the same-key replay (`replayAttempt` → `claimUnbound` → mint);
  - the new-key reuse (`tryReuse` → `claimUnbound` → mint; ATTEMPT_EXPIRED maps to a fresh reservation, `:1269`);
  - the dead-request takeover (`:1116-1119`), whose terms are already pinned.
- The window is sound:
  - `created_at` precedes the first create, so a resend under 23 h after `created_at` is under 23 h after Stripe first saw the key.
  - Stripe keeps keys at least 24 h ([Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests)). That leaves a margin of at least 1 h, and an error goes toward ending the attempt.
  - Past the window, a list miss is definitive: the create was 23 h or more ago, and the subscription list is not the eventually consistent Search API.
- Two Stripe answers to a resend:
  - A 409 `idempotency_key_in_use` (the create is still running at Stripe) is not a definitive refusal, so the attempt stays retryable.
  - An idempotency mismatch still gets a second lookup (`:876-887`).
- My original probe scenario (`count: 2`, `["sub_1:trialing"]`) is case `:121` of #680's `test/b-recur-116-fix-round-3.spec.ts`. That block has 6 cases, all red before ([run 37172350469](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172350469), 19 failed / 1 passed) and green at #680 `2b10687c` ([job 111348792701](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172709393/job/111348792701)). The spec file is unchanged between `323b27c7` and `2b10687c`.

**C-654-10: closed.**
- `src/checkout/error-label.ts:41-55` returns only these labels:
  - `stripe:<type>:<status>:<code>`, with type and code from fixed lists (else `other`) and status an integer 100-599 (else `other`);
  - `http:<status>`;
  - `P` plus 4 digits, or a fixed network code;
  - a fixed class name;
  - otherwise `error` (`unknown` for a non-object).
- No message, no free-form name and no free-form code can come out.
- No `err.message` or `(err as Error)` is left in the service. All 12 catch logs use the label: `:604, :919, :1144, :1172, :1533, :1542, :1556, :1563, :1607, :1612, :1683, :1698`.
- `stripe_status=` (`:979`, `:1648`) logs Stripe's status enum, not request data.
- The address-canary cases are at `:319-405` of the same spec.

**C-654-9: closed** in mobile #342 (`src/lib/packagePayment.ts:189-202`).

**GPT-6.1 Sol's B-654-5 narrowed / B-654-8 / B-654-9.** My independent read is that they close at this head; Sol closes them.

### Evidence reuse (G09)
- **The split cut (`517def8c`).** All 8 files' patch `b89c199d..517def8c` equals #654's own patch `cd332bfa..02c48de7`. 7 of the 8 blobs are byte-identical to `02c48de7`. `checkout.service.ts` differs only by the buyer drop-status lines that #627/main changed underneath. My `02c48de7` APPROVE covers that code: decide lock, terms pin, bind-before-ephemeral-key, replay states, trial card, controller authz and copy.
- **Read deeply:** `517def8c..958806d1` line by line, plus every function it calls. Those are `findAttemptSubscription`, `claimUnbound`, `markRetryable`, `expireAttempt`, `attemptSettled`, `replayAttempt`, `tryReuse`, `finishBound`, `classifyWithoutSheet` and `retireOneStaleTrial`.

### FIX ROUND 3 cancel confirmation (B-654-8, my read)
- **What counts as canceled.** `cancelConfirmed` (`:1551-1567`) counts a cancel only when the DELETE was answered, or when a read-back shows `canceled` or `incomplete_expired`.
- **Callers.** None ends an attempt before that, and none starts a second one:
  - `retireAttempt` (`:1204-1208`): an unconfirmed cancel sets the retry marker on an unbound row, and the answer is PAYMENT_RETRY.
  - the `tryReuse` stale path (`:1371-1372`): the throw leaves the decide loop, so no second reservation is made.
  - `finishBound`'s no-sheet path (`:991`): the row stays bound and open, so the same key or a new key retries the cancel.
- **Related checks:**
  - `tryReuse` now treats `past_due` / `unpaid` as the plan (`:1293-1296`).
  - `sheetSecret` returns nothing for an ended subscription (`:1380`).
  - `retireOneStaleTrial` already expired an attempt only after a DELETE succeeded (`:1642`).
  - The remaining `cancelQuietly` (`:931`) runs only for a subscription whose row another request already ended and whose secret was never handed out.
- **Copy.** Every cancel path is reached only after the unpaid checks (`attemptSettled`, `subscriptionUnpaid`, `trialCardSaved`), so "Nothing was charged" in PAYMENT_RETRY and SUBSCRIPTION_SETUP_UNAVAILABLE stays true. No new strings.

### C-679-1: a cancel can land on a subscription that was paid a moment earlier (the builder's open race; decided C)
- **Where.**
  - `cancelConfirmed` (`:1553`) sends an unconditional `DELETE /v1/subscriptions/:id` (`src/connect/stripe-connect-api.service.ts:939-945`, #678).
  - Each caller decided "unpaid" from a read one Stripe round trip earlier: `retireAttempt` (`:1190`/`:1202`), `tryReuse` (`:1287`/`:1298`) and `finishBound`'s subscription.
- **Counterexample.**
  1. The client has the sheet open on phone 1 for attempt A (`sub_1` incomplete, `pi_1` requires_payment_method).
  2. The coach changes the price.
  3. The client starts the plan on phone 2 (a new key): decide → reuse A → `tryReuse` reads `sub_1` as unpaid with changed terms, so it is stale.
  4. Phone 1 confirms `pi_1` between that read and the DELETE: the first invoice is paid and `sub_1` becomes active.
  5. The DELETE cancels `sub_1` at once.
- **Result.** The client paid the first invoice and the plan ends immediately. Stripe's cancel call has no refund behavior; its only options are `invoice_now`, `prorate` and `cancellation_details` ([Stripe: cancel a subscription](https://docs.stripe.com/api/subscriptions/cancel)).
- **Other triggers.** A same-key replay after a terms change (`retireAttempt`) does the same. A trial whose SetupIntent succeeds inside the window loses its trial, without a charge.
- **Why C.**
  - It needs the same client paying on one surface while another request of theirs retires that same attempt, inside one Stripe round trip, plus a terms change or a stuck no-sheet state.
  - Nothing automatic triggers it.
  - The result is visible on Stripe (a canceled subscription with a paid first invoice) and refundable through support.
  - The code was unchanged since `02c48de7`.
- **Fix rule (atomic at Stripe; no new money movement).**
  - For an `incomplete` subscription, void its open first invoice before the DELETE (`POST /v1/invoices/:id/void`).
    - Stripe voids only invoices in `open` or `uncollectible` status ([Stripe: invoicing overview](https://docs.stripe.com/invoicing/overview)).
    - Voiding an incomplete subscription's first invoice moves the subscription to `incomplete_expired` ([Stripe: subscription invoices](https://docs.stripe.com/billing/invoices/subscription)).
    - So if Stripe refuses the void because the invoice is paid, the plan is live: answer `settled` / SUBSCRIPTION_ALREADY_ACTIVE and do not cancel.
  - For a `trialing` attempt, cancel its pending SetupIntent first. Stripe refuses that once the SetupIntent succeeded, which means the card was saved: keep the trial.
  - Test: a fake where the PaymentIntent succeeds after the read. Assert there is no DELETE and the answer is ALREADY_ACTIVE.
- **Where the fix should live (size).**
  - The two Stripe calls go in #678's `stripe-connect-api.service.ts` (about 25 lines; #678 is at 747).
  - The call goes in #679's `cancelConfirmed` (about 15 lines, which puts #679 near 2,967 of 3,000).
  - The test goes in #680 (now 2,914).
  - It fits, but tightly. My recommended default is a follow-up PR on main right after the stack lands. If a later round reopens #679 anyway, fold it in then.

### C-679-2: more than 100 subscriptions on one customer makes the lookup permanently unreadable
- **Where.**
  - `findAttemptSubscription` (`:1166-1168`) uses `listSubscriptionsForCustomer` (#678 `stripe-connect-api.service.ts:889-897`: `status=all`, `limit=100`, no `created` bound).
  - `status=all` returns every ended attempt and plan of that customer, for good.
  - Once a customer has more than 100 subscriptions, any lookup without a hit on the first page answers `unreadable`. The same key then answers PAYMENT_RETRY forever. A new key recovers only after the 23 h reuse window.
- **Why C.** 100 lifetime subscriptions for one client is unrealistic today, and the builder noted it.
- **Fix rule (cheap).**
  - Pass `created[gte]` = reservation `created_at` minus a skew margin (for example 5 minutes).
  - The attempt's own subscription is always created after its reservation, so the bounded list holds it if it exists, and `has_more` then means 100 subscriptions were created since this attempt began.
  - Where: an optional parameter in #678 (about 3 lines) and the one call site in #679.
  - Test: 101 older subscriptions in the fake, and the lookup still resolves.

### Piece boundary
- **Compiles alone.** build-and-test is green at this head on attempt 1: 725 suites, 12,501 tests ([job 111348789748](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172708421/job/111348789748)).
- **Imports.** Only #678 and main code; nothing from #680.
- **Not inert.**
  - It mounts these routes:
    - `POST /v1/checkout/subscription-intent`;
    - `GET /v1/checkout/subscriptions[/:id]`;
    - `POST .../resume`.
  - It makes `payment-intent` refuse renewing packages (`RECURRING_REQUIRES_SUBSCRIPTION`).
  - The webhook work that grants and settles these subscriptions is in #680.
  - So #679 must never land or deploy without #678 and #680. Rule 11 lands them back to back, and the stack deploys only after R3, with mobile #342-#344. This is a gate, not a finding.
- **Tests.** This round's tests live in #680 for size reasons. The in-piece specs (subscription-checkout, terms, lockout route table) pass at this head.

### Operator question: `test/ci/delivery-artifact.spec.ts:284`
- **Which head.** That failure was at #679 `517def8c`: CI run 37151675007, attempt 1 ([job 111286676037](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151675007/job/111286676037)), 1 failed / 12,500 passed. On attempt 2 at the same head the spec passed and the job hit the known out-of-memory crash in `community-message-shape.live.spec.ts`; attempt 3 was green. At `958806d1` it passes (job above), and at #680 `2b10687c`.
- **Not caused by #679.** `scripts/ci/assert-prod-sbom.sh` and the spec are identical to main `d23fa317`, and #679 touches neither.
- **Root cause.** It is a real main-side gate bug, not a flake to rerun.
  - `assert-prod-sbom.sh:24` sets `-o pipefail`, and `:59` tests `printf '%s\n' "$NAMES" | grep -qxF "$d"`.
  - `grep -q` exits at the first match. printf then dies on SIGPIPE (exit 141), pipefail makes the pipeline fail, and the `if` reads a present denylisted tool as absent. So the denylist can pass a production SBOM that contains eslint: the gate fails open (G07).
  - `:62` has the inverse bug: a present required package can read as missing, which gives a spurious red.
  - A local probe of that exact construct missed 45 and 97 times in two runs of 3,000; a here-string missed 0 of 3,000.
- **Fix.** A separate T4 CI-gate PR on main: use `grep -qxF -- "$d" <<<"$NAMES"` at `:59` and `:62`, plus a regression spec. This does not block #679.

### Checks and size at this exact head
- **Green:** build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit and Schema parity.
- **Not run on a stacked base:** CodeQL, danger, Banned cast tokens and build-sbom. They must pass after the retarget to main.
- **Banned casts.** Main's committed `scripts/check-r75.js --mode=range` (`b89c199d..958806d1`) prints "OK — no positive token change".
- **Size:** 2,952 changed lines (+2,950 / -2). Neither C needs to land in this piece.

### Merge gates (not findings)
- Rule 11: this lands with #678 and #680, after fees F1-F6.
- The owner adds the Stripe `setup_intent.succeeded` webhook event before deploy.
- The #654/#628 never-entitled helper ruling and the C-661-3 credential-clearing ruling stand. Whichever PR merges second carries them.
