RESTACK + FIX ROUND 1 (B-DUNMR-120, agent 120) — growth-project-backend#705 @ 5138947cd082328b81cbeb787833914431b22fc1

This round restacks D2c onto D2b #704 `49d0b66e`, which brings main's recurring R1-R5 and fees code and #688's C-680-18 guard. It resolves the `checkout-webhook-handler.service.ts` conflict and fixes four Bs found on the composed tree. R-DISPUTE-PAUSE holds on the composed tree.

**Size:** 1,409 changed lines (1,029+/380-), up from 1,287. It is under 1,500.

**Conflict resolution** (merge `ea8fab86`): both handler hunks take main's code (`lockPurchase`, `purchaseHasEnded`, `subscriptionGrantsAccess`, the revision fence, `trialStartPatch`, `nextVersion`). D2c's dispute-pause read is then added to the access decision (`entitled = subscriptionGrantsAccess(...) && !disputePaused(...)`) in customer.subscription.updated and in invoice.paid. In `dunning-v2.service.ts`, D2a's C-680-18 helper is kept next to the D2c pause section.

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-DUNMR-1 (B, flag-independent): `disputePaused` took `DunningState FOR UPDATE` on the webhook tx. v1 `recordResolution` then updates that row on its own connection, so invoice.paid on any plan with a DunningState row waited until the 5 s tx timeout and the delivery failed. | Read the marker under the purchase lock only (the pause and the coach restart take that lock too). | `5138947c` | `test/dunning-v2-c680-18.spec.ts` "a paused plan (active/paid, no access)": no DunningState lock before v1 |
| B-DUNMR-2 (B): main's invoice.paid called `applyImmediateClear` without its tx. The clear's ClientPurchase lock and write then waited on the outer tx's purchase lock. | Pass `tx` (D2a's contract: the caller's tx when one is held). | `5138947c` | same spec: the clear receives the webhook tx |
| B-DUNMR-3 (B, R-DISPUTE-PAUSE): `applyImmediateClear` decided the pause on a read taken before the lock. A pause committed while the clear waited on the locks was undone (lock lifted, access back) on the card-update path. | Re-read `isDisputeCycleOpen` under the clear's locks. | `5138947c` | `test/dunning-v2-dispute-pause.spec.ts` "a pause committed while a clear waits on the locks keeps the plan paused" |
| C-680-19 (Opus R34D-119, R-DISPUTE-PAUSE build): a won dispute wrote `paid` (refund-dispute-handler.service.ts, won branch). `paid` without access does not count as ended, so a later sub.updated re-granted access (flag off or rolled back). | On a recurring plan without access, a won dispute keeps `disputed` (revoked); only the coach restart grants access. One-time purchases, and recurring plans that kept access, still go to `paid`. | `5138947c` | `test/dunning-v2-c680-18.spec.ts` "C-680-19: a won dispute keeps a paused recurring plan revoked" + 2 controls |

Failing-before lane [37344610390](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344610390) at `8195dc68` (merge + tests, no fixes): 4 failed / 62 passed, and the 4 failures are exactly the new regressions. After: PR build-and-test [37345119642](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37345119642) is green at this head. While on the B-DUNMR-1 lines, `disputePaused` was also moved out from between `activateUnderPackageLock`'s doc comment and its method.

**Owner rulings 09:43 PDT 10-05**
- (6) Inquiries pause: the service pauses on any dispute id. `handleLateReversal` / `applyDisputePause` have no status filter, and a `warning_closed` closure pauses when it is processed first. New test: an inquiry pauses, and `warning_closed` restores nothing. As with full disputes, the webhook passes the dispute id only from D4 #690 (today `fireLateReversalProbe` sends none, so the result is `no_dispute_id`). This is not a B on #705.
- (5) A refund that fails after access has ended: on the composed tree `flagFailedAfterApply` (refund-dispute-handler.service.ts:697-712) writes no ClientPurchase field, so access does not change and the client cannot retry. The alert today is an ops log (`SFEE_REFUND_FAILED_AFTER_APPLY alert=true`) plus a settlement review flag. No coach notice is sent yet; that goes to the fees owner as a follow-up.
- (7) Full-refund pause: not built here (operator piece stacked on #705).

**Probe replay (both lenses):** CI lane [37344998517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344998517) at this head: 137 passed, 1 failed (superseded, see below).

| Probe (lens) | Result |
|---|---|
| Opus 116 688 lost-dispute (pause adaptation) | pass |
| Opus 118 688 parts 1-4 (pause adaptation) | pass |
| Sol 116 d2 (pause adaptation) | pass |
| Sol 118 688-probe, 688-probe-v2 | pass |
| D1 probes (Opus 118 687, Sol 116 d1, Sol 118 687 adapted) | pass |
| Opus R34D-119 C-680-18 (7) + 13 controls; lock variant + control | pass |
| Opus R34D-119 C-680-19 with the pause (marker, flag on) | pass |
| Opus R34D-119 C-680-19 original | superseded: it writes `paid` by hand as the old won branch did. That branch now keeps `disputed`, and the real-handler case passes (`test/dunning-v2-c680-18.spec.ts`). |
| `test/dunning-v2-dispute-pause.spec.ts` (32), `test/dunning-v2-c680-18.spec.ts` (34) | pass |

**Money self-check**
- Webhook order/redelivery: after a pause, invoice.paid and sub.updated never grant access. The guard is read under the purchase lock, and the clear refuses. A closure processed first pauses. A won dispute keeps the plan revoked. A redelivered dispute re-asserts the Stripe pause.
- Concurrency/lock order: no DunningState lock on the webhook tx before v1, and the clear runs on the webhook tx. A race between a pause and a clear ends paused. Webhook (ClientPurchase, then DunningState in the clear) against pause (DunningState, then ClientPurchase): Postgres detects it and the loser is redelivered (C-688-9, carried).
- Terminal states (refunded/disputed/canceled/deleted): disputed stays revoked when won; refunded and chargeback_lost are refused by C-680-18; canceled plans are not paused; a deleted account is a no-op.
- Pagination fail-closed: an incomplete open-invoice list throws (redelivered, no notice), as tested.
- Currency/minor units/zero-decimal: no amounts change.
- Copy truth: no copy change; notices go out only after the Stripe pause.

**Follow-ups (C):** see ops/reports/B-DUNMR-120.md. They include the pause read being flag-gated (a flag rollback re-entitles paused plans) and `test/dunning-v2-dispute-pause.spec.ts:342` `.catch(() => undefined)`, which adds +1 R75 empty-catch, present since this PR opened. That check runs only when the base is main, so it will fail when #705 is retargeted to main.

**Required checks at this head:** all green (11 checks; deploy-readiness-gate is skipped by design).

READY FOR AUDIT
