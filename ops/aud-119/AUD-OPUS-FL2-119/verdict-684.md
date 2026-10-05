AUDIT Claude Opus 5.5 — growth-project-backend#684 @ c1a07d9cc0a282a4e335035d11bb7eb8b2e0eca5 — VERDICT: APPROVE
A/B/C = 0/0/4

AUD-OPUS-FL2-119, agent 119. T4 (refunds, payouts, concurrency). Round-19 delta 9fb9c48f..c1a07d9c (one commit, 4 files, +185/-33): every line read. Evidence reused: my APPROVE trail on this PR up to 9fb9c48f (ops/reports/AUD-OPUS-FL-119.md); only the delta below is new code.

**Prior findings**
- B-684-12 (refund status lost update): CLOSED. `writeRefundStatus` (src/checkout/refund-dispute-handler.service.ts:672-695) updates `where { stripe_refund_id, status: <status read> }` (Prisma 6.19 non-unique where; a miss is P2025). On a miss it re-reads and recomputes `nextRefundStatus` from the stored status. All three writers use it: the existing-row update (:557), the P2002 insert race (:595) and the legacy no-settlement `refund.updated` path (:441). There are no other `chargeRefund` status writers in src (the only other `update` at :648 sets ledger_reversed under the charge lock). `nextRefundStatus` depends only on the stored status, so a CAS on status alone is sufficient. A pending/requires_action ABA cannot cause a wrong decision.
- Exhaustion (5 misses): throws `RefundStateUnavailableError('kind=refund_status_contended')` before any apply, flag or alert of that refund. It is in `isRetryableMoneyError`, so the webhook fails and Stripe redelivers. The admin refund path returns the recorded row and leaves the apply to the webhook (:1439). In a charge.refunded loop, refunds applied earlier in the same delivery are idempotent on `ledger_reversed`, so the redelivery converges. Each miss means the stored status changed, so 5 misses need 5 interleaved writers on one refund. Fail-closed is the right outcome.
- Sol B-684-3 (send boundaries): CLOSED, as far as this code can reach.
  - Email: the `email_attempts` CAS result is now honoured (`taken.count !== 1` sends nothing). After that write the claim and the budget are proved again (`canSend`). On a stop, the attempt number is returned only while this worker still holds the claim. `noticeSendSignal` (payout-notice.service.ts:124-145) aborts at `stopAt = min(deadline, claimedAt + TTL)` on a timer, and on any `aborted` read at or past `stopAt`. EmailService checks it before the log insert and again right before the transport; the second check finalizes the row 'failed' and returns `notStarted`. Resend's fetch receives the signal.
  - Push: pushToUser receives the signal and re-checks it after the token read and before each Expo chunk.
  - `send()` without a signal behaves exactly as before for every other caller.
- C-697-3: closed (L0-L3 are in the r19 spec).

**Probe replay** (my probes, unchanged; branch audit/AUD-OPUS-FL2-119/697-replay on #697 be7efc09): run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37236744088 has 7 suites and 68/68 PASS:
- Opus FL-119 L0-L3: L1-L3 failed at 9fb9c48f and now pass.
- Opus F4-119, Opus F34-117.
- r17, r19, email.service, coach-alerts-push-delivery.

**Money list**
- Webhook order and redelivery: monotonic status with CAS. Exhaustion is retried by redelivery.
- Concurrency: the status write happens outside the lock. The apply re-reads the status under the lock, and the failed-after-apply flag also runs under the lock. Both orders were proved by the L probes.
- Terminal states: failed and canceled stay terminal, and succeeded never regresses.
- Pagination: unchanged (the list is complete or the delivery fails closed).
- Currency: unchanged (presentment minor units).
- Copy: no new copy.

**Follow-ups (C)**
- C-684-13: src/notifications/notifications.service.ts:713. `checkAborted()` runs after the Expo send. An abort that lands after Expo accepted reports 'aborted', and payout-notice.service.ts:483 leaves the push pending, so the next run pushes again (a duplicate on the coach's device). Probe (passes, i.e. the duplicate is real): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37237037877 (audit/AUD-OPUS-FL2-119/684-dup-push; Expo called twice for one notice). Rule: report 'aborted' only before the first chunk is sent. After a send, return the real ticket outcome. Separately, the Expo SDK call itself cannot be aborted, so the 60 s margin is the only bound in flight.
- C-684-14: src/email/email.service.ts:343-372. ResendTransport sends no `Idempotency-Key`, so an abort mid-request after Resend accepted it records 'failed', and attempt k+1 mails again. Rule: send the attempt key as the `Idempotency-Key` header.
- C-684-3 (carried): refund-dispute-handler.service.ts:1209. The dispute alert copy must follow R-DISPUTE-PAUSE for recurring plans (#687/#688).
- C-684-11 (carried): refund-dispute-handler.service.ts:285. charge.refunded decides a full refund from `amount_refunded`, which counts pending refunds. Rule: use the succeeded rows against the charge amount. On a failed refund that ended access, alert the coach with no automatic restore.

Size: 2,843 (grandfathered, ceiling 3,000). CI: required checks green at this head (pass=10, skipping=1).
