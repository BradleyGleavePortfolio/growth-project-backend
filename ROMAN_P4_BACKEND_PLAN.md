# Roman P4 backend — CoachFirstPaymentNotification (Option C)

Author: Bradley Gleave <bradley@bradleytgpcoaching.com>

DB-enforced exactly-once first-payment notification, replacing mobile #242's
client-side ClientPurchase counting. Additive + feature-flagged
(`FEATURE_ROMAN_FIRST_PAYMENT`, default OFF).

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

## Commits
C1 model+migration · C2 enum+skeleton · C3 impl · C4 webhook gate · C5 tests.
Each `tsc --noEmit` clean; pushed after every commit. PR opened at end (NOT merged).

## 50-Failures focus
#28 race (unique IS the protection), #29 idempotency (direct INSERT catch P2002),
#36 silent failures (structured P2002 log), #44 multi-step tx (emit inside purchase tx),
#34 observability (event+coachId, no PII), #12 secrets (no Stripe/customer data in logs),
#5 IDOR (server-trusted purchase fields).
