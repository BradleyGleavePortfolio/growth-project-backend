# AUD-OPUS-661-118 — Claude Opus 5.5 lens, backend #661 + #702 (operator agent 118)

Status: DONE. Both verdicts posted 10:08 PDT 10-04.

- #661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2: APPROVE 0/0/4 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5982407688
- #702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb: APPROVE 0/0/1 — https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702#issuecomment-5982408645
- Posted bodies: aud-118/AUD-OPUS-661-118/verdict-661.md, verdict-702.md. Probe copies: aud-opus-661-118.live.spec.ts, zz-aud-opus661-118-pg.global.js, aud-sol-661r6-selection.live.spec.ts (dead Sol probe as replayed).

- Claims: ops/lanes118/claims/backend-661-f80f0088-opus, backend-702-20d2eb4f-opus.
- Notes and raw evidence: /home/user/workspace/ops/aud-118/AUD-OPUS-661-118/ (PR comments json, PR bodies, job logs, lane logs).
- Independence: Sol's verdicts at these heads were not read before posting (no Sol verdict existed at f80f0088 / 20d2eb4f when the comment list was read at 09:50 PDT; comment bodies were not re-read after that).
- Worktrees used: /home/user/workspace/wt/AUD-OPUS-661-118-1 (20d2eb4f + probe), AUD-OPUS-661-118-ctl-c7ee15f0, AUD-OPUS-661-118-ctl-957e3677 (controls). No node_modules linked; all three removed. Branches audit/AUD-OPUS-661-118/{661-delta,661-control-c7ee15f0,661-control-957e3677} deleted (0 remain). Probe commit 49e61b33 (unreferenced) holds the probe.
- No heavy local work. All probes ran in the CI lane.

## Heads and checks (re-read before posting)
- #661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2, base main b644198b, CLEAN, 11/11 required SUCCESS (ci run 37218016267; CodeQL 37218016347; banned casts 37218016286; build-sbom 37218016358; danger 37218016266; schema parity 37218016264; npm audit 37218016398). build-and-test: 728 suites passed, 0 failed. mwb-3-live-tests: 8 suites / 71 tests, checkout-settlement.live.spec.ts PASS, none skipped.
- #702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb, base agent/clinic/b-secrets-3, CLEAN. No required checks apply (base is not main); every check that ran is green (ci run 37218019543: build-and-test 729 suites passed incl. checkout-hosted-activation-once; mwb-3 74 tests, the 9/10/12 cases included; rls-live, community-live, rls-floor-guard; schema parity; npm audit).
- Size: #661 +2,716/-127 = 2,843 (16 files, no lockfile); #702 +509/-4 = 513 (2 files). Both under 3,000. #661 is in the 1,500-3,000 band: the operator owns the SIZE ASSESSMENT at f80f0088 (FIX ROUND 8 states the size; no SIZE ASSESSMENT comment at this head).

## Evidence reuse (G09)
- Opus last APPROVE: 957e3677 (5977175681). Every #661 file outside the round-6/7/8 delta is byte-identical to 957e3677 (admin-purchase.select.ts, checkout.service.ts, dunning.service.ts, payment-ops.controller.ts, log-redaction.ts, b-secrets-3-admin-credentials.spec.ts, checkout.service.spec.ts): that audit applies.
- Merge ce7c2051 (main b644198b): automatic, tree 0f74b27c = git merge-tree 957e3677 b644198b; main touched no PR file.
- Delta audited line by line: ce7c2051..f80f0088 (ci.yml +3, handler +45/-40, purchase-fanout +14/-4, test doubles, new live spec, moved spec).
- #702: b261dd1f automatic (tree 28cbca22 = merge-tree 5c25122d f80f0088); integrated tree 4339454c at 5c25122d and 20d2eb4f; moved spec SHA-256 fc2e00c2... at c7649169 and 20d2eb4f; 957e3677..c7649169 changes it by one double line (findMany).

## Probes (this lens)
- Probe: test/aud-opus-661-118.live.spec.ts on audit/AUD-OPUS-661-118/661-delta (20d2eb4f + probe + dead Sol R6 probe verbatim + lane-only PG setup), tsc green, 5 suites / 53 tests pass: run 37218675555.
  - O1 owner behind 30 never-activated rows + 5 activated non-owners (recurring, subscription, refunded, chargeback_lost, canceled): owner recovers; none of the others changes; redelivery changes nothing.
  - O2 no-transaction path: owner query and CAS recovery on PrismaService.
  - D1 x5 (refund, dispute, subscription_canceled, partial_refund_decision, grant_revoked): pending/due/failure-canceled drops take the reason; other-reason, fired, failed drops untouched; restore returns none.
  - D2 payment_failed cancel never takes over other reasons; restore returns only failure-canceled drops.
  - L1 FOR NO KEY UPDATE: ScheduledDrop insert referencing the purchase completes while the PI lock is held; UPDATE waits.
- Control at c7ee15f0 (run 37218911726): O1, O2 fail ({claimed:false, reason:'checkout_session_activates'}); D1, D2, L1 pass.
- Control at 957e3677 (run 37218923485): D1 x5 and L1 fail (L1 outcome 'blocked'); O1, O2, D2 pass.
- Dead Sol lens AUD-SOL-661R6-117 probe (661-native-verified, aud-sol-661r6-selection.live.spec.ts, 9 and 10 adoptions through real native reservations): replayed unchanged at 20d2eb4f, PASS (run 37218675555).
- Builder evidence verified: R7 failing-before 37186266591 (2 failed / 31 passed: the 10 and 12 cases); after 37186426457 (190/190).

