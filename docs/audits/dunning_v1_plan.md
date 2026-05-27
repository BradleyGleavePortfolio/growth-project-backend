# Dunning v1 — Plan

## TL;DR

Dunning today is a single-window failure tracker driven by `invoice.payment_failed`. There is no scheduled-reminder cadence (Day 3 / 7 / 14), only an opportunistic "final warning" check during the sweeper for rows within 24h of cancel. v1 layers a deterministic cadence on top of the existing `DunningState` row by introducing a `DunningAttempt` table (one row per scheduled cadence step) plus a `tick` loop that materializes attempts when their `scheduled_for` arrives. Cadence and copy are config-driven, all transitions are structured-logged + counted, admin can inspect/advance/reset/cancel/trigger-now, and four new email templates separate the soft/urgent/final/recovered messages.

## Current state

The existing `DunningService` (327 lines) does three things: open or extend a `DunningState` window on failure, queue one in-app + one email `PaymentReminder` (deduped by Stripe invoice id), and run a sweeper that (a) cancels subscriptions whose `grace_period_ends_at` or `cancel_scheduled_at` has elapsed and (b) emits a `final_warning` reminder for rows within 24h of cancel. The webhook handler already routes `invoice.payment_failed` → `recordFailure()` and `invoice.paid` → `recordResolution()`; `customer.subscription.deleted` already cancels the purchase row but does NOT terminate the dunning window (it would naturally be cleaned up by the sweeper later, but state stays `active`).

The reminder rows reach a `queued` status; nothing in the v0 service actually *sends* them — the `markReminderSent` path exists but no caller wires it to `EmailService`. The single `payment-reminder.hbs` template covers all reminder kinds with one subject ("Your subscription payment is due soon"), which is wrong for an urgent / final notice. The cadence "Day 0, Day 3, Day 7, Day 14" the spec calls for is not implemented — reminders fire only when Stripe retries (which Stripe schedules on its own clock) and once during the 24h-before-cancel sweep.

## Gap analysis vs the v1 spec

1. **Cadence (Day 0/3/7/14).** Missing: there is no time-based scheduler that fires reminders at fixed offsets from the first failure regardless of Stripe retry timing. v1 needs a `DunningAttempt` row per cadence step (scheduled by service at failure time) plus a tick loop that drains attempts whose `scheduled_for <= now`.
2. **Idempotency.** The reminder table dedupes by `(purchase_id, kind, channel, window_key)`, which is OK for one-shot retries but not for cadence — each cadence step needs its OWN attempt row with its own idempotency key. v1 keys attempts by `(dunning_state_id, step_index)` (unique constraint) and emails by `dunning:<attempt_id>` via `EmailService.send`.
3. **Webhook routing.** `invoice.payment_failed` (open/extend) and `invoice.paid`/`invoice.payment_succeeded` (resolve) already exist; `customer.subscription.deleted` needs to also terminate dunning explicitly (status='abandoned').
4. **Configurable cadence.** Days, template keys, escalation rules currently hardcoded (`DUNNING_GRACE_DAYS_DEFAULT`, `DUNNING_MAX_FAILURES_DEFAULT`, the 24h `final_warning`). v1 moves to a single exported `DunningCadenceConfig` constant overridable via env (`DUNNING_CADENCE_DAYS`).
5. **Admin override.** Payment-ops controller exposes `dunning/run-sweeper` and a per-purchase `dunning` field on the drill-down, but no `advance` / `reset` / `cancel` / `trigger-immediate-reminder` endpoints. v1 adds four `POST /v1/admin/payments/dunning/:purchaseId/{advance|reset|cancel|trigger}` endpoints.
6. **Observability.** Service uses Logger.warn on Stripe failures only. v1 emits a structured `logger.log` JSON line on every transition (`opened`, `attempt_scheduled`, `attempt_sent`, `recovered`, `escalated`, `cancelled`) and increments counters (`dunning_entered_total`, `dunning_recovered_total`, `dunning_escalated_total`, `dunning_cancelled_total`) via a small in-process `DunningMetricsService` that mirrors what's done elsewhere in the codebase.
7. **Email templates.** Only `payment-reminder.hbs` and `dunning-final.hbs` exist (plus `payment-failed.hbs`). v1 adds `payment-reminder-soft.hbs`, `payment-reminder-urgent.hbs`, `payment-final-notice.hbs`, `payment-recovered.hbs` as NEW files (the spec forbids modifying `payment-reminder.hbs`).

## Proposed state machine

