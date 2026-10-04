# AUD-OPUS-661-117 — Claude Opus 5.5 lens, backend #661 round 4 (operator agent 117)

This lens did no heavy local work and ran no new CI-lane probe: the builder's lanes already carried this lens's probe verbatim, and both lane logs were read.
- **Notes and evidence:** /home/user/workspace/ops/aud-117/AUD-OPUS-661-117/
  - verdict-661.md, the posted body
  - job-111356042862.log, the failing-before lane
  - job-111357191173.log, the after lane with both lens probes
  - bt-attempt1-111357508906.log, the build-and-test OOM attempt
  - bt-attempt2-111361616578.log, the green attempt
- **Claim:** ops/lanes117/claims/backend-661-6fdc35de-opus.
- **Independence:** Sol's verdict at this head (5976655927, posted 04:42Z) was not read before this verdict was written or posted.

## backend #661 @ 6fdc35de61a26a0c9e8b3741044a3ec223dc9ab4 — APPROVE, A/B/C = 0/0/5
- **Verdict:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976687000 (posted 04:47:44Z).
- **Builder's round:** FIX ROUND 4 + READY at 5976653011, posted by operator 117.
- **CI:**
  - All 11 required checks are green at 6fdc35de.
  - build-and-test run 37175620562, attempt 1: a jest worker ran out of memory in `test/community/rls/community-message-shape.live.spec.ts`, which is unrelated to this PR. 716 suites passed and 0 assertions failed. This is the known #694 infra failure.
  - Attempt 2 is green. Both of this PR's suites pass there.
- **Merge state:** BEHIND main 0b0f5b82 (#611). 0b0f5b82 touches no PR file and `git merge-tree` is clean, so it qualifies for the rule-12 MERGE-ONLY TREE CHECK (operator).
- **Scope:**
  - Every line of the round-4 delta was read: a193d7e1..6fdc35de limited to PR files gives 3 files (handler src +132/-13, the new `test/checkout-hosted-activation-once.spec.ts`, and round-4 cases in `test/checkout-webhook-handler.spec.ts`). The tests are byte-identical between 56c3d156 and 0e079bb8.
  - Both main merges are automatic. Their trees equal `git merge-tree` of their parents: d2399d2e gives 56131f4b and 6fdc35de gives 462ea4b3.
  - Evidence reuse (G09): every other PR line is byte-identical to a193d7e1, where this lens audited all of it.
- **Evidence verified:**
  - Failing-before [run 37175121818](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175121818): 13 failed / 51 passed, source = a193d7e1 + main.
  - After-lane [run 37175513324](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175513324): 3 failed / 66 passed. The failures are both Opus DEFECT probes (they now fail at `claimed` true, so the defect is gone) and Sol's hosted T1 at the same-PI success step. That step is unreachable through the product: Checkout never retries a failed async payment, and the backend never confirms hosted PaymentIntents. Both controls pass.
- **Closed:**
  - B-661-5: PaymentSheet-only claim of `payment_failed` (`stripe_checkout_session_id === pi.id`), in both the handler and the prefetch.
  - C-661-6: a 4xx other than 429 is a logged no-op.
  - C-661-7: read fence plus `status notIn` on the activation write.
  - Sol B-661-3, checked independently: a purchase-version witness taken before the Stripe read, a compare-and-set on id + status + `updated_at` (TIMESTAMP(3), `@updatedAt`, no raw SQL writers), and the success touch on entitled rows. Every reachable READ COMMITTED interleaving resolves to 503-and-redeliver or to a correct write.
- **Open C items:**
  - C-661-2 (carried, operator): historic credential backfill.
  - C-661-3 (carried, merge order): GitHub still shows the round-3 PR body. The drafted round-4 body at ops/b661-116/r4-body-after.md carries the round-4 composition note and the raw-SQL promotion trigger. Apply it before merge.
  - C-661-8 (new, optional): `:654-659` treats 401 and 403 as permanent. Only 404/400 should be permanent; log the drop at error level.
  - C-661-9 (new, optional): the write-side completion fence at :733 has no test.
  - C-661-10 (outside the diff, pre-existing): the metadata fallback can stamp session A's PaymentIntent on session B's row. Lookups by `stripe_payment_intent_id` (the decline `findFirst`, the refund fallback) are then ambiguous. Release the PaymentIntent on completion, and add an index on `stripe_payment_intent_id`.

## Cleanup
- The worktree /home/user/workspace/wt/AUD-OPUS-661-117-1 was removed (no node_modules had been linked).
- No audit/AUD-OPUS-661-117/* or ci/* branches were created.
- The builder's ci/B-661-R4-116-661-before and ci/B-661-R4-116-661-after branches belong to the builder or operator and were left in place.

## HANDOFF
- **#661 @ 6fdc35de: Opus APPROVE 0/0/5** ([comment 5976687000](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976687000)). CI is green, 11/11. Merge state: BEHIND 0b0f5b82.
- **Next steps (operator):**
  1. Apply r4-body-after.md to the PR body (C-661-3).
  2. Run update-branch, then the rule-12 MERGE-ONLY TREE CHECK. 0b0f5b82 touches no PR file, so no new Opus verdict is needed. If the merge produces anything else, a fresh Opus lens posts a short merge-only delta.
  3. Merge only once both lenses' final verdicts at the landed head allow it. Sol's verdict at 6fdc35de is REQUEST CHANGES (5976655927; not read by this lens).
- **Delete:** ci/B-661-R4-116-661-before and ci/B-661-R4-116-661-after.
- **Operator decisions (recommended default first):**
  1. C-661-2: run the backfill in a deploy window after merge.
  2. C-661-3: whichever of #661 and #678-#680 lands second applies `activatesOnPaymentIntentSuccess` to recurring PaymentSheet / first-invoice rows and keeps the C-661-7 fence for one-time rows.
  3. C-661-8, C-661-9 and C-661-10: a follow-up ticket, not blocking.
