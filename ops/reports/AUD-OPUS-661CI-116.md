# AUD-OPUS-661CI-116 — Claude Opus 5.5 lens, backend #661 + backend #694 (B-CI-116)

Operator agent 116 wave. This lens did no heavy local work; the probe ran in the CI lane.
- Notes and verdict bodies: /home/user/workspace/ops/aud-116/AUD-OPUS-661CI-116/
  - verdict-661.md and verdict-694.md
  - comments.md
  - the job logs
  - zz-aud661ci-hosted-probe.spec.ts, a copy of the probe
- Claims: claims/backend-661-a193d7e1-opus and claims/backend-694-14c84c75-opus.

## 1. backend #661 @ a193d7e17b2d4daeb944891191824d08e280b437 — REQUEST CHANGES, A/B/C = 0/1/3
- **Verdict:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976157987
- **Scope:**
  - Full audit of the whole PR at this head: 12 files, +1343/-103 against main d23fa317.
  - Rounds 2 and 3 (f4679fd8, fcf0d4c3, 57fa2402) read line by line.
  - a193d7e1 is the automatic merge of d23fa317. Its tree ef3801c0 equals `git merge-tree` of 57fa2402 and d23fa317.
  - CI: 11/11 required checks green. Merge state: BEHIND main f57baba3 (#664, deps only).
- **Prior findings of this lens (5964409597 @ 91625c86):**
  - B-661-1: closed for PaymentSheet rows.
  - C-661-4: closed.
  - C-661-2 (historic credential backfill): still open, operator decision.
  - C-661-3 (merge order with #678-#680): still open; the body note is present.
- **Sol's B-661-3 (late decline vs successful retry):** closed, checked independently.
  - The compare-and-set on `status in (pending, payment_failed)` holds under READ COMMITTED.
  - The 503 rolls back the dedup row, and Stripe redelivers.
  - No Stripe HTTP call runs inside the transaction.
  - No credential appears in any response or log line.
- **New B-661-5:** round 2's `PI_SUCCEEDED_CLAIMABLE` lets `payment_intent.succeeded` (checkout-webhook-handler.service.ts:1019-1021, prefetch :519-521) claim hosted Checkout rows that a decline adopted (:1102-1133).
  - Mobile main pays through hosted Checkout, so a decline followed by a successful in-page retry triggers this:
    1. The PaymentSheet path activates the hosted row: `access_expires_at` stays null and the fanout entrypoint is `in_app_ps`.
    2. `checkout.session.completed` then activates it again: a second split and a second `onPurchaseEntitled`.
    3. The second activation's coach_new_purchase marker INSERT hits its unique index inside the webhook transaction (purchase-fanout.service.ts:424). PostgreSQL aborts the transaction, so the event fails on every redelivery. This step follows from PostgreSQL semantics and was not run live.
  - Two-session variant: one charge entitles two rows and defers two splits.
  - Probe: [CI-lane run 37173615928](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173615928) is green (66/66), which means the defect is reproduced. It includes a PaymentSheet control test.
  - Fix rule: claim `payment_failed` only when `stripe_checkout_session_id` equals the PaymentIntent id (PaymentSheet rows). Leave hosted rows to `checkout.session.completed`. Add tests plus a failing-before run in the CI lane.
- **New C findings:**
  - C-661-6: a permanent Stripe 404 on the status lookup gives 503 for the whole retry window. Optional fix: a logged no-op.
  - C-661-7 (outside the diff): `applyCheckoutCompleted` has no status fence.

## 2. backend #694 (B-CI-116) @ 14c84c75aba63236ef22ca3dea96f791dc75f247 — APPROVE, A/B/C = 0/0/2
- **Verdict:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976166775
- **Status:** READY FOR AUDIT at 03:11 UTC. 11/11 required checks green. Merge state: BEHIND f57baba3 (deps only). `git merge-tree` is clean against main and against #687's current head 7d7e7db4.
- **Diff and CI gate:**
  - 2 files: `jest.config.js` (ts-jest `isolatedModules: true`, `logHeapUsage`, `workerIdleMemoryLimit: '2GB'`) and the new guard spec. Every line was read.
  - `.github` is untouched: no required job is renamed or removed, and no gate is weakened.
  - `tsc --noEmit` (strict, no `include`) runs fail-closed before `Test` in the same required job and covers every file jest loads.
- **Transpile mode:** confirmed active in ts-jest 29.4.9 (config-set.js:228, ts-compiler.js:74).
- **Root cause:** confirmed by the raw A/B data (1396-2124 MB retained with type-checking vs 75-386 MB transpile-only) and by the OOM logs of main job 111265482439 and #685 job 111286643176.
- **Two green runs at this head:** 37172628536 attempts 1 and 2. Jest took 137.8 s and 235.1 s; 714 suites passed; peak heap was 1553 and 1632 MB; no crashes.
- **C findings:**
  - C-694-1: the guard's walk omits `scripts/` and `prisma/` `.ts` that tests import.
  - C-694-2: a job-level `if` on build-and-test is not pinned.

## Cleanup
- Remote branch audit/AUD-OPUS-661CI-116/661-hosted-probe: deleted. No audit/AUD-OPUS-661CI-116/* branches remain.
- Worktree /home/user/workspace/wt/AUD-OPUS-661CI-116-1: removed (`git worktree remove --force`; no node_modules was linked).
- Local branch aud661ci-probe: deleted.

## HANDOFF
- **#661 @ a193d7e1: REQUEST CHANGES 0/1/3** ([comment 5976157987](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976157987)). CI is green, 11/11.
  - Next: B-661-116 fix round 4 for B-661-5. Narrow the `payment_failed` claim to PaymentSheet rows in `applyPaymentIntentSucceeded` and `prefetchChargeIdForActivation`, with failing-before tests (hosted decline then PI success, two-session case, PaymentSheet control).
  - The probe copy is available for reuse at ops/aud-116/AUD-OPUS-661CI-116/zz-aud661ci-hosted-probe.spec.ts.
  - The later merge-only delta (#664 deps) can be reviewed together with that round.
- **#694 @ 14c84c75: APPROVE 0/0/2** ([comment 5976166775](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976166775)). CI is green, 11/11. Sol has REQUEST CHANGES at this head; this lens did not read it, so the two verdicts are independent.
- **Operator decisions (recommended default first):**
  1. C-661-2 historic backfill (`UPDATE "ClientPurchase" SET stripe_client_secret = NULL, stripe_ephemeral_key = NULL WHERE status NOT IN ('pending','payment_failed')`): run it in a deploy window after #661 merges.
  2. C-661-3: whichever of #661 and #678-#680 merges second reconciles per the body note, including the same PaymentSheet-only predicate for recurring rows.
  3. C-661-6 and C-661-7: follow-up ticket, not blocking.
  4. C-694-1 and C-694-2: fold into any later #694 round, or a follow-up. Not blocking.
  5. #694 versus #687: whichever lands second keeps one `workerIdleMemoryLimit` entry; with the identical block that merge is a no-op.