```
                 invoice.payment_failed
   (none) ──────────────────────────────► OPEN  (step=0, scheduled[3,7,14])
                                            │
                                            │ tick (scheduled_for ≤ now)
                                            ▼
                                          OPEN  (step=1 soft sent)
                                            │
                                            │ tick
                                            ▼
                                          OPEN  (step=2 urgent sent)
                                            │
                                            │ tick
                                            ▼
                                          OPEN  (step=3 final sent, cancel queued)
                                            │
                                            │ tick at day 14 OR admin cancel
                                            ▼
                                        ABANDONED  (sub cancelled on Stripe + recovered=false)

   any state  ── invoice.payment_succeeded ──► RESOLVED  (recovered=true, all pending attempts cancelled)
   any state  ── customer.subscription.deleted ──► ABANDONED  (no further attempts, no recovery email)
   any state  ── admin reset ──► (none)   any state ── admin advance ──► next step now
```

`DunningState.status` keeps the existing `active | resolved | abandoned` taxonomy; v1 adds `step_index` (0..3) and `next_attempt_at` columns derived from the cadence. `DunningAttempt` is the per-step record (queued → sent → failed/skipped) and is what tests assert against.

## Schema changes

Additive only:

- **NEW model `DunningAttempt`**: `id`, `dunning_state_id FK`, `step_index Int`, `kind String` (soft|urgent|final|recovered|cancelled), `scheduled_for DateTime`, `status String` (pending|sent|failed|skipped|cancelled), `sent_at DateTime?`, `email_idempotency_key String? @unique`, `provider_message_id String?`, `failure_reason String?`, `created_at`, `updated_at`. Unique `(dunning_state_id, step_index)`. Indexed by `(status, scheduled_for)` for tick lookup.
- **DunningState additions** (nullable / defaulted so they don't conflict with the CNAME subagent's schema work): `step_index Int @default(0)`, `next_attempt_at DateTime?`, `entered_at DateTime?`, `recovered_at DateTime?` (kept separate from existing `resolved_at` so older rows still read correctly), `escalated_at DateTime?`. Index on `(status, next_attempt_at)`.

One forward-only migration `prisma/migrations/20261001000000_dunning_v1/migration.sql`. No data backfill needed — existing `DunningState` rows continue to work; v1 cadence applies to new failures only.

## API surface

Service:
- `DunningService.recordFailure(input)` — unchanged signature, now schedules cadence attempts.
- `DunningService.recordResolution(purchaseId)` — unchanged signature, now also cancels pending attempts and emits a `payment-recovered` email if any reminder was already sent.
- `DunningService.terminate(purchaseId, reason)` — NEW. Called by `customer.subscription.deleted` handler.
- `DunningService.tick(now?)` — NEW. Drains all attempts whose `scheduled_for <= now`, calls `EmailService.send`, advances `DunningState.step_index` and `next_attempt_at`. Idempotent via attempt rows.
- `DunningService.adminAdvance/adminReset/adminCancel/adminTriggerImmediate(purchaseId)` — NEW admin override surface.

Controller (admin):
- `GET /v1/admin/payments/dunning/:purchaseId` — current state + attempts list.
- `POST /v1/admin/payments/dunning/:purchaseId/advance` — fire next reminder now.
- `POST /v1/admin/payments/dunning/:purchaseId/reset` — clear cadence (purge pending attempts), keep state row.
- `POST /v1/admin/payments/dunning/:purchaseId/cancel` — abandon now + cancel Stripe sub.
- `POST /v1/admin/payments/dunning/:purchaseId/trigger` — force re-send current step.

## Test plan

1. **`recordFailure` schedules attempts.** First failure produces 4 attempts (`step_index` 0..3) with `scheduled_for` matching cadence days.
2. **`recordFailure` idempotent.** Second failure for the same invoice does not duplicate attempts.
3. **`tick` fires step 0 at Day 0** and only step 0; subsequent ticks fire 1/2/3 once each.
4. **`tick` idempotent** — invoking twice within the same minute does not double-send (status flip to `sent` plus unique email idempotency key).
5. **`recordResolution` cancels pending attempts** and queues a `payment-recovered` email if at least one reminder had been sent.
6. **`customer.subscription.deleted` terminates** — `terminate()` marks status=`abandoned`, cancels remaining attempts, no recovery email.
7. **Admin advance** fires the next pending attempt immediately and bumps step.
8. **Admin reset** clears pending attempts but leaves the `DunningState` row in `active`.
9. **Admin cancel** abandons + calls Stripe `cancelSubscription`.
10. **Admin trigger** re-fires current step (creates a follow-up attempt with `step_index=current`, `scheduled_for=now`, new idempotency key).
11. **Webhook idempotency** — invoking `applyInvoicePaymentFailed` twice with the same Stripe event id results in one set of attempts.
12. **`tick` skips when subscription already cancelled** (no Stripe re-cancel).
