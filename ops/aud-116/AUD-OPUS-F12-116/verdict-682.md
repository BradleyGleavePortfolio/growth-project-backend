AUDIT Claude Opus 5.5 — growth-project-backend#682 @ 007d3dcbb69ebb1b31f406602ab3b7db65889896 — VERDICT: REQUEST CHANGES
A/B/C = 0/2/1

T4 audit of F2 (6 files, +2413/-116) at the exact head, base F1 `5a19178d`. Draft, land-as-one.

### Evidence reuse (G09)
- This lens approved #627 at `3a5338d7` ([5972040127](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/627#issuecomment-5972040127)). Every F2 file is byte-identical to the refreshed #627 tree `09de2bff` (= merge-tree of `66162285` and `d23fa317`).
- Audited deeply on top of that evidence: round 10, `parkFailureKind` (`transfer-orchestrator.service.ts:166-184`). It uses a closed vocabulary (db_request / db_unavailable / db_validation / unknown), and the fence-loss exception and retry are unchanged. B-627-10 (Sol) is closed at that boundary.
- Read in full regardless: the orchestrator (claim CAS on attempts plus marker, in-flight window, adoption, `reproveSendClaim`, HTTP-boundary start budget, `recordPosted` / `markFailed` / `scheduleRecheck` CAS, bounded listings, the reversal protocol), `payout-notice-copy.ts`, all of `test/utils/settlement-fakes.ts`, and the three specs.
- The findings below are new. This lens missed them at `3a5338d7`. That approval does not cover them.

### B: must fix before merge
**B-682-1: a reversal sender paused before its HTTP call reverses a second time after takeover and key expiry.** GPT-6.1 Sol reports the same boundary. This lens found it independently and proved it with its own probe.
- Where: `src/connect/fees/transfer-orchestrator.service.ts:1136-1153`. `drive()` awaits `fence()` and then the `attempts` update, and only then calls `reverseTransfer`. After those awaits there is no re-proof of the lease or the op, and no start budget at the HTTP boundary.
- Transfer creates got exactly these guards in round 9: `reproveSendClaim`, plus `assertSendStartable` via `beforeSend` (`stripe-connect-api.service.ts:1068`). This lens required them for B-627-9, so the same bar applies here.
- `completeReversal` (`:1212-1249`) then loses its CAS silently, so the books never see the second reversal.
- `fly.toml:45` (`auto_stop_machines = 'suspend'`) makes a long pause of a live process realistic.
- Probe ([CI-lane run 37172209834](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172209834), exact head plus probe spec, real orchestrator and ledger on the repo fakes):
  1. Worker A reserves a 400-cent reversal on a 1,000-cent paid transfer. It passes its fence, commits the attempt write and pauses.
  2. Worker B re-drives the same op: the listing shows it absent, B sends it, and the op is recorded as succeeded with 400.
  3. The Stripe keys expire and A resumes.
  4. Result: Stripe holds 2 reversals (800 cents) while the local reversed total is 400. The control (one ordinary reversal) passes.
- Fix rule: mirror the transfer send protocol for reversals.
  - Claim the send with a CAS on `(attempts, last_attempt_at)`.
  - After the claim await, re-run the fence and re-read the op: still pending, same attempt.
  - Pass a synchronous `beforeSend` to `reverseTransfer` that refuses once the claim is older than the start budget.
  - Leave an abandoned claim pending with `attempts > 0`, so the next driver lists before re-sending.
  - When a completion loses its CAS with a different `stripe_reversal_id`, raise an `SFEE_REVERSAL_DUPLICATE alert=true` line.
- Verify: this probe passes, plus pause-before-HTTP, takeover, expired-key resume and ordinary reversal controls.

**B-682-3: payout notices use first person.** GPT-6.1 Sol filed this as C-682-1. This lens rates it B: the owner copy bar is binding ("no first person"), and coach-facing first-person fallbacks were B in B-325-4.
- Where: `src/connect/fees/payout-notice-copy.ts:67, 79, 93, 101`.
- Same probe: 6 of 8 event/role cases fail. Example (refund, coach): "A client got $100.00 back. We took $94.80 back from that sale's payout. We will hold $5.20 from your next sale."
- Fix rule: use impersonal phrasing, for example "$94.80 was taken back from that sale's payout.", "$5.20 is held from your next sale.", "$94.80 was paid back to you and the $5.20 hold was released." Keep exact amounts and the 160-character limit.
- Verify: add a voice guard spec over every event x role asserting no `we/us/our` and no exclamation marks.
- The same rule applies to F4's `src/email/templates/coach-payout-adjustment.hbs:20` ("We take it out of your next payout"). That goes to the operator report for #684; it does not block this PR.

### C
**C-682-4: free-text error messages reach logs and `last_error`.** GPT-6.1 Sol filed the same sinks as B-682-2. This lens rates them C.
- Where: `transfer-orchestrator.service.ts:562-609, 803-807, 896, 951-955, 1156-1167, 1204-1208, 1256-1261`, and `markFailed` / `markTransferFailed` persisting `message`.
- Why C: every source is a Stripe or Prisma diagnostic for a request built only from ids, amounts and fixed strings. No user-entered text can reach these sinks, and this lens approved the same lines at `3a5338d7`.
- Fix rule: if the builder touches these lines, map them to closed codes (Stripe `httpStatus` / `stripeCode` plus the `parkFailureKind` style mapping).

Not re-raised: C-627-10 (operator follow-up after merge).

### Red by design (verified)
- build-and-test [run 37153346304, attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153346304/job/111344582169) fails exactly 4 tests in 2 suites:
  - `test/purchase-split-handler.service.spec.ts` (sub-coach "writes three ledger rows...", "is idempotent").
  - `test/checkout-webhook-fee-split.spec.ts` (":313 posts the head-coach transfer", ":358 replay idempotent").
- The cause in each case is "this.prisma.connectTransfer.updateMany is not a function": main's fakes lack the CAS claim, so `createTransfer` is called 0 times. F4 #684 carries the updated specs.
- Attempt 1's Jest OOM on `community-message-shape.live` was a known flake and is gone in attempt 2.
- The PR body also names the checkout specs. `checkout.service.spec.ts` passes; the body overstates the red, which is harmless.
- Totals: 712 suites passed; 12,302 tests passed.
- Every other context at this head is green. CodeQL, danger, banned casts and SBOM do not run on the stacked base and are required at the composed landing candidate.

No local heavy run, no push to the PR branch, no merge.
