FIX ROUND 3 (B-DUNA-118, agent 118) — growth-project-backend#688 @ 2368d5fa1b5671123e2f6b330137b3ebb90be514

Tier T4 (money path). This round closes:
- Sol B-688-6 and B-688-7 ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982357473)).
- Opus B-688-6 and B-688-7 ([Opus verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5982479051)).
- Three D2 findings that the D3/D4 Opus lens confirmed with probes ([#689 verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5982575687), W3/W4). The operator ruled them Bs for this round.
- Same-line Cs: C-688-8 (same lines as Sol B-688-6) and C-688-10 (closed in D1, FIX ROUND 2 on #687).

D1 `38d9b3ab` (which includes main `2af682ca`) is merged in, merge-only (`49c50f6e`, `f8a1a705`).

Commits:
- `b7d832d6`: tests only (fail before the fix).
- `4879e81a`: the fix.
- `f1ba91fd`: keeps the C-628-12 guarantee sentence that D5's r3 spec reads.
- `f8a1a705`: merge of D1.
- `2368d5fa`: test helper type (Type-check).

Failing-before run: [CI lane 37222199475](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222199475). All 6 new cases failed; the 12 existing cases passed.

| Finding | Change | Commit | Test (fails before, passes after) |
|---|---|---|---|
| Opus B-688-6 (stale Day-10 worker locks a reopened cycle) | `dunning-v2.service.ts:890`: the tryLock CAS also fences `step_index: row.step_index`. A v1 reopen keeps entered_at and sets step -1, so a stale worker's write now matches nothing. | `4879e81a` | "Opus B-688-6: a v1 reopen (step -1, same entered_at) during the Stripe check is not locked" |
| Sol B-688-6, C-688-8 (an old lost-dispute replay poisons a later payment cycle) | `:1308`: the dispute-cycle marker is written only when `isDisputeCycleOpen(purchase, tx)`, read under the DunningState row lock, finds an obligation outstanding in THIS cycle. A replayed closure from an earlier cycle keeps its old `closed_at` and marks nothing. `:1232,:1249`: `onDisputeClosed` takes an optional `closedAt` (the event time) for a first closure. | `4879e81a` | "Sol B-688-6: replaying an earlier cycle's lost closure does not mark this cycle" |
| Sol B-688-7 (null-first DESC plus the cap hides a lock) | `:1487-1495`: getClientStatus filters eligibility in the query (recurring, `amount_cents > 0`, subscription id) and orders `locked_out_at: { sort: 'desc', nulls: 'last' }`. A lock can no longer fall behind ten unlocked rows. The in-memory filter stays. | `4879e81a` | "Sol B-688-7: a lock behind ten unlocked cycles is reported (DESC = nulls first)" (the D1 fake sorts like PostgreSQL) |
| Opus B-688-7, D2 part (unresolved tokens) | `:1582`: `attempts` comes from `last_attempt_number` (Stripe's `attempt_count`). With no value, D1's renderer leaves the sentence out, so no `{token}` renders. | `4879e81a` | "Operator B (amount) / Opus B-688-7: no renewal amount on a dispute; real attempts", plus D1's all-steps render test |
| Operator B1 / W3 (a won closure is acknowledged after one failed lookup, so the client stays locked) | `:1659-1663`: resolvePurchaseFromCharge rethrows every read error except a Stripe 404 (a clean miss). D4's runDisputeEffect turns the throw into a redelivery, not an acknowledgement. | `4879e81a` | "W3 (Opus D34): a failed purchase read on a won closure throws; a Stripe 404 is a miss" |
| Operator B2 / W4 (whether a dispute opens a cycle depends on webhook order) | `:1035-1070`: if the dispute obligation is open after the write (new or still open) and the state is resolved, it opens the compressed cycle, whatever the dispute's created time relative to `resolved_at`. Without a dispute id the old time rule applies. | `4879e81a` | "W4 (Opus D34): a dispute processed after the cycle resolved still opens a cycle" |
| Operator B3 (status and notice amount come from the last failed renewal, not the disputed charge) | `:1525`: status `amount_cents: null` for a dispute cycle. `:1580`: dispute-cycle notices get no `amount` token, and the D1 dispute copy carries none. The disputed charge's own amount is not stored in D2; showing it is a follow-up. | `4879e81a` | same test as the Opus B-688-7 row (status amount null, notice `amount` undefined) |

Probe replays at this head ([CI lane 37223188413](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37223188413): 12 suites, 150 passed):
- Opus 116 `aud-opus-d12-688-lost-dispute`: pass.
- Sol 116 `aud-sol-d12-116-d2`: pass.
- Sol 118 `688-probe` and `688-probe-v2` (historical lost replay gives {disputed: false, lifted: true, lock: null, entitled: true}; ten unlocked plus one locked reports the lock under PostgreSQL order): pass.
- Opus 118 `aud-opus-d12-118-688`, parts 1-4 (stale worker, tokens): pass.
- The D1 probes (Sol 118 687, Opus 118 687, Sol 116 d1): pass.
- Earlier heads: `4879e81a` [37222486072](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222486072), `f1ba91fd` [37222718246](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222718246), `f8a1a705` [37222827176](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222827176), all pass.

D3/D4 probes:
- Opus D34 `audit-opus-d34-118-690`, W0-W4, ran on D4 `06307883` merged with D2 `4879e81a`. This was a throwaway compose (the public-pages conflict was taken from D4) and is not pushed to any PR: [37222543599](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222543599). W0, W1, W2, W3 and W4 pass. Every later D2 commit changes comments or tests only.
- D5 `e0afe678` merged with this D2 (local): 13 dunning suites, 287 tests. The only failure was the C-628-12 sentence that D5's r3 spec reads; `f1ba91fd` restores it, and the r3 suite then passes 70/70.

Money self-check:
- Webhook order and redelivery: the dispute cycle is the same whichever of `charge.dispute.created` and `invoice.paid` is processed first (W0 and W4). A failed purchase read throws, so the event is redelivered, never acknowledged (W3). A replayed earlier closure has no effect on the current cycle.
- Concurrency (two workers, lock order): the tryLock CAS fences status, lock, cancel, entered_at and step_index. The dispute marker is decided under the DunningState row lock from a fresh read. Lock order between tryLock and invoice.paid is unchanged: C-688-9 below.
- Terminal states (refunded, disputed, canceled, deleted account): a dispute lost before this cycle is not this cycle's. A won closure with a transient read failure is redelivered. A cancel never resolves a dispute; this is unchanged, and the D1 copy no longer offers it in dispute cycles.
- List pagination and completeness (fail closed): eligibility is filtered in the database and locks sort first (NULLS LAST), so `take: 10` cannot hide a lock.
- Currency (presentment vs settlement, minor units): a dispute cycle shows no amount, because the renewal amount is not the disputed charge's. Payment amounts are unchanged (formatMinor, the purchase currency).
- Copy truth (no claim before proof): no notice states an amount or an attempt count it cannot prove.

Size: 2,363 additions + 613 deletions = 2,976 changed lines vs D1 (tests included). This is in the 1,500-3,000 band, with 24 lines of headroom. To fit, some D2 doc comments were condensed. `git diff 49c50f6e 2368d5fa` with comment lines removed shows only the changes in the table.

Checks at `2368d5fa`: build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests, npm audit and Schema parity all pass.

Open question (operator): a dispute on a purchase that never failed opens no cycle (`:1061`, `no_state`). No binding dunning ruling covers this, and OR-111-1 sets only the chargeback money handling, so behaviour is unchanged. After W4, the outcome depends on whether the purchase ever had a failed renewal. Recommended default: an owner ruling that a dispute on any cleared payment of an eligible paid subscription opens the compressed cycle, built later with its own tests.

Follow-ups (C), reported only (FREEZE):
- C-688-9: `dunning-v2.service.ts:877` (lockDunningState) then `:896` (ClientPurchase write) runs in the opposite order to invoice.paid. Fix rule: lock ClientPurchase first in tryLock.
- handleLateReversal does not store the disputed charge's amount. Fix rule: show the ChargeDispute amount when it is recorded, otherwise no amount.
- main `checkout-webhook-handler.service.ts:1176` stores the raw `last_payment_error.message` as the failure reason. No v2 copy uses it now. Fix rule: store a decline code.
- For D4 (B-DUNB-118): pass `closedAt: new Date(event.created * 1000)` to `onDisputeClosed`.

READY FOR AUDIT
