# AUD-OPUS-F12-117: Claude Opus 5.5 lens on fees F1 #681 and F2 #682 (agent 117)

Times are from `date`. The job ran from about 04:30 to 04:58 UTC on 2026-10-04 (21:30 to 21:58 PDT on 10-03).

## Verdicts posted (heads re-read immediately before posting)

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#681 (F1 ledger foundation) | `9de3135c2f128289ab302dff43a04e12f32b74d1` | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/681#issuecomment-5976735017 |
| backend#682 (F2 transfer orchestrator) | `a5d6a434a9bd909699b158ac3791a09db25c241d` | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5976735098 |

`prstate.sh` after posting:
- `backend#681 merge=BEHIND opus=APPROVE sol=REQUEST_CHANGES checks=pass=11`
- `backend#682 merge=UNSTABLE opus=APPROVE sol=APPROVE checks=fail=1,pass=9,skipping=1`. The one failure is the red-by-design build-and-test.

## Scope and evidence reuse (G09)
- **#681:** FIX ROUND 11 delta `5a19178d..9de3135c` (6 files, +408/-47), read line by line. The rest rests on this lens's APPROVE at `5a19178d` (comment 5975947638) and its basis.
- **#682:** round-11 delta `007d3dcb..a5d6a434`, read line by line.
  - Merge `479873f4` is clean: the patch-id of `007d3dcb..479873f4` equals the patch-id of F1 r11 (`a070c096`).
  - The rest rests on this lens's RC at `007d3dcb` (comment 5975947733).
- **116 draft:** a 116-wave Opus draft and probes existed (`ops/aud-116/AUD-OPUS-F12R-116/`). They were used as pointers only. I ran every probe myself, added my own, and re-derived each conclusion.
- **Sol:** its verdicts at these heads were posted while my probes ran. I read Sol's #681 RC after my analysis to dispose of it on evidence; I did not copy it.

## CI-lane runs (exact head plus probe specs only)

| Run | Head | Result |
|---|---|---|
| [37177782132](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177782132/job/111363926028) | #681 `9de3135c` + 2 probe files | 4 suites, 36/36 pass: 116 probe L1-L5, D1, D2; mine X1-X2; builder r11 spec; split-ledger.service.spec |
| [37177789957](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177789957/job/111363949166) | #682 `a5d6a434` + 3 probe files | 5 suites, 56/56 pass: 116 probe W1-W6, C1-C3, D1-D3, L1-L4, P1-P2; mine X1-X4; builder r11; orchestrator spec; r9 send boundary. The live-DB suite failed to compile (harness `never[]`). |
| [37177952371](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177952371) | #682 + live-DB probe | 4/5 pass. DB-R2 failed on a harness collision: the probe fake reused `trr_1` against the unique `stripe_reversal_id`. Fixed. |
| [37178103246](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178103246/job/111364872185) | #682 + live-DB probe (fixed) | 5/5 pass on Postgres 15 after `prisma migrate deploy` of the repo chain: DB-L0 control (old algorithm duplicates 30 of 30), DB-L1, DB-L2, DB-R1 (two pools, 20 ops: 1 send per op, 20 losers ReversalUncertainError), DB-R2 (TIMESTAMP(3) CAS round trip) |

Builder runs are bound correctly:
- F1 failing-before 37172716648 (`cd204382` = `b2bb3100` + lane files) and passing-after with tsc 37172742665 (`40d08a33` = `9de3135c` + lane).
- F2 failing-before 37173216866 (`bacd99ee` = `461dc265` + lane) and passing-after with tsc 37173243305 (`502d43ef` = `a5d6a434` + lane).

