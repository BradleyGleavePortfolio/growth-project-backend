# B-RECUR6B-118 — recurring R3 #680 fix round 6 (+ restack #696, #701)

Status: DONE. READY FOR AUDIT posted on #680, #696 and #701 at exact heads, with all checks green. Lock `recur` removed 11:38 PDT. ci/B-RECUR6B-118-* branches deleted; worktrees removed.

## Heads
- #680 agent115/recur-split-3-webhooks-fixes @ 216489ff5fa707147b50ef0e387aba5b3079e4b1 (was 9621457e). Commits: faddf7ad (merge #679 @ 8bbf4a41, clean), d4a3a837 (tests only), 216489ff (fix). Size vs #679: +2,672/−94 = 2,766 (1,500–3,000 band, stated in the comment). All checks green (10 pass, 1 skipping deploy-readiness-gate).
  FIX ROUND 6 + READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5983144676 ; PR body tier header and Fix rounds row 6 updated.
- #696 agent117/recur-split-4-service-specs @ 276610a3a3cc7877b30a3a5f1214e24c7cbb7eae (was 5225e078). 150636a2 merge #680 @ 216489ff (clean); 0bbaba60 moved trial-card checkout cases (size move from #680); 276610a3 one assertion update (PAYMENT_RETRY since #679 round 6 sendFenced). +1,910 vs #680 (1,500–3,000 band). NOT merge-only.
- #701 agent117/recur-split-5-round4-specs @ 72eb096b8f20f6ab9d198bf4059250f99ffb53f8 (was 67905b43). Merge-only (merge of #696 @ 276610a3, clean). +416 vs #696.
- notify/recur.txt: "recur top: #701 @ 72eb096b8f20f6ab9d198bf4059250f99ffb53f8 (B-RECUR6B-118, 2026-10-04 11:38 PDT)".

## Open findings at 9621457e (both lenses) and closure (#680)
| Finding | Source | Change | Test |
|---|---|---|---|
| B-680-2 residual | dead Sol AUD-SOL-R34R5-117 probe (run 37187197172) | prefetchFailedInvoice also reads purchase status; the "already past_due" exception only for the write INTO past_due | b-recur6b-118-authority.spec.ts "B-680-2 residual" |
| B-680-5 case 1 (default with create-time end on granted trial) | same | `trialOwnCardOn` = default AND !cancel_at_period_end in subscriptionGrantsAccess | "B-680-5" |
| B-680-5 case 2 (own SetupIntent not attached when default already set; end never lifted) | same | attachNativeTrialCard attaches when !trialOwnCardOn (liftTrialEnd: true) | "B-680-5" |
| B-680-5 deletion path | same rule | deletion trial evidence uses trialOwnCardOn | "B-680-5" deletion cases |
| B-680-6 (FOR UPDATE self-blocks DunningService FK inserts on its own connection) | dead Sol PG probe | lockPurchase FOR NO KEY UPDATE | "B-680-6" lock-compat cases + real PG shim runs 37224869844 (after, pass) / 37224894835 (before, 55P03) |
| B-RECUR6A handoff: own trial SetupIntent by metadata | B-RECUR6A HANDOFF | metadata lookup first, then secret prefix | "B-679-10 handoff" |
| R1 liftTrialEnd signature | B-RECUR6A HANDOFF | trial-card spec expectation + fake | — |
| Sol RC 5977195657 B-680-1/2/3 | FR5 | re-verified in replay | — |

Evidence: failing-before lane run 37224558256 (7 fail = the 7 "(failed before)" cases / 11 pass). Probe replay run 37224665666 (185 pass / 5 fail, all fixture or exact-shape, explained in the comment). Probe copies + shims: ops/aud-118/B-RECUR6B-118/probes/. Moved file copy: ops/aud-118/B-RECUR6B-118/moved/. Comment drafts: ops/aud-118/B-RECUR6B-118/fr6-680.md, fr6-696.md, fr1-701.md.

