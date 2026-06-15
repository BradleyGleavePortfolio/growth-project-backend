# Roman P4 backend — CoachFirstPaymentNotification (Option C)

Author: Bradley Gleave <bradley@bradleytgpcoaching.com>

DB-enforced exactly-once first-payment notification, replacing mobile #242's
client-side ClientPurchase counting. Additive + feature-flagged
(`FEATURE_ROMAN_FIRST_PAYMENT`, default OFF).

## Scope of "first payment" — per coach, FOREVER (R81 F3 clarification)

The celebration fires on a coach's **first-ever** successful client payment and
**never again** — it is scoped **per coach, forever**, NOT per coach×client.
This is what `schema.prisma` enforces (`CoachFirstPaymentNotification.coachId
@unique` — "Exactly one row per coach can ever exist"), what the migration
header states, and what the unit tests assert. The original PR #395 title/brief
wording ("per coach×client") was imprecise and is corrected here and in the
follow-up PR title; the implementation was always per-coach-forever and the
tests were never changed. Concretely:

- Coach A's first payment (any client) → emit.
- Coach A's later payment from a DIFFERENT client → NO emit (already had their
  first-ever).
- Coach B's first payment (even the SAME client as A) → emit (B's own
  first-ever — see the F4 two-distinct-coaches test).

## Stripe Connect / sub-coach attribution (R81 F6)

The emit is keyed to the **selling** coach (`ClientPurchase.coach_user_id`).
When a sub-coach sells under a head coach's Connect account, the celebration is
attributed to that selling sub-coach — it is THEIR first client payment. The
head-coach revenue split is a separate downstream ledger concern
(`head_coach_split`) and does not change who receives this once-ever
notification. Locked by the sub-coach attribution unit test.

## Refund / chargeback behaviour — RETAIN-BY-DESIGN (R81 F5)

A refund (even a full one) or a chargeback does **NOT** un-record the
`CoachFirstPaymentNotification` ledger row. The milestone is a once-ever,
permanent celebration keyed to the coach's first SUCCESSFUL charge; a later
refund does not retroactively erase that they made a first sale. Accepted
consequence: a coach whose only payment is fully refunded will not see the
celebration fire again on a genuinely-new future first payment.
`RefundDisputeHandlerService` therefore never touches the first-payment ledger,
locked by `first-payment-refund-retention.spec.ts`.

## Transaction boundary — emit rides the purchase tx (R81 F1/F2)

The notification rows are written via the ambient purchase `tx`
(`tx.notification.create`), threaded
`CheckoutWebhookHandlerService.maybeEmitFirstPayment → tryEmitFirstPayment →
FirstPaymentEmitter.emit → NotificationsService.createNotification(input, tx)`.
The ledger row, the dedup row, and the notification rows commit-or-roll-back
together, so an outer rollback (e.g. a fanout resolver re-throw) leaves ZERO
committed notifications and Stripe's redelivery produces exactly one. This
closes the original P0/P1 where the emit escaped to NotificationsService's
autocommitting client and could survive a rollback (re-firing on retry) or be
delivered before the purchase committed.

## Observability — audit entry (R81 F8)

`tryEmitFirstPayment` writes an `AuditService` entry
(`action: notification.first_payment_emitted`) on the winning insert, before
the emit, carrying `coach_id`, `client_id`, `amount`, `currency`, `event`, and
`correlation_id` (the Stripe event id). No PII. Best-effort (AuditService
swallows its own errors) so it cannot break the purchase tx.

## Files

- `prisma/schema.prisma` — ADD model `CoachFirstPaymentNotification` (coachId @unique) + User back-relation.
- `prisma/migrations/<ts>_add_coach_first_payment_notification/migration.sql` — generated (`--create-only`).
- `src/notifications/notification-kind.ts` — ADD `FIRST_PAYMENT = 'first_payment'`.
- `src/notifications/emitters/first-payment.emitter.ts` — thin emitter (matches existing emitter pattern).
- `src/notifications/coach-first-payment.service.ts` — `tryEmitFirstPayment(tx, {...})`: direct INSERT, catch P2002 → structured log + no-op, rethrow others; on success enqueue notification.
- `src/checkout/checkout-webhook-handler.service.ts` — gated call inside BOTH existing in-tx callsites (checkout.session.completed @ applyCheckoutCompleted, payment_intent.succeeded @ applyPaymentIntentSucceeded), after the purchase status flip.
- `src/checkout/checkout.module.ts` / `notifications.module.ts` — wire the new providers.
- `src/notifications/__tests__/coach-first-payment.service.spec.ts` — new tests.

Server-trusted inputs only (coachId/clientId/amount/currency from the persisted
ClientPurchase row, never the webhook body — 50-Failures #5 IDOR).

## Migration name
`add_coach_first_payment_notification`

## Tests
1. Idempotency: twice same coachId → no throw, second is no-op, exactly ONE row.
2. Rollback safety: outer tx rollback also rolls back the notification row (same tx).
3. Flag OFF: webhook handler does not call the service.
4. Flag ON, first payment: row created + notification enqueued.
5. Flag ON, second payment same coach: row NOT duplicated + notification NOT re-enqueued.

### R81 follow-up tests (PR-395-FOLLOWUP)
6. F1/F2: ledger INSERT succeeds then outer tx ROLLS BACK → ZERO committed
   notification rows; Stripe redelivery → exactly one per channel; happy-path
   commit → exactly one per channel (`first-payment-tx-rollback.integration.spec.ts`).
7. F1/F2: full webhook handler wrapped in a `$transaction` whose body throws
   after `maybeEmitFirstPayment` → ZERO committed notifications; commit → one
   per channel (`first-payment-webhook.integration.spec.ts`).
8. F4: two DIFFERENT coaches, SAME client → BOTH emit.
9. F5: refund/dispute handler never references the first-payment ledger
   (retain-by-design lock — `first-payment-refund-retention.spec.ts`).
10. F6: Stripe Connect / sub-coach → emit attributes to the selling
    `coach_user_id`, not the head coach.
11. F8: audit entry written (with the required fields) on the winning insert,
    and NOT on the P2002 no-op.
12. F7: test mocks strict-typed (no `as unknown as`).

## Commits
C1 model+migration · C2 enum+skeleton · C3 impl · C4 webhook gate · C5 tests.
Each `tsc --noEmit` clean; pushed after every commit. PR opened at end (NOT merged).

## 50-Failures focus
#28 race (unique IS the protection), #29 idempotency (direct INSERT catch P2002),
#36 silent failures (structured P2002 log), #44 multi-step tx (emit inside purchase tx),
#34 observability (event+coachId, no PII), #12 secrets (no Stripe/customer data in logs),
#5 IDOR (server-trusted purchase fields).
