# AUD-OPUS-D6-120 — Opus lens, exact-head review of backend dunning #687 #688 #704 #705

Lens: Claude Opus 5.5, T4 audit, agent 120. Job entry: "AUD-OPUS-D6-120 / AUD-SOL-D6-120" in ops/lanes120/JOBS120.md.
Started 10:3x PDT 10-05 (times from `TZ=America/Los_Angeles date`). Sol D6-120 report and comments not read before posting.

## Heads (verified 10:35 PDT, re-read before posting)

| PR | Piece | Head | Verdict | A/B/C |
|---|---|---|---|---|
| #687 | D1 foundation | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | REQUEST CHANGES | 0/1/2 |
| #688 | D2a service | 21714f7bba299336cf71df0c87288c798fd5da13 | APPROVE | 0/0/2 |
| #704 | D2b v1 marker + fixtures | 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 | APPROVE | 0/0/1 |
| #705 | D2c dispute pause | 5138947cd082328b81cbeb787833914431b22fc1 | REQUEST CHANGES | 0/4/2 |

Comment URLs: see "## Posted" below.

## Prior Opus findings decided

- #687 (RC 0/1/3 @ f8e47bf4, comment 5982478903): B-687-5 closed (dispute template hides the card button and End my plan line, dunning-v2-client.hbs:5-13; dispute copy dunning-v2.copy.ts:179-207; every lr_* key renders dispute copy, dunning-v2.renderer.ts:198,214). C-687-6, C-687-7, C-688-10 closed. C-687-4 carried as note.
- #688 (RC 0/2/3 @ b17f514c, comment 5982479051): B-688-6 closed (step-fenced lock CAS; replay of AUD-OPUS-D12-118 #688 probe passes). B-688-7 closed (attempts from last_attempt_number; applyTokensTruthfully drops sentences with missing tokens). C-688-8 closed (isDisputeCycleOpen gate). C-688-10 closed. C-688-9 (lock order) carried.
- #704, #705: no prior Opus verdict; full review.

## CI lanes (audit branches, all deleted at the end)

| Run | Head under test | Specs | Result |
|---|---|---|---|
| 37351709272 | #687 f3c7fd37 + probe commit | aud-opus-d12-118-687 | 3/3 pass |
| 37351730932 | #688 21714f7b + probe commit | aud-opus-d12-118-688, aud-opus-d12-688-lost-dispute (116), aud-opus-r34d-119, dunning-v2-c680-18 | 68/69; the one red is R34D C-680-19 (won writes paid), fixed upstream in #705 (refund-dispute-handler.service.ts:1005-1017) |
| 37351686431 | #705 5138947c + probe commit | aud-opus-d6-120-705 (new), zz-opus116-688-probe-pause, aud-opus-r34d-119-probe-dunmr, dunning-v2-dispute-pause, dunning-v2-c680-18 | 99/106; 6 intended reds in the new probe (B-705-1 x3, B-705-2, B-705-3, B-705-4), 3 controls green; 1 red in the R34D adaptation (C-680-19 case force-writes the pre-fix `paid` status, so it no longer models the handler; the real handler is covered green by dunning-v2-c680-18.spec.ts:318-363) |

