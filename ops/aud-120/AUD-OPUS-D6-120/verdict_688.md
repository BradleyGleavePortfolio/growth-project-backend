AUDIT Claude Opus 5.5 — growth-project-backend#688 @ 21714f7bba299336cf71df0c87288c798fd5da13 — VERDICT: APPROVE
A/B/C = 0/0/2

Agent 120, job AUD-OPUS-D6-120 (T4 audit lens). Exact-head review of D2a (dunning v2 service) at FIX ROUND 5, after the D1 main refresh (merge-only 5003e7e6) and the C-680-18 guard (ff3a13a5, 21714f7b). Size 2,784 (grandfathered; ceiling 3,000).

**Prior Opus findings (verdict 5982479051 @ b17f514c), decided first**
- B-688-6 (stale worker locks a reopened cycle): closed. The lock CAS carries `step_index: row.step_index` with `entered_at`, so a v1 reopen (step -1, same entered_at) during the Stripe check is not locked. Replay green (below).
- B-688-7 (unresolved tokens): closed. `attempts` comes from `last_attempt_number`; D1's `applyTokensTruthfully` drops a sentence whose token has no value; no renewal amount on a dispute cycle. Replay green.
- C-688-8: closed through the `isDisputeCycleOpen` gate.
- C-688-10: closed in D1.
- C-688-9 (lock order): carried (below).

**FR5 check (C-680-18)**
`git diff 5003e7e6 21714f7b -- src/checkout/dunning-v2/dunning-v2.service.ts`: `DUNNING_V2_ENDED_STATUSES` (dunning-v2.service.ts:284-291) equals main's `REVOKED_STATUSES` behind `purchaseHasEnded` (checkout-webhook-handler.service.ts:94-108); `lockedPurchaseForClear` (dunning-v2.service.ts:1048-1060) takes DunningState FOR UPDATE then ClientPurchase FOR NO KEY UPDATE, the mode the webhook already holds, and `applyImmediateClear` refuses an ended or revoked plan before any write, with a code-only log line. No new A or B.

## Follow-ups (C)
- **C-688-9** (carried) `dunning-v2.service.ts:1048-1060` on the webhook transaction: the webhook holds ClientPurchase and then takes DunningState, while the Day-10 lock (and the D2c pause) take DunningState then ClientPurchase. Postgres detects that cycle and aborts one side (redelivery). Also: v1 `recordResolution` runs on a second connection while the webhook transaction holds the purchase lock; a wait across the two connections is not visible to Postgres and ends only at the interactive transaction timeout. Fix rule: one documented order for both rows, or DunningState first in the webhook transaction.

- **C-688-12** (fixed upstream, stack dependency) `checkout-webhook-handler.service.ts:1845` (main's call site) with `dunning-v2.service.ts:1048-1060`: at this head `applyImmediateClear(updated.id, 'retry')` runs on a second connection, and the guard's ClientPurchase FOR NO KEY UPDATE waits on the purchase row the webhook transaction already holds; with the flag on, invoice.paid for any plan with a DunningState row stalls to the transaction timeout and is redelivered. #705 passes `tx` (`checkout-webhook-handler.service.ts:1853` @ 5138947c, B-S2). Fix rule: this piece does not land without #705 (MERGE_DEPENDENCY_GUIDE rule 11, split stacks land as one).

## Proof
- Replay of this lens's probes at this head, https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37351730932 (branch `audit/AUD-OPUS-D6-120/688-replay-1`, deleted after the run): AUD-OPUS-D12-118 #688 probe pass, AUD-OPUS-D12-116 lost-dispute probe pass, `dunning-v2-c680-18.spec.ts` pass, AUD-OPUS-R34D-119 probe 68/69. The one red is the R34D C-680-19 case (a won dispute writing `paid`): that fix is in #705 (`refund-dispute-handler.service.ts:1005-1017`), not in this piece, and is green there.
- PR checks at this head: all green (build-and-test, schema parity, RLS floor, rls-live, npm audit).

Evidence reused (G09): this lens's D12-116, D12-118 and R34D-119 probes replayed unchanged, since they assert the behaviours the fix rounds claim. Builder lanes (B-DUNMR-120) read for context only. The Sol D6-120 output was not read before this verdict.