## Report-only items (JOBS step 3)
- AUD-OPUS-SH3-118 Day-10 lockout shows "confirming" with no End my plan: the mapping is recurring's (R1 `src/checkout/subscription-plan.ts:352-361` planView: `entitlement_active` false + status past_due/unpaid falls to `confirming`, so live=false and can_cancel=false). The state that triggers it is only written by dunning v2 lockout (`dunning-v2.service.ts:923` @ b17f514c, FEATURE_DUNNING_V2 off), which is not on the recurring tree. Recommended owner: recurring R1, landed with or after the lockout stack (#352-#354 composition). Fix rule: status past_due/unpaid maps to state `past_due` whatever entitlement_active is (add `access_locked: !entitlement_active`), so can_cancel stays true and the panel shows the locked past-due copy. Not fixed here (FREEZE; not a #680 line).
- C-673-3 (coach MRR counts never-billed trials): needs #676's BILLED_WHERE; not on this stack.
- #661 (hosted checkout, head f80f0088, base main) vs recurring top #701 @ 72eb096b, `git merge-tree`: 2 conflicting files.
  - src/checkout/checkout-webhook-handler.service.ts, 5 hunks:
    1. CheckoutWebhookPrefetch fields (~463): keep both sets (661: paymentIntentStatusById / paymentIntentWitnessById; recurring: trialCard, subscriptionAuthority, invoiceRevision, failedInvoiceStatus, failedInvoiceAuthority).
    2. prefetchForOuterTx dispatch (~775): keep both branches (payment_intent.payment_failed -> 661 prefetch; setup_intent.succeeded / subscription.created|updated / invoice.payment_failed -> recurring).
    3. endSubscriptionPurchase data (~1794): drop 661's `canceled_at` line (recurring's `ending` owns it and does not overwrite an ended row); keep `...trial` and use `...CLEARED_PAYMENT_SECRETS` unconditionally (superset of recurring's unpaid-attempt nulls).
    4. payment_intent.succeeded (~1863): recurring's early return for `purchase.billing_type === 'recurring' && purchase.stripe_subscription_id` (claimed, invoice.paid owns it) goes FIRST (guard `purchase &&`), then 661's `!purchase || !activatesOnPaymentIntentSuccess` block. Check that 661's updated_at bump on entitled rows by stripe_payment_intent_id cannot touch a recurring row (if it can, it only changes the row version, so recurring authority reads redeliver: fail closed, no money effect).
    5. payment_intent.payment_failed (~2060): recurring branch (invoice events own subscription rows; attempt decline only on never-entitled attempts) FIRST, then 661's PI_FAILED_CLAIMABLE compare-and-set; drop the old unconditional update/cancel on the recurring side (661 replaced it).
  - src/checkout/checkout.service.ts, 1 hunk (~87): keep both (661's finishedPaymentReplay / classifyPaymentReplay and recurring's isRecurringPackage).
  - Auto-merged without conflict: payment-ops.controller.ts, test/checkout-webhook-handler.spec.ts, test/checkout.service.spec.ts (still re-run both suites after the resolution).

## Follow-ups (C)
- src/checkout/dunning-v2/dunning-v2.service.ts ~86-88 `applyImmediateClear`: updates ClientPurchase in its own `$transaction` while the webhook tx holds the purchase row (FEATURE_DUNNING_V2 off; pre-existing). Fix rule: pass the webhook tx, or run post-commit.
- DunningService.recordFailure / recordResolution write on DunningService's own client and commit independently of the webhook tx (pre-existing). Fix rule: accept a tx client, or run post-commit with an idempotent replay key.
- C-680-7: setup_intent lookup by `stripe_client_secret` prefix is unindexed (src/checkout/checkout-webhook-handler.service.ts attachNativeTrialCard fallback). The metadata lookup now goes first. Fix rule: operator migration (> 20270316000000) adding the SetupIntent id column/index.
- From B-RECUR6A (unchanged): C-679-3; admin deletion "already running" while send holds the user row; pool hold during create.
- Restack-only prettier: src/checkout/checkout-webhook-handler.service.ts has pre-existing prettier drift on lines this round did not touch; CI has no prettier gate. Fix rule: format in a separate no-logic PR after the stack lands.

## Operator decisions (recommended default)
1. B-680-2 residual rule: the exemption only covers the transition into past_due. The residual edge (row stale `active` while Stripe is `past_due` from another invoice) redelivers. Default: accept.
2. Deletion trial consumption now requires the own card on (end lifted) or a granted trial. Default: accept.
3. Real-PG lock proof stays as a CI-lane probe (needs runner PG binaries). The committed regression is a deterministic lock-compat test with the real DunningService. Default: accept (a live PG suite would need ci.yml changes).
4. Day-10 lockout planView owner: recurring R1 with the lockout stack. Default: recurring.

## Log
- 11:11 start; rules read; lock recur taken.
- 11:2x merge #679, fixes, tests. 11:29 pushed #680 216489ff; lanes 37224558256 (before), 37224665666 (probes), 37224869844 / 37224894835 (PG shim after/before).
- 11:38 FIX ROUND 6 + READY on #680 (5983144676); body updated. Pushed #696 276610a3, #701 72eb096b; notify written; lock removed.
- 11:49 #696 and #701 green (10 pass, 1 skipping). Posted FIX ROUND 6 (restack + moved tests) on #696 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5983234958 and FIX ROUND 1 (restack, merge-only) on #701 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/701#issuecomment-5983235162, both READY FOR AUDIT. Bodies updated.
- 11:50 cleanup: 4 ci branches deleted, 4 worktrees removed (node_modules unlinked first); df 71%.

## HANDOFF
- #680 @ 216489ff: READY FOR AUDIT posted (needs fresh Opus 5.5 + Sol at this head; T4).
- #696 @ 276610a3: READY FOR AUDIT posted (5983234958). It is NOT merge-only (size move + one assertion update), so lenses should look at 0bbaba60 and 276610a3.
- #701 @ 72eb096b: READY FOR AUDIT posted (5983235162), merge-only.
- Audits needed at these exact heads: Opus 5.5 and Sol for #680 (T4), plus the fresh-lens requirement for #696 and #701.
- Operator decisions 1-4 above (recommended defaults given). #661 vs recurring conflict map above, for whoever lands second.
- Merge order unchanged: #686 -> #678 -> #679 -> #680 -> #696 -> #701.
