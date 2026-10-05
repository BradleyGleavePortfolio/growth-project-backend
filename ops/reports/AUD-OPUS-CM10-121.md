# AUD-OPUS-CM10-121 — Claude Opus 5.5 lens, coach stack delta at FIX ROUND 6 heads (agent 121)

- Started 12:38 PDT 10-05. Verdicts posted 13:19 PDT.
- Claims: lanes121/claims/backend-{674-3a07a0de,676-fadb2960,677-e3940bd0,703-ebde8b3b}-opus (left in place).
- Notes, probe, logs, verdict bodies: ops/aud-121/AUD-OPUS-CM10-121/.
- Independence: the Sol lens's CM10 notes and comment bodies were not read. Only first lines were listed, to confirm the heads.

## Verdicts (heads re-read 13:19 PDT, unchanged)

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #674 | 3a07a0de45f431ca9f1f5b9a2ff1710d554e52cb | APPROVE | 0/0/9 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-6002223519 |
| #676 | fadb2960bdce1c1b700eafc1f9da02c520ea021f | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/676#issuecomment-6002223736 |
| #677 | e3940bd0aa4f306b5da0ddf707017a33b73de5ed | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/677#issuecomment-6002223936 |
| #703 | ebde8b3b5b499f40974c3f32dc925618c81d2c89 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/703#issuecomment-6002224142 |

## Evidence
- **#674 delta** (e35c37a1..3a07a0de; 3 commits, 4 files, +55/-47; size 2,995 of 3,000):
  - B-674-15 (this lens): the own-operation loop now runs before `owedHeadCoachReversal` (:1341-1366). It covers the refund key, `-review` and `-found-*`.
  - B-674-1: the slice mirror is in the recording transaction (orchestrator :1134, :1441, :1449).
  - B-674-16: the stamp happens before every attempt (:974-979).
  - All required checks are green.
- **#676:** a clean merge; its tree equals the merge-tree. Its own +/- content is identical to the approved own diff, and 20/21 blobs are identical. The 21st, stateful-prisma, differs only by #674's hunk.
- **#677:** a clean merge; 6/6 own blobs identical.
- **#703:** a clean merge plus one new spec (11 cases); 7/8 own blobs identical; size 1,291. File: treecheck.txt.
- **CM8 probe replay in CI** (this lens checked both run logs on GitHub and that the probe blobs are identical):
  - builder lane 37355842923 at 3a07a0de: 196/200;
  - builder lane 37355956416 at ebde8b3b: 235/240.
  - Only the obsolete-by-design reds already accepted at CM8 appear. audit-opus-cm8-120-674-reconcile is green 3/3.
- **New probe** audit-opus-cm10-121-674-delta.spec.ts (4 cases), run locally with heavy.sh as a single spec (runner incident; _COMMON_121 item 11):
  - 4/4 PASS at ebde8b3b;
  - 4/4 FAIL at e35c37a1, for the intended reasons.
  - Logs: local-delta-probe-*.log.
- **Own lanes:**
  - 37365530831 (#674 alone) was cancelled under the one-lane rule.
  - 37366160113 (stack top, 37 suites) was queued 26 minutes, then cancelled under the 12:47 queue rule.
  - Branches deleted.

## Follow-ups (C)
- C-674-16 refund-dispute-handler.service.ts:1463-1470 / :1487-1495. A refused `-review` operation is sticky (422 forever). Fix: a fresh review key after a refusal, plus copy that names the next action.
- C-674-17:
  - The doc comment at :1299-1307 and runbook row `recorded_from_stripe` (docs/runbooks/refund-transfer-reversal-review.md:25) name only tgp_charge_refund_id.
  - The runbook has no rows for UNCERTAIN, REFUSED, LIST_INCOMPLETE, TOO_MANY or TRANSFER_NOT_IN_STRIPE.
- C-674-18 prisma/schema.prisma:4681. The comment says "latest admitted attempt"; every attempt is now stamped. Comment-only fix.
- C-674-19 :1345-1351. The `startsWith` lookup on idempotency_key cannot use the btree index unless the database uses the C collation. Fix: scope it by the head transfer_id, or use `in: [key, key-review]` plus the `-found-*` rows of that transfer.
- C-674-6 :1570-1600. A list provider error is a generic 500. Fix: a typed 503.
- C-674-7 refund-reversal-admin.controller.ts:38-74. The acting owner is not recorded.
- C-674-9 :1053-1072. A pending transfer reads as nothing_owed.
- C-674-13 :78/:858. The 60 s first-pass heuristic.
- C-641 :1731. Float ratio (release condition).
- C-676-6, C-641-2/C-676-1, C-677-2, C-677-3: unchanged.

## Main merge for #674 (operator question)
- **Not a pure rule-12 carry-over.** main (5da537d6) is 29 commits ahead of merge-base ee55f814. git merge-tree is clean (tree b0ece624), but test/cancel-pending-on-refund.spec.ts is a #674 file that main also changed (B-661-3 helpers and cases; #674's 3-line double sits in another hunk). Rule 12 condition 2 therefore fails.
- **What it needs:** a merge-only round. Both lenses do a short delta: that one file plus CI green.
- **Size:** stays 2,995 after the merge. Main touched no prisma files, so #674's migrations 20270314000000 / 20270317116000 stay ordered after production's 20270311000000.
- **No secret leak:** main's B-SECRETS omit does not interact. Every stack read of ClientPurchase uses an explicit select.

## Operator decisions (recommended default first)
1. **Main merge:** merge main into #674 now as a merge-only round (clean merge), then restack #676 -> #677 -> #703 merge-only. A fast lens pair then checks the one shared test file and CI.
2. **Cs:** after the freeze, take C-674-16/17/18 as one copy/docs PR before launch. C-674-19 is low priority.

## HANDOFF
Done. Four verdicts posted. Lane branches deleted (0 audit/AUD-OPUS-CM10-121 refs). Worktrees wt/AUD-OPUS-CM10-121-{1,2,3} removed and pruned. Claims left in place. Nothing further for this lens at these heads.