## Reply codes #661 adds or keeps (for recurring and the mobile sheet, B-SHEET-118)
Client-facing, POST payment-intent replay of an idempotency key (src/checkout/checkout.service.ts:89-111, 676-680):
- 409 PAYMENT_ALREADY_COMPLETE: status paid / active / past_due / trialing. Copy "This payment is already complete. Your package is ready in your account." (see C-661-14: untrue for trialing).
- 409 PAYMENT_REFUNDED_OR_IN_REVIEW: refunded / disputed / chargeback_lost.
- 409 PAYMENT_CHECKOUT_CLOSED: any other finished status (canceled, expired, payment_failed without credentials).
- 503 PAYMENT_IN_PROGRESS (pre-existing): the winning request is still publishing credentials after the poll window.
- Pre-existing 409s on the same route: COACH_NOT_CONNECTED, COACH_NOT_PAYOUT_READY.
Stripe-facing only (webhook 503 + redelivery; never shown to clients): PAYMENT_SUCCESS_RETRY (reason purchase_changed), PAYMENT_FAILURE_RETRY (reasons purchase_changed, payment_intent_status_unknown). Webhook result reasons: payment_recovered, checkout_session_activates, already_progressed, stale_failure, payment_intent_unreadable, no_matching_purchase.

## Follow-ups (C)
- C-661-13 (new, docs): PR bodies stale after FIX ROUND 8. #661 body status line says round 7 / 3,121 lines and its round-4 acceptance evidence lists test/checkout-hosted-activation-once.spec.ts as in this PR; #702 body says "One file", "235 changed lines" and omits the moved spec. Fix rule: operator refreshes both bodies (status, sizes 2,843 / 513, moved spec under #702). Verify: body text.
- C-661-14 (new, outside this delta, composition): src/checkout/checkout.service.ts:89 puts `trialing` (and `past_due`) in PAID_STATUSES, so a replay answers PAYMENT_ALREADY_COMPLETE "This payment is already complete" for a free trial that charged nothing. Not reachable through today's one-time PaymentSheet route; becomes reachable when native trials/recurring (#672, #678-#680) reserve rows on this classifier. Fix rule: whichever of #661 / #672 / #678-#680 merges second maps trialing to a trial-specific code and copy (no payment claim) and past_due to a payment-update code; one replay test per status.
- C-661-10 (carried, pre-existing, follow-up): metadata fallback can stamp one PaymentIntent on two rows; no index on ClientPurchase.stripe_payment_intent_id (lock + owner query + findFirst scan per PI event). Rule: index migration and release/refuse the second stamp.
- C-661-2 (carried, operator): historic credential backfill in a deploy window.

## C for #702
- C-702-1 (docs): #702 body says "One file" / "Size: 235 changed lines" and omits the moved test/checkout-hosted-activation-once.spec.ts. Fix rule: add the moved spec (SHA-256 fc2e00c2..., from #661 c7649169) to acceptance evidence; size 513.

## Main moved during the audit
- Main b644198b -> b7ff3c73 (#698, data-export only: src/data-export/data-export.service.ts + 2 specs). No PR file touched; git merge-tree f80f0088 b7ff3c73 clean (tree dcc6864e); 20d2eb4f + b7ff3c73 clean (tree 44956a9d). #661 is BEHIND: rule-12 MERGE-ONLY TREE CHECK, no new Opus verdict needed for a pure main merge.

## Operator decisions (recommended default first)
1. Merge order: merge #702 into agent/clinic/b-secrets-3 first (its tree 4339454c is what this lens audited), then land #661. A landed #661 head whose tree equals 4339454c needs no new Opus verdict (tree check); anything else gets a short delta.
2. SIZE ASSESSMENT at f80f0088 (2,843): KEEP.
3. C-661-13: refresh both PR bodies before merge.
4. C-661-14: carry into the trials/recurring composition note (B-SHEET-118 must not map PAYMENT_ALREADY_COMPLETE to "paid" copy for trials).
5. C-661-2 / C-661-10: follow-up tickets.

## HANDOFF
- #661 @ f80f0088c98cd078cffa5dd217a8fdc84ad631b2: Opus APPROVE 0/0/4 (comment 5982407688). 11/11 required SUCCESS at this head. Merge state BEHIND main b7ff3c73 (no PR file touched; clean merge-tree). Next: operator update-branch + rule-12 tree check; SIZE ASSESSMENT at 2,843 (default KEEP); refresh PR body (C-661-13); merge #702 into agent/clinic/b-secrets-3 first, then land #661 once both lenses' final verdicts allow it.
- #702 @ 20d2eb4f696f5e9b4966000f88bd1cdf76ba4ddb: Opus APPROVE 0/0/1 (comment 5982408645). Every check that ran is green; no required checks on this base. Next: refresh body (C-702-1); merge into agent/clinic/b-secrets-3 (tree 4339454c is what this lens audited).
- A landed #661 head whose tree equals 4339454c (or 4339454c merged with a main that touches no PR file) needs no new Opus verdict; anything else needs a short Opus delta.
- Recurring (#678-#680) and B-SHEET-118 depend on the reply codes listed above; C-661-14 (trialing -> "already complete" copy) is theirs to resolve at composition.
- This lens job is complete; nothing is waiting on it.
