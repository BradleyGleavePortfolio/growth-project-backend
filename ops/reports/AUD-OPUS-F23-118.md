# AUD-OPUS-F23-118 — Claude Opus 5.5 lens, fees F2 #682 + F3 #683 (agent 118 wave)

Started 2026-10-04 10:53 PDT, verdicts posted 11:10 PDT. Claims: backend-682-70f879a2-opus, backend-683-438d29e6-opus.
Notes: ops/aud-118/AUD-OPUS-F23-118/:
- verdict-682.md and verdict-683.md (the posted bodies);
- audit-opus-f23-118-683.spec.ts (probe, reusable);
- comment dumps c682.json and c683.json;
- job and lane logs (*.clean).

## #682 @ 70f879a29f06815d15a48c3c42483667a474d507 — APPROVE 0/0/3
- Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5982917037
- **Delta.** a2051568..70f879a2 changes 2 test files (+11/−9). src and test/utils are byte-identical. Size 2,999 (KEEP 5982690647).
- **Opus B-682-9 closed.** Malformed pages now go through the real `StripeConnectApiService` list → get → fetch → parse path.
  - `check-r75 --mode=range --base=b644198b`: OK at F2 70f879a2, at F3 438d29e6 and at the current fees top #686 b002ec21.
  - At 5937064f the only failure was `as unknown as` +1 in #697 (F4b), which the operator fixed in 1807d4cc.
- **CI.** build-and-test job 111485680844 is red by design: exactly 4 tests in 2 suites (`connectTransfer.updateMany is not a function`). Lint, type-check and build are green, and every other check is green. F4 #684 bbf2eac6 is green (run 37220306306).
- **Carried Cs:** C-682-5, C-682-6, C-682-7.

## #683 @ 438d29e64f24e6f803a578dae56e0140a44d1c52 — APPROVE 0/0/4
- Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/683#issuecomment-5982917163
- **Merge.** b52c1265's tree equals merge-tree(33a9d83b, 70f879a2) = 65514ac8.
- **Fix.** 438d29e6 changes charge-settlement.service.ts only (+29/−13). Size 2,835.
- **Sol B-683-1 closed.**
  - Builder proof: before run 37219928918 (11 fail / 4 controls pass); after run 37219950755 (15/15 plus Sol's F23-117 probe passing). Lane provenance was checked.
  - Opus probe run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222906855 (lane commit 2158b0a1 = 438d29e6 + probe + lane files):
    - P1 control: an awaiting row already in USD;
    - P2: a deferred full refund books 8,000 USD and the recovery is exactly 360;
    - P3: a refund missing its balance transaction stays awaiting;
    - P5: a later refund after the deferred settle books 2,800 / 4,840 and the notice names both totals;
    - P6: two workers race.
    All pass, and the builder's spec passes 15/15 again.
- **Sol B-683-5 closed.** The run-local `run.flagged` means a run never clears its own flag. Residual: a different run's flag can be cleared only under a backward clock step (noted, not a finding).
- **CI.** build-and-test job 111488162329 is red by design: exactly 9 tests in 3 suites (2 + 2 + reconciliation 5 `findMany`). Everything else is green. F4 is green.

## Follow-ups (C)
- **C-683-7 (judged C, probe P4 proves it).**
  - Problem: when the notice write fails and the flag write also fails, `applyAdjustments` resolves. The webhook answers 2xx, so there is no flag, no redelivery and no notice. The log lines at :1672 and :1391 are false in this path.
  - File: src/connect/fees/charge-settlement.service.ts:1388-1393, :1672-1675.
  - Fix rule: `flagForReconcile` returns whether it wrote the flag; when a notice could neither be recorded nor flagged, rethrow so Stripe redelivers. Use P4 as the failing-before test.
  - Note: for a lost dispute this notice is the only coach-facing record.
- **C-683-4 (Opus):** unbounded per-purchase Stripe reads in src/connect/fees/reconciliation.service.ts. Fix rule: bound reads per run and resume from a cursor.
- **C-683-5 (Opus) = Sol C-683-6:** a malformed or incomplete invoice page resets the backfill cursor, charge-settlement.service.ts:1152, :1224-1227, :1233. Fix rule: only a validated terminal page ends the scan; otherwise keep the cursor and log `invoiceBackfillFailed`.
- **C-683-6 (Opus):** the succeeded-only branch, reconciliation.service.ts:350-354, needs 2 unit cases.
- **C-682-5:** first metadata match wins, src/connect/fees/transfer-orchestrator.service.ts:215. Fix rule: scan the full page set; more than one match is uncertain.
- **C-682-6:** the 160-character cut drops trailing words, src/connect/fees/payout-notice-copy.ts:117. Fix rule: shorten by sentence.
- **C-682-7:** `send_abandoned` cause text, src/connect/fees/transfer-orchestrator.service.ts:1213. Fix rule: closed-vocabulary cause code only.

## Operator decisions
1. **C-683-7:** ticket it as C (the default) or pull it into the next fees round. Recommended default: C under FREEZE, fixed in the first post-freeze fees round. It is about 6 lines in F3, with P4 as the failing-before test.
2. **#682 is at 2,999 of 3,000.** Any later change to it must remove lines first.

## HANDOFF
Done 11:10 PDT.
- **State of each PR:**
  - #682 @ 70f879a2: Opus APPROVE 0/0/3.
  - #683 @ 438d29e6: Opus APPROVE 0/0/4.
  - Both are red by design, as verified above. Sol verdicts at these heads were still pending when this was posted.
- **Next:** if either head moves (restack or fix round), a fresh Opus lens runs a merge-only delta check against these heads. The probe file in ops/aud-118/AUD-OPUS-F23-118/ can be replayed.
- **Cleanup:** branch audit/AUD-OPUS-F23-118/683-r15-probe is deleted, and both worktrees are removed.
