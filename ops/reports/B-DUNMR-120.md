# B-DUNMR-120 report (builder, Claude Opus 5.5, T4) — agent 120

Job: backend dunning D1 #687, D2a #688, D2b #704, D2c #705 — verify D1 main refresh f3c7fd37, restack #705 onto #704,
C-680-18 guard (hard obligation), C-680-19 (won dispute restore), probes, one comment per PR, READY FOR AUDIT.

Started 09:28 PDT 10-05. Lock `dunning` taken 09:28 PDT (ops/lanes120/locks/dunning).

## Starting heads (GitHub REST 09:30 PDT)
| Piece | PR | Head | Base | State |
|---|---|---|---|---|
| D1 | #687 | f3c7fd37777ef1cde75ec5fb984edf5cb973f864 | main | clean, +2424/-216 |
| D2a | #688 | 5003e7e6abe87680484658c7f2c7433ab5fef357 | agent115/dunning-split-1-foundation | clean, +1905/-535 |
| D2b | #704 | 32d886bb2f7cb71384b83e5f07adc5c8a7d7fb3b | agent115/dunning-split-2-dunning-service | clean, +615/-79 |
| D2c | #705 | 279ec1677d574b86e773248174eef57c1d2a237d | agent119/dunning-split-2b-v1-marker-fixtures | DIRTY, +907/-380 |

## Log
- 09:28 rules read (_COMMON_120/119/118/116, AGENT_RULES), entry read, lock taken.

- 09:35 step 1 verified: f3c7fd37 (B-DUNR-119) remerge-diff read; both sides kept for D1-D2c (details below). CI green at f3c7fd37.
  #688 5003e7e6 and #704 32d886bb trees equal a fresh `git merge-tree` of their parents (merge-only, clean).
