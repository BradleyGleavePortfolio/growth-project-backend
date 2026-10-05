# B-RECUR7B-119 — recurring R3 #680 fix round 7 (+ tests #696, restack #701)

Status: BLOCKED AT PUSH (13:24 PDT). Fix, tests, restack and lane proofs are done locally; the push of the three PR branches was
refused by the platform action-safety check (it did not see the gate line, which IS present: "R2 top: #679 @ 23d2c04c...; #701 tests @
5e8f1ceb... (B-RECUR7A-119, 13:14:45 PDT)"). Not retried, per the refusal. Lock recurring-r34 released 13:32. Started 2026-10-04 12:46 PDT. Lock lanes119/locks/recurring-r34 taken 12:47.
Push gate: wait for B-RECUR7A-119 R2 line in lanes119/notify/recurring.txt (absent at 12:55).

## Heads at start
- #680 216489ff5fa707147b50ef0e387aba5b3079e4b1 (base #679 8bbf4a41), #696 276610a3, #701 72eb096b.

## Findings to close
- Sol RC 5983671709: B-680-1 terminal authority residual; B-680-2 paid write entering past_due; C-680-7 follow-up.
- Opus APPROVE 0/0/6 (5983750522). Operator 12:50: C-680-12 hard obligation (pause_collection update on refund/dispute-revoked
  plan must not re-grant); C-680-11 fix if same path as B-680-2 (it is: same locked write in applyInvoicePaymentFailed);
  C-680-7/13/14/15 follow-ups.

## Work (local, worktree wt/B-RECUR7B-119-1, branch wip/B-RECUR7B-119-680, uncommitted until push gate)
- src/checkout/checkout-webhook-handler.service.ts:
  - REVOKED_STATUSES = canceled, expired, incomplete_expired, refunded, chargeback_lost, disputed; purchaseHasEnded = status in set
    AND !entitlement_active (B-680-1, C-680-12).
  - applyInvoicePaid: `if (purchaseHasEnded(fresh)) return fresh;` unconditional under the lock (money still settles).
  - applyInvoicePaymentFailed: enteredPastDue exemption removed; any write after the decline read redelivers (B-680-2).
  - same locked write: `status: fresh.status === 'unpaid' ? 'unpaid' : 'past_due'` (C-680-11).
- test/b-recur5b-117-authority.spec.ts (in #680): paired-update control now expects one redelivery then dunning once.
- test/b-recur7b-119-authority.spec.ts (goes to #696): new regressions.
- Failing-before worktree wt/B-RECUR7B-119-2 @ 85f539ac (216489ff + tests only), not pushed yet.

## Follow-ups (C)
- C-680-7 src/checkout/checkout-webhook-handler.service.ts attachNativeTrialCard secret-prefix lookup unindexed: additive migration
  (> 20270316000000) with an indexed SetupIntent id.
- C-680-13 attachNativeTrialCard (~L820 `if (row.entitlement_active || row.trial_started_at || !paymentMethod)`): also return
  without attaching when purchaseHasEnded(row).
- C-680-14 trialOwnCardOn duplicates subscription-plan.ts ownTrialCardOn: one exported helper.
- C-680-15 decline `invoice_superseded` (~L1905): superseded only when the declined invoice is no longer collectible or the newer one
  is paid.

## Local commits (not pushed)
- #680 wt-1 (wip/B-RECUR7B-119-680): bef96175 merge #679 @ 23d2c04c (clean, merge-only), f267417a fix (+34/-21 incl. 5b control).
  Size vs #679 @ 23d2c04c: +2,685/-94 = 2,779.
- #696 wt-3 (wip/B-RECUR7B-119-696): 7392761f merge f267417a (clean), 13c9a6c8 new test file (287 lines). Size vs #680: +2,197.
- #701 wt-4 (wip/B-RECUR7B-119-701): d624144c merge 13c9a6c8 into #701 @ 5e8f1ceb (B-RECUR7A tests kept), clean.
- Local targeted jest on composed top d624144c: 30 suites / 418 tests pass. Failing-before local (wt-2 85f539ac): 24 fail / 20 pass.
- Probe replay (wt-5, d624144c + all prior probes, local non-PG): 7 fail / 131 pass, all by design/known:
  sol-r3-116 unshimmed x2 (legacy fixture; shim passes), opus-r34-117 observation (paid invoice re-grants canceled row: now kept
  revoked, B-680-1), sol-r34r5-117 B-680-5 exact call shape (known), opus-r34-119 paired-update no-redelivery control (B-680-2
  rule change: one redelivery), opus C-680-13 (follow-up), sol-r34-117 concurrency B-680-2 narrowed (handle now throws redeliver
  instead of resolving; no dunning, row unchanged).

## Log
- 12:46 rules read; lock taken. 12:50 operator message received. 12:55 fix + tests written locally.

- 13:14 gate line present. 13:23 lanes: failing-before https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231939325
  (24 fail / 20 pass); after + all prior probes on d624144c https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231956053
  (303 pass / 8 fail, all by design or known, see fr7-680-draft.md). 13:24 push refused. 13:32 ci/* branches deleted, wt-2/wt-5 removed,
  lock released.

## Operator decisions (recommended default)
1. Push authorization: push f267417a -> agent115/recur-split-3-webhooks-fixes (#680, fast-forward from 216489ff), 13c9a6c8 ->
   agent117/recur-split-4-service-specs (#696, ff from 276610a3), d624144c -> agent117/recur-split-5-round4-specs (#701, ff from
   5e8f1ceb). Default: authorize a fresh B-RECUR7C (or this job) to push exactly these, wait for green, post FIX ROUND 7 (draft
   ops/aud-119/B-RECUR7B-119/fr7-680-draft.md) + READY on #680/#696, READY (restack) on #701, and append notify line
   "R5 top: #701 @ d624144c<full> (...)".
2. B-680-2: the operator's accepted "narrower past_due exemption" default conflicts with Sol's open B; closing the B removes it, so
   the paired past_due update now costs one Stripe redelivery before dunning opens. Default: accept (fail closed).
3. Full refund on a recurring plan (outside this diff, refund-dispute-handler.service.ts:301): revokes the whole plan but leaves the
   Stripe subscription billing; now nothing restores access, so the client could keep paying with no access. Default: the fees/money
   stack pauses billing on a full recurring refund exactly as R-DISPUTE-PAUSE does (ticket).
4. Dispute pause composition (D2c): this tree's dispute.created marks status disputed but keeps access; the fence covers disputed
   only without access. Default: D2c writes disputed + entitlement_active=false in one tx BEFORE pausing collection.

## Follow-ups (C) additions
- C-680-16 refund-dispute-handler.service.ts:301-302 full refund on a recurring plan: pause billing (see decision 3).
- C-680-17 refund-dispute-handler.service.ts:1043/1092 disputed on a recurring plan keeps entitlement: R-DISPUTE-PAUSE build sets
  entitlement false in the same tx.

## HANDOFF
- #680: PR head still 216489ff (nothing pushed). Ready local: wt/B-RECUR7B-119-1, branch wip/B-RECUR7B-119-680 @ f267417a
  (bef96175 merge-only first, then fix). Size vs #679 @ 23d2c04c: 2,779.
- #696: PR head still 276610a3. Ready local: wt/B-RECUR7B-119-3, wip/B-RECUR7B-119-696 @ 13c9a6c8 (merge 7392761f + new spec).
  Size vs #680: 2,197.
- #701: PR head still 5e8f1ceb. Ready local: wt/B-RECUR7B-119-4, wip/B-RECUR7B-119-701 @ d624144c (merge-only, B-RECUR7A tests kept).
- Backup bundle: ops/aud-119/B-RECUR7B-119/r7-commits.bundle; lane logs and test copy in the same dir.
- Next: decision 1, then green checks, comments, notify line, remove wt-1/3/4 and the wip branches.
