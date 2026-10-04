# Refund: head-coach transfer reversal still owed after 23 hours

When a client is refunded on a team sale, the head coach's share comes back by reversing that sale's own head-coach transfer.
The refund-scoped Stripe key is `tgp-tr-rev-refund-<ChargeRefund.id>`. Every path that completes a refund (`charge.refunded`,
`charge.refund.updated`, the admin refund) and the 15-minute retry sweep send that same key, so Stripe makes one reversal.
Stripe keeps a key for 24 hours after its first request. A resend after that could make a second reversal, so the backend
resends only while the first attempt (`ChargeRefund.transfer_reversal_first_attempt_at`) is under 23 hours old. A reversal
still owed after that leaves automatic retry and waits for an owner.

## Alert

Sentry issue **"head-coach transfer reversal needs operator review"**, tag `code=REFUND_TRANSFER_REVERSAL_REVIEW`, one issue per
refund (fingerprint `refund-transfer-reversal-review` + the refund id). Extra fields: `charge_refund_id`, `purchase_id`,
`amount_cents` (the client refund), `first_attempt_at`. It fires once per refund, when the row moves to review
(`transfer_reversal_review_at` is set).

## Runbook line

Within one business day: `GET /v1/admin/payments/refund-reversals/review` (owner), then for each row
`POST /v1/admin/payments/refund-reversals/<charge_refund_id>/reconcile` with an empty body. Both routes take the owner's
Supabase JWT as the bearer (the owner-console service token is refused). Stripe is the truth:

| Response `outcome` / `code`                      | Meaning                                                                                                                                              | Next action                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorded_from_stripe`                           | Stripe already holds the reversal for this refund (metadata `tgp_charge_refund_id`); it is now recorded locally.                                     | None. Resolve the Sentry issue.                                                                                                                                                                                                                       |
| `reversed`                                       | Stripe held none; one new reversal was sent under `tgp-tr-rev-refund-<id>-review` and recorded.                                                      | None. Resolve the Sentry issue.                                                                                                                                                                                                                       |
| `nothing_owed`                                   | The head-coach transfer has nothing left to reverse.                                                                                                 | None.                                                                                                                                                                                                                                                 |
| 409 `TRANSFER_REVERSAL_UNATTRIBUTED`             | Stripe holds reversals on that transfer that name no refund (made by hand in the Dashboard). The body lists their ids and amounts.                   | In the Stripe Dashboard (Connect > Transfers > the transfer > Reversals) decide whether one of them is this refund's. If yes, re-send with `{"stripe_transfer_reversal_id": "trr_..."}`. If none is, re-send with `{"confirm_none_in_stripe": true}`. |
| 409 `TRANSFER_REVERSAL_BELONGS_TO_OTHER_REFUND`  | The id you named was made for a different refund.                                                                                                    | Pick the right reversal, or reconcile with an empty body.                                                                                                                                                                                             |
| 409 `TRANSFER_REVERSAL_ASSIGNED_TO_OTHER_REFUND` | That reversal is already recorded for a different refund (one Stripe reversal settles one refund).                                                   | Pick the reversal made for this refund, or reconcile with an empty body.                                                                                                                                                                              |
| 409 `TRANSFER_REVERSAL_UNDERSIZED`               | The reversal is smaller than this refund's head-coach share (`reversal_amount_cents` < `owed_cents`). Nothing was recorded; the row stays in review. | Escalate to engineering with the refund id and both amounts. Do not reverse the rest by hand.                                                                                                                                                         |
| 422 `TRANSFER_REVERSAL_NOT_FOUND`                | No reversal with that id on this transfer.                                                                                                           | Copy the id again from the Dashboard.                                                                                                                                                                                                                 |
| 409 `REFUND_TRANSFER_REVERSAL_NOT_IN_REVIEW`     | The row is still inside the automatic window.                                                                                                        | Wait; the sweep owns it.                                                                                                                                                                                                                              |

Never reverse a head-coach transfer by hand in the Dashboard for a row in review without recording it here afterwards
(`stripe_transfer_reversal_id`), or the books and Stripe disagree. Never reverse any other transfer of that coach (OR-111-1).

The `transfer.reversed` webhook never changes the recorded totals. When Stripe's total on a transfer is higher than what
the backend recorded, it logs `TRANSFER_REVERSAL_NOT_YET_RECORDED` with the transfer id and both totals: a reversal still
being recorded (the sweep or this runbook settles it) or one made by hand in the Dashboard (record it here).