Probe source: ops/aud-120/AUD-OPUS-D6-120/aud-opus-d6-120-705.probe.spec.ts. Logs: ops/aud-120/AUD-OPUS-D6-120/run_*.log.
PR checks at all four heads: green (build-and-test, schema parity, RLS floor, rls-live, npm audit; #687 also CodeQL, banned casts, forward and reversible migrations).

## Findings

### #687
- B-687-8 dunning-v2.copy.ts:184,188-189,196,200,203,206; dunning-v2.dispatcher.ts:406. Dispute-cycle copy says a payment "was reversed". Owner ruling 6 pauses on inquiries too (test/dunning-v2-dispute-pause.spec.ts:269 on #705). Stripe: inquiries "don't have any financial impact" (https://docs.stripe.com/disputes/withdrawing). Fix rule: no reversal claim; say the bank opened a dispute or inquiry about a recent payment.

### #688
- No new A/B. FR5 C-680-18 guard verified: DUNNING_V2_ENDED_STATUSES equals REVOKED_STATUSES; lockedPurchaseForClear takes DunningState FOR UPDATE then ClientPurchase FOR NO KEY UPDATE and refuses an ended plan before any write.

- C-688-12 (also on #704): at these heads main's invoice.paid calls applyImmediateClear without tx (checkout-webhook-handler.service.ts:1845), so the guard's ClientPurchase lock waits on the webhook's own purchase lock (flag on: stall to the tx timeout, redelivery). Fixed in #705 (passes tx, :1853, B-S2). Fix rule: #688/#704 do not land without #705 (rule 11, split stacks land as one).

### #704
- Head is a clean merge: tree 22eaee66 equals `git merge-tree --write-tree 32d886bb 21714f7b`. Own diff: dunning.service.ts move and v2 skip, env-validation BILLING_PORTAL_URL text, fixtures with synthetic ids and livemode false, B-D12-116 fix spec. Nothing found.

### #705
- B-705-1 dunning-v2.service.ts:1430-1434 with 1320-1329. The re-pause after a resumed-but-not-restarted exit reuses the first pause's idempotency key; Stripe replays it within 24 h, so a new dispute during the restart leaves billing resumed with access ended. A thrown restart transaction after the resume never re-pauses. A losing concurrent restart (more than 24 h after the pause) pauses a plan the winner restarted. Probe: 3 reds, 2 controls green (run 37351686431).
- B-705-2 dunning-v2.service.ts:1348-1447 with subscription-checkout.service.ts:507-525. A paused plan is not live to checkout, so the client can buy the package again; a later coach restart resumes the old subscription too: two billing subscriptions. Probe red.
- B-705-3 dunning-v2.service.ts:1235-1238 with refund-dispute-handler.service.ts:974-1001. After a coach restart, the same dispute closing lost ends access (main lost branch) while D2c keeps billing resumed (`dispute_already_applied`); renewals are charged with no access. Probe red. Operator decision, default below.
- B-705-4 dunning-v2.service.ts:1128-1145 (isDisputeCycleOpen / isDisputePaused gated by `this.enabled()`). Operator ruling 10:1x requires the pause read whatever FEATURE_DUNNING_V2 says. Probe red: closure-first pause, flag off, customer.subscription.updated(active) re-entitles.

## Follow-ups (C)
- C-687-4 (carried note) prisma/migrations/20270215000000_dunning_billing_actions applies after the applied 20270311000000 (OR-113-4).
- C-687-9 dunning-v2.copy.ts:184,189,196 with dunning-v2.service.ts:1657: fallback 'your coach' starts a sentence in lower case. Fix rule: capitalise a sentence-initial fallback.
- C-688-9 (carried) lock order: the webhook tx holds ClientPurchase then takes DunningState (applyImmediateClear via lockedPurchaseForClear), the pause and the Day-10 lock take DunningState then ClientPurchase. Also v1 recordResolution runs on a second connection while the webhook tx holds the purchase lock, a wait Postgres cannot see; it ends at the interactive tx timeout. Fix rule: one documented order, or take DunningState first in the webhook tx.
- C-705-5 dunning-v2.service.ts:1330-1336: invoices marked uncollectible at the pause stay uncollectible after a restart; the amount owed before the pause is never collected and the coach is not told. Fix rule: the restart tells the coach, or reopens collection by an explicit coach choice.
- C-705-6 dunning-v2.service.ts:1430-1434: no reconciler re-asserts the Stripe pause after a crash between resume and the restart transaction (builder carried item). Fix rule: the sweep re-pauses a paused plan whose Stripe subscription has no pause_collection.
- Builder-carried Cs reused as stated in B-DUNMR-120: C-DUNMR-2 (no dispute id until D4), C-DUNMR-3, C-DUNMR-4 (failed-refund coach alert, decision 5), C-DUNMR-5 (D3 signatures).

## Decisions for the operator (recommended default first)
1. B-705-3: default, a lost closure never changes access of a recurring plan the coach restarted after the dispute (money reversal and the OR-111-1 payout notice still run). Alternative: a lost closure re-applies the pause and billing pauses with it.
2. B-705-2: default, re-buying is allowed and restart refuses with a coded reason when the client already holds another live plan for the same package. Alternative: checkout refuses a re-buy while a dispute pause holds the package.
3. Size: #705 is 1,409 of 1,500. If the four B fixes do not fit, default is a D2d piece for the restart (B-705-1/2/3) with B-705-4 kept in D2c.

## Evidence reused (G09)
- Own prior probes (D12-116, D12-118, R34D-119) replayed at the new heads rather than re-derived, because the code paths they cover did not change outside the fix rounds.
- Builder lanes (B-DUNMR-120: 37344902060, 37344925094, 37344949765, 37344998517) read for context only; every verdict claim rests on this lens's lanes or source lines.
- Builder-adapted D12-116 pause probe: Stripe pause stubbed and four expectations rewritten to R-DISPUTE-PAUSE outcomes (paused, pause_kept x2, cycle open); each matches the owner ruling, accepted as a faithful replay.
- Sol D6-120 output not read before posting.

## Posted (11:04 PDT 10-05; heads re-read before and after posting, unchanged)
- #687 REQUEST CHANGES 0/1/2: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-6000205361
- #688 APPROVE 0/0/2: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-6000205609
- #704 APPROVE 0/0/1: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-6000205846
- #705 REQUEST CHANGES 0/4/2: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-6000206086
Verdict bodies: ops/aud-120/AUD-OPUS-D6-120/verdict_{687,688,704,705}.md.

## HANDOFF
- State: DONE. Four verdicts posted at the exact heads above. No merge, deploy, settings or production action taken.
- Cleanup: remote branches audit/AUD-OPUS-D6-120/{687-replay-1,688-replay-1,705-probes-1} deleted; worktrees wt/AUD-OPUS-D6-120-{1,2,3} removed and pruned. Claims left in ops/lanes120/claims for the record.
- Next (B-DUNB builder): fix B-687-8 (#687 copy) and B-705-1..4 (#705), plus the Sol D6-120 A/B, then re-request both lenses at the new heads. Re-run test/aud-opus-d6-120-705.probe.spec.ts (copy in ops/aud-120/AUD-OPUS-D6-120/); every red case must turn green, controls stay green.
- Operator decisions (recommended default first): (1) B-705-3: a lost closure leaves a coach-restarted recurring plan's access as the coach set it; alt: the closure re-pauses. (2) B-705-2: re-buy allowed, restart refuses when another live plan exists for the package; alt: checkout blocks re-buy while paused. (3) Size: if the fixes push #705 over 1,500, the restart fixes go to a D2d piece and B-705-4 stays in D2c.
- Rule 11: #688 and #704 approvals depend on #705 landing with them (C-688-12).