- 09:44 operator mail (owner 09:43 rulings 5/6/7): inquiries pause (verify on #705), failed refund after access ended = coach alert
  only (confirm), full-refund pause NOT in this round. Plan unchanged.
- 09:50 #688: ff3a13a5 (C-680-18 regression, failing before) + 21714f7b (guard) pushed. Lane failing-before run 37343244840.

## Step 1 — f3c7fd37 conflict resolution (D1 main refresh)
- stripe-connect-api.service.ts: main's StripeSubscriptionCheckoutObject/StripeSetupIntentObject/Balance/Charge types,
  on_behalf_of checkout form (S-FEE), listChargeRefunds kept; D1's StripeInvoiceObject, declineCode/idempotentReplayed on
  StripeConnectApiError, setCustomerDefaultPaymentMethod, listOpenInvoices (fail-closed), payInvoice, setCancelAtPeriodEnd kept;
  retrieveInvoice = main's position + D1's payment_intent expand (main's only caller, prefetchFailedInvoice, reads `status` only).
  Duplicates resolved to main: createSetupIntent (requires onBehalfOf + metadata), retrieveSetupIntent,
  setSubscriptionDefaultPaymentMethod (+liftTrialEnd), voidInvoice(invoiceId, key) positional. No caller in D1-D2c (git grep).
- email.types/email.service: COACH_PAYOUT_ADJUSTMENT kept, DUNNING_V2_CLIENT/COACH appended. .env.example, prod-switches,
  privacy list, schema auto-merged; Schema parity + build-and-test green.
- FOR THE D3 RESTACK (#689, not mine): D3 client-billing.service.ts:377 createSetupIntent({customer, metadata, key}) lacks
  onBehalfOf (main requires it; D1's copy deliberately had no on_behalf_of so the card serves every plan) and :1603
  voidInvoice({invoiceId, idempotencyKey}) is the object form; both fail to compile on the refreshed D1. Fix in D3.

## Progress (cont.)
- 09:52 #688 failing-before lane 37343244840 at ff3a13a5: 12 failed / 17 passed (all guard cases red; controls + parity green).
- 09:53 #704 merge-only 49d0b66e (tree == git merge-tree of 32d886bb + 21714f7b), pushed.
- 09:58 #705: merge ea8fab86 (conflicts handler x2 + dunning-v2 x1), tests 8195dc68 (failing-before lane 37344610390: 4 failed /
  62 passed, exactly the new regressions), fixes 5138947c, pushed 10:00. Sizes: #688 2,784; #704 694; #705 1,409.
- Probe replay lanes: #687 37344902060, #688 37344925094, #704 37344949765, #705 37344998517 (adapted R34D probe saved at
  ops/reports/B-DUNMR-120-evidence/probes/aud-opus-r34d-119-probe-dunmr.spec.ts with the B-DUNSPLIT-119 adapted probes).

## Findings and fixes
| id | sev | PR | finding | fix | commit |
|---|---|---|---|---|---|
| C-680-18 | A (hard obligation) | #688 | applyImmediateClear wrote entitlement true + lifted a Day-10 lock on refunded / chargeback_lost / disputed / canceled / expired plans without access (flag on) | under DunningState then ClientPurchase (NO KEY UPDATE) locks, refuse when `dunningPurchaseEnded` (same set as purchaseHasEnded, parity spec) | ff3a13a5 + 21714f7b |
| B-S1 | B | #705 | D2c disputePaused took DunningState FOR UPDATE on the webhook tx before v1 recordResolution updates that row on its own connection: invoice.paid stalls to the 5 s tx timeout and fails (flag off too, any plan with a DunningState row) | read the marker under the purchase lock only | 5138947c |
| B-S2 | B | #705 | main's invoice.paid called applyImmediateClear without tx; with the guard's ClientPurchase lock (and D2a's write) it waits on the outer tx's purchase lock | pass tx | 5138947c |
| B-S3 | B | #705 | applyImmediateClear decided the dispute pause on a pre-lock read; a pause committed while the clear waits on the locks was undone (card-update path) | re-read isDisputeCycleOpen under the locks | 5138947c |
| C-680-19 | B (R-DISPUTE-PAUSE) | #705 | dispute won wrote `paid` on a paused recurring plan; `paid` without access is not ended, so a later sub.updated re-grants (flag off/rollback) | won on recurring + no access keeps `disputed` (revoked); one-time and recurring-with-access unchanged | 5138947c |

Owner 09:43 rulings: (6) inquiries: the service pauses on any dispute id (handleLateReversal has no status filter; a warning_closed
closure pauses closure-first); test added. As for full disputes, the webhook passes the dispute id only from D4 #690
(fireLateReversalProbe has none today: reason no_dispute_id), so no B on #705. (5) failed refund after access ended: main's
flagFailedAfterApply (refund-dispute-handler.service.ts:697-712) writes no ClientPurchase field (no access change, no client retry);
the alert today is an ops log `SFEE_REFUND_FAILED_AFTER_APPLY alert=true` + settlement review flag, not a coach notice -> follow-up for
the fees owner (coach COACH_ALERT). (7) full-refund pause not built (operator piece on #705).

## Comments (10:09 PDT)
- #687 MAIN REFRESH @ f3c7fd37: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5999323963
- #688 FIX ROUND 5 @ 21714f7b: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5999324310
- #704 RESTACK @ 49d0b66e: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/704#issuecomment-5999324570
- #705 RESTACK + FIX ROUND 1 @ 5138947c: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5999324895
- PR bodies: tier header + fix-round rows updated (before/after copies in ops/reports/B-DUNMR-120-evidence/).

## CI
- Required checks all green at f3c7fd37 (18), 21714f7b (11), 49d0b66e (11), 5138947c (11); deploy-readiness-gate skipped by design.
- build-and-test: 687 37244818222, 688 37343332177, 704 37343434559, 705 37345119642.
- Probe lanes: 687 37344902060 (10/10); 688 37344925094 (70 pass, 2 expected red C-680-19 pre-D2c); 704 37344949765 (same);
  705 37344998517 (137 pass, 1 superseded: R34D C-680-19 original writes `paid` by hand; real handler now keeps `disputed`).
- R75 range: #688 5003e7e6..21714f7b OK; #705 own range 279ec167..5138947c OK (net -1); #705 vs #704 +1 empty-catch from
  test/dunning-v2-dispute-pause.spec.ts:342 (pre-existing since 0198d09b, see C below).

## Follow-ups (C)
- C-DUNMR-1 dunning-v2.service.ts:1128-1136 (isDisputeCycleOpen) and the clear refusal are flag-gated: a FEATURE_DUNNING_V2
  rollback after pauses lets the next sub.updated / invoice.paid re-entitle a paused plan. Rule: read the marker whatever the flag
  (only the writes are gated).
- C-688-9 (carried, extended): webhook path locks ClientPurchase then DunningState (applyImmediateClear on the webhook tx,
  dunning-v2.service.ts:1056-1057) while applyDisputePause / restart lock DunningState then ClientPurchase (:1220-1221, :1396).
  Postgres detects the cycle and one delivery retries. Rule: one order (take DunningState first in invoice.paid before
  lockPurchase, once v1 recordResolution moves onto the tx).
- C-DUNMR-2 checkout-webhook-handler.service.ts fireLateReversalProbe (~L537-563): fire-and-forget, no dispute id, so no pause
  through the webhook until D4 runDisputeEffect passes the id and awaits (a Stripe pause failure must redeliver). Handoff to D4.
- C-DUNMR-3 test/dunning-v2-dispute-pause.spec.ts:342 `chain = next.catch(() => undefined)`: +1 R75 empty-catch-undefined vs
  #704; "Banned cast tokens" runs only for base main, so it fails when #705 is retargeted. Rule: settle with
  `next.then(() => 'settled', () => 'settled')` (as test/support/b-recur-fakes.ts does).
- C-DUNMR-4 refund-dispute-handler.service.ts:697-712 flagFailedAfterApply: owner decision 5 wants a coach alert; today ops log
  + settlement review flag only, no coach notice. Rule: COACH_ALERT to the plan's coach once per refund id (fees owner).
- C-DUNMR-5 (for D3 #689 restack, B-DUNB): client-billing.service.ts:377 createSetupIntent lacks onBehalfOf; :1603 voidInvoice
  object form; test/support/fake-stripe-billing.ts object-form voidInvoice. Adapt to main's signatures.
- Carried from B-DUNSPLIT-119: reconciler to re-assert the Stripe pause (pauseBillingAtStripe); LR_LOCKOUT_SCREEN copy; dispute
  blocker deep link tgp://billing/update -> plan screen; B-DUNA-118 copy/log items; D4 handoff list (closedAt, dispute id,
  restart endpoint, D5 compressed-cycle specs).

## Decisions for the operator (recommended default first)
1. D3 #689 restack adapts to main's Stripe signatures (createSetupIntent onBehalfOf + metadata, voidInvoice positional). Default: yes, in B-DUNB.
2. Marker read independent of FEATURE_DUNNING_V2 (C-DUNMR-1) in the next dunning round. Default: yes, before the flag flips.
3. Fees owner adds the coach alert for a refund that fails after access ended (decision 5, C-DUNMR-4). Default: yes, next fees round.
4. D2c also writes status `disputed` in its pause tx (B-RECUR7B decision 4). Default: not needed (marker guard + main's dispute.created write + C-680-19).
5. Carried: inquiries pause (now owner-confirmed, decision 6); a locked cycle keeps its lock instant: yes; restart endpoint in D4: yes.

## HANDOFF
- DONE 10:12 PDT. Heads: #687 f3c7fd37777ef1cde75ec5fb984edf5cb973f864 (MAIN REFRESH, no code change), #688
  21714f7bba299336cf71df0c87288c798fd5da13 (FIX ROUND 5), #704 49d0b66e8a0a1cab02f0a5a03d48cad276a08e20 (RESTACK),
  #705 5138947cd082328b81cbeb787833914431b22fc1 (RESTACK + FIX ROUND 1). All READY FOR AUDIT; required checks green.
- Counts this round: A 1 (C-680-18), B 4 (B-DUNMR-1..3, C-680-19), C 6 new (above) + carried.
- Next: Opus 5.5 + Sol lens pair on #687/#688/#704/#705 at these heads (first lens review of D1-D2c). Then B-DUNB restacks
  #689 onto #705 5138947c (adapt C-DUNMR-5). Operator piece for decision 7 (full-refund pause) stacks on #705.
- Cleanup done: worktrees wt/B-DUNMR-120-1..4 removed, local wk/ branches deleted, ci/B-DUNMR-120-1..6 deleted, lock
  ops/lanes120/locks/dunning removed, ops/lanes120/notify/dunning.txt written.
- Evidence: ops/reports/B-DUNMR-120-evidence/ (comments, PR bodies before/after, probes incl. adapted R34D probe).
