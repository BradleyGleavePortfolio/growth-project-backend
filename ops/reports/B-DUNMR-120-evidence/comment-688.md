FIX ROUND 5 (B-DUNMR-120, agent 120) — growth-project-backend#688 @ 21714f7bba299336cf71df0c87288c798fd5da13

This round closes **C-680-18**, an Opus R34D-119 hard obligation before `FEATURE_DUNNING_V2=true` (owner default: yes). Dunning lands second, so the guard lands in this stack.

**Size:** 2,784 changed lines (2,249+/535-), up from 2,440. This PR is grandfathered and stays under 3,000.

| Finding | Change | Commit | Test |
|---|---|---|---|
| C-680-18 (A, hard obligation): with the flag on, `applyImmediateClear` (the invoice.paid / card-update / manual clear) wrote `entitlement_active: true` and lifted a Day-10 lock on a plan that had ended or been revoked: refunded, chargeback_lost, disputed, canceled or expired, without access. On main, the fence returns the revoked row, then `applyInvoicePaid` still calls the clear. | Under the DunningState lock and then the ClientPurchase lock (`FOR NO KEY UPDATE`, the webhook's mode, so on the caller's tx it reuses the lock already held), read the purchase. Refuse when `dunningPurchaseEnded(purchase)`: no access, the lock is kept, no blocker is dismissed, no recovered telemetry is sent, and a missing purchase is refused too. `dunningPurchaseEnded` uses the same status set as the webhook's `purchaseHasEnded`; a parity spec covers all 14 statuses with access and without. The refusal is logged with ids and `via` only. | `ff3a13a5` (test, failing before), `21714f7b` (guard) | `test/dunning-v2-c680-18.spec.ts`: failing-before lane [37343244840](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343244840) at `ff3a13a5` had 12 failed / 17 passed (every guard case red; controls and parity green). After: PR build-and-test [37343332177](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343332177) is green at this head. |

The spec covers the R34D probe's lock variant (the D2a counterexample: on D2, only a locked cycle writes access) through the real webhook handler on main's code: invoice.paid, then customer.subscription.updated(active), never reopens the plan. Controls: a past_due plan locked at Day 10 still recovers (access back, lock lifted), and an ended status that still has access is not treated as revoked.

**Probe replay (both lenses):** CI lane [37344925094](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344925094) at this head: 70 passed, 2 failed (both expected, see below).

| Probe (lens) | Result |
|---|---|
| Opus 116 aud-opus-d12-688-lost-dispute | pass |
| Opus 118 aud-opus-d12-118-688 parts 1-4 | pass |
| Sol 116 aud-sol-d12-116-d2 | pass |
| Sol 118 688-probe, 688-probe-v2 | pass |
| D1 probes (Opus 118 687, Sol 116 d1, Sol 118 687 adapted) | pass |
| Opus R34D-119 C-680-18 (7 cases, flag on) and its 13 controls | pass |
| Opus R34D-119 C-680-18 lock variant (B-DUNMR-120 adaptation, 4 statuses) + control | pass |
| Opus R34D-119 C-680-19 (won dispute writes paid) and its pause variant | expected red on D2a: C-680-19 belongs to the R-DISPUTE-PAUSE build and closes in D2c #705 (green there). No pause exists before D2c, and the flag stays off until the stack lands. |

The adapted probe is saved as `ops/reports/B-DUNMR-120-evidence/probes/aud-opus-r34d-119-probe-dunmr.spec.ts`.

**Money self-check**
- Webhook order/redelivery: a refused clear writes nothing, so a redelivered invoice.paid refuses again. The clear stays idempotent.
- Concurrency/lock order: the clear takes DunningState, then ClientPurchase (the dunning order). On the webhook tx the purchase lock is already held in the same mode; D2c #705 passes that tx. The inversion against the webhook's own order is carried as C-688-9 (Postgres detects it; one delivery retries).
- Terminal states (refunded/disputed/canceled/deleted): refunded, chargeback_lost, disputed, canceled, expired and incomplete_expired without access are refused. A deleted purchase is refused.
- Pagination fail-closed: this change reads no lists.
- Currency/minor units/zero-decimal: no amounts are touched.
- Copy truth: no copy change. The log line has ids only.

**Required checks at this head:** all green (11 checks; deploy-readiness-gate is skipped by design).

READY FOR AUDIT