Red by design on #682 was verified from GitHub:
- Build-and-test run 37173697501 attempt 2, job 111353837189, fails exactly 4 tests in `checkout-webhook-fee-split.spec.ts` (2) and `purchase-split-handler.service.spec.ts` (2).
- The cause in each is `this.prisma.connectTransfer.updateMany is not a function` (main's fakes).
- F4 `e9ee033d` rewrites both specs. Everything else is green.

## Prior findings closed
- **#681:** C-681-3 (= Sol B-681-2) is closed for the same-account race. C-681-4 (= Sol B-681-1), C-681-5 and C-681-6 (as ruled under OR-113-4) are closed.
- **#682:** B-682-1, B-682-3 (= Sol C-682-1) and C-682-4 (= Sol B-682-2, operator C-685-2) are closed.

## New findings (all C)
- **C-681-7:** `split-ledger.service.ts:61-64` keys the legacy identity on the payee's account, while the lookup (`:336-345`) uses payee_user_id. Two concurrent first-time planners that read different seller accounts write 2 destination rows (probe L4).
  - This is the same issue as Sol's open **B-681-2**. This lens rates it C:
    - The legacy path needs a destination charge, and no F1 code mints one.
    - Production had 0 Connect accounts at the operator's 10-03 19:15 facts.
    - A duplicate cannot pay twice: the transfer is keyed per purchase.
  - It becomes B if a legacy destination charge exists at deploy time.
  - Fix: key on `<purchase>:<kind>`, or add payee_user_id.
- **C-682-5:** `findStripeReversal` (`:1241`) uses only the first metadata match. Two Stripe reversals for one key complete silently (D3: `stripe=800 books=400 duplicate_alerts=0`). Fix: count matches across the listing and log `SFEE_REVERSAL_DUPLICATE` when there is more than one.
- **C-682-6:** the 160-character push cut (`payout-notice-copy.ts:117`) drops trailing words in `dispute_won` bodies for non-USD amounts of 9,999.99 or more. Amounts are never cut (X4: 24 cut, amount_cut=0; USD never). Fix: shorten whole clauses instead of cutting mid-word.
- **C-682-7:** the `send_abandoned` cause text in `reversalMoved` (`:1268-1277`) says "another attempt", but the pending claim is the worker's own (X3). Fix: give each reason its own cause text.

## Operator items (outside these diffs)
1. **#681 split decision.** Opus APPROVE 0/0/1 and Sol RC 0/1/0 point at the same edge (C-681-7 = Sol B-681-2).
   - Default: the builder fixes it in F1 round 12 (a cheap key change plus a two-snapshot regression), then merges forward through F2-F6, and both lenses re-audit F1 and F2.
   - Alternative: the operator rules it C, citing 0 legacy destination charges, and records the ruling.
2. **#681 is BEHIND main `a5b605d1`.** The 14 files main changed since `d23fa317` include none of #681's files. Default: update-branch, then the rule-12 MERGE-ONLY TREE CHECK; no new lens verdict needed.
3. **F2 headroom.** F2 has 49 lines of headroom (2,951 changed lines). Any F2 fix for C-682-5/6/7 should put its tests in a later piece if it would exceed that.
4. **#684 (F4), closed-diagnostics sinks still present.** Two log lines in `src/checkout/purchase-split-handler.service.ts` still carry raw messages at F4 `e9ee033d` and F6 `6f1b94a9`:
   - `:66` `resolveChargeIdForPurchase failed ... ${(err as Error).message}`
   - `:197` `transfer.attempt failed inline ... ${(err as Error).message}`

   They are the same class as the closed B-681-1/B-682-2. Default: route them to the F34 lens job and the F4 builder (map them through `moneyErrorDiagnostic` or `dbErrorKind`).
5. **#684 copy is already fixed.**
   - `coach-payout-adjustment.hbs` at `e9ee033d` reads "It comes out of your next payout..." (no first person).
   - `payout-notice.service.ts` has no "We could not find".
   - This lens's B-682-3 extension to F4 is therefore satisfied at that head. That observation comes from grep only; F4 itself was not audited here.
6. **116 leftovers.** `origin/wip/op116/AUD-OPUS-F12R-116-681` (`460fc006`) and `-682` (`c155e757`) belong to 116 and were left in place. Default: the operator deletes them after this wave.

## Cleanup and process notes
- **Branches.** `audit/AUD-OPUS-F12-117/681-probe`, `682-probe` and `682-livedb` were deleted; `git ls-remote` shows 0 left. The run logs remain on GitHub.
- **Worktrees.** `wt/AUD-OPUS-F12-117-681` and `-682` were removed. No node_modules had been linked. Sol's `wt/AUD-SOL-F12-117-*` were left alone.
- **Probe sources kept** in `ops/aud-117/AUD-OPUS-F12-117/`:
  - `audit-opus-f12-117-681-extra.spec.ts`
  - `audit-opus-f12-117-682-extra.spec.ts`
  - `audit-opus-f12r-livedb-probe.FIXED-117.spec.ts`

  Logs, verdict bodies and `notes.md` are in the same folder.
- **Claims** stay as mkdir markers: `ops/lanes117/claims/backend-681-9de3135c-opus` and `backend-682-a5d6a434-opus`.
- **Cache.** `ops/cache/backend-681.txt` and `backend-682.txt` were removed once to force a fresh `prstate.sh` read after posting, and the script regenerated them at once.
- **Money and production.** No money spent, no push to a PR branch, no merge, no production or provider action, no heavy local work.

## HANDOFF
- **#681 @ `9de3135c`:** Opus APPROVE 0/0/1 (comment 5976735017) and Sol RC 0/1/0 (5976673165), on the same edge. Next step: the operator chooses between builder round 12 (default) and a C ruling. Then update-branch to main and the rule-12 tree check.
- **#682 @ `a5d6a434`:** Opus APPROVE 0/0/3 (comment 5976735098) and Sol APPROVE. It is red by design (4 tests, F4 carries the fixes). It lands only with F1-F6 as one composed candidate, and CodeQL, danger, banned casts and SBOM must be checked on that candidate.
- **If F1 changes in round 12**, both F1 and F2 need new verdicts at their new heads. To re-run the probes, copy the probe specs from `ops/aud-117/AUD-OPUS-F12-117/` into a fresh `audit/*` branch through the CI lane. The live-DB probe starts its own `postgres:15` container.
- **Open C items for the builder (optional):** C-681-7, C-682-5, C-682-6, C-682-7. Operator item 4 (#684 message sinks) goes to the F34 job.
