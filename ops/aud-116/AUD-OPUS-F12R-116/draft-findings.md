# AUD-OPUS-F12R-116 draft findings (NOT POSTED; probes not yet run)

Heads: #681 9de3135c2f128289ab302dff43a04e12f32b74d1, #682 a5d6a434a9bd909699b158ac3791a09db25c241d.

## Code-read conclusions so far (pending CI-lane probe confirmation)
- Merge 479873f4 (F1 r11 into F2) is clean: patch-id of 007d3dcb..479873f4 == 5a19178d..9de3135c.
- Sol B-681-1 / Opus C-681-4 (charge-lock release log): closed by code read. Log is `SFEE_CHARGE_LOCK_RELEASE_FAILED lock=<name> error_kind=<dbErrorKind>`; no message/name/code.
- Sol B-681-2 / Opus C-681-3 (legacy ledger race): closed by code read. Key `sfee-legacy-ledger:<purchase>:<kind>:<acct|platform>` in the existing unique idempotency_key column. P2002 loser re-reads by key and adopts. Not inside a transaction, so the P2002 does not abort a tx. idempotency_key is written only by upsertEntry; it is not in COACH_LEDGER_SELECT. Candidate C: the key names the payee account while the lookup names payee_user_id, so two concurrent planners that read different seller accounts would write two rows (very unlikely; probe L4 documents it).
- Opus C-681-5 (undoReversal): deleted; closed.
- C-681-6 (migration timestamp): ruled keep (OR-113-4); closed as ruled.
- B-682-1 (reversal 800 vs 400): closed by code read. Claim CAS on (id, pending, attempts, last_attempt_at). Fence and op re-read after the claim. 30 s budget counted from before the claim await (max of wall and monotonic), checked again synchronously in beforeSend (post() has no await between beforeSend and fetch). SFEE_REVERSAL_SEND_ABANDONED leaves attempts > 0, so the next driver lists Stripe first. Same-key re-sends inside 24 h collapse at Stripe.
- SFEE_REVERSAL_DUPLICATE: fires when the completer's CAS loses and the recorded stripe_reversal_id differs, including status=refused with recorded=none. Candidate C (cheap): findStripeReversal takes the first metadata match, so if two Stripe reversals carry one op key while the op is still pending, the op completes silently (probe D3). Fix rule: count matches and raise DUPLICATE when there is more than one.
- Sol B-682-2 / Opus C-682-4 / C-685-2 (free text in logs): closed by code read at every orchestrator sink (refusal, uncertain, not visible, receipt pending, listings, recheck unscheduled :896, reversal refused/uncertain, outcome.error, ReversalUncertainError message). transferFailureCode still reads the message, but only to choose a classification from a closed set.
- B-682-3 (first-person copy): closed by code read. No we/us/our in the F2 src strings; exact amounts are kept. Candidate C (pre-existing, not round 11): the 160-character body cut can land inside the last amount for non-USD high amounts (packages allow gbp/eur/aud/cad). Example: a eur dispute_won with all four amounts at 9,999.99 EUR comes to about 161 characters. Fix rule: drop or shorten the trailing held sentence instead of cutting mid-amount. To be quantified by probe P1.
- Red by design #682: verified from job 111353837189 (run 37173697501, attempt 2). Exactly 4 tests in 2 suites fail: purchase-split-handler.service.spec (sub-coach "writes three ledger rows...", "is idempotent") and checkout-webhook-fee-split.spec ("posts the head-coach transfer", "replay idempotent"). The cause is `this.prisma.connectTransfer.updateMany is not a function` in main's fakes. At F4 c4e3b19f both specs are rewritten onto settlement-fakes (Table.updateMany). Totals: 714 suites pass, 12,333 tests pass. Every other context at a5d6a434 is green.
- #681: all 17 run contexts green at 9de3135c (build-and-test attempt 2).
- Sizes: #681 2,882 (2217+665) and #682 2,951 (2836+115). #682 has 49 lines of headroom, so any F2 fix beyond about 49 lines goes into F4/F5 tests, or src goes to F4.
- Outside the diff (operator): main's purchase-split-handler.service.ts logs `transfer.attempt failed inline ...: <err.message>` (seen in the CI log). This is main code, so it is C outside the diff (F4 owns that file in the stack).

## Draft verdicts (not final until probes pass)
- #681: APPROVE 0/0/1 (C-681-7: the key/lookup mismatch edge), if probe F1 passes.
- #682: APPROVE 0/0/2 (C-682-5: duplicate-match detection in lookup; C-682-6: the 160-character cut inside an amount for non-USD), if probes R-W/R-C/R-D/R-L/R-P and LIVE-DB pass.
