# AUD-OPUS-F56-116: Claude Opus 5.5 lens, agent 116 wave. Fees F5 is backend #685 and F6 is backend #686.

Verdicts were posted at 2026-10-04T02:47Z (from `date`). The claims are `lanes116/claims/backend-685-858d3716-opus` and `lanes116/claims/backend-686-7be7d396-opus`. Notes are in `ops/aud-116/AUD-OPUS-F56-116/`: the verdict drafts, the probe spec, the probe log, and the F5/F6 build-and-test logs.

## backend#685 (F5, tests only, 4 files, 67 tests)
- Head: 858d37165662ad83af7c380f5f57700fd3d47afa (base F4 42e9ca13)
- Verdict: APPROVE, A/B/C = 0/0/3. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/685#issuecomment-5975903398
- CI: 10 checks pass, 1 skipping.
  - build-and-test: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511 (720 suites, 12421 tests; all 4 files PASS)
  - Schema parity: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348577 (the first attempt failed on a stale base; it is green now)
- Evidence reuse:
  - 3 files are byte-identical to #627 @ 3a5338d7, which this lens approved in comment 5972040127.
  - `s-fee-r9-paused-sender` changed in round 10 (the B-627-10 describe, lines 452-525). I audited it line by line and it is valid.
  - I re-read all 4 files in full.

## backend#686 (F6, tests only, 3 files, 45 tests)
- Head: 7be7d396dcaab5f62c941a78e6e071ce3518ad28 (base F5)
- Verdict: APPROVE, A/B/C = 0/0/2. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/686#issuecomment-5975903521
- CI: 10 checks pass, 1 skipping.
  - build-and-test: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664774 (723 suites, 12466 tests; all 3 files PASS)
  - Schema parity: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664776
- Tree check passes:
  - `merge-tree(66162285, d23fa317)` = 09de2bffd1b9186b64f840bd9ee4761c4c0f510f, which equals the F6 tree.
  - `git diff 66162285 7be7d396` has the same patch-id as main's `0d33c4d4..d23fa317` (#647).
- Evidence reuse: all 3 files are byte-identical to #627 @ 3a5338d7 (approved). I re-read them in full.

## Probe
- Run: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171892935 (branch `audit/AUD-OPUS-F56-116/686-canary-mutants`, from 7be7d396, adds only the probe spec; red by design)
- Result: 55 failed, 265 passed, 320 total.
- CONTROL: 112/112 green. These are this stack's 7 fee specs, unchanged, each loaded in a fresh module registry.
- Mutants (one production behaviour replaced through a prototype spy):

| Mutant | Tests killed | Where |
|---|---|---|
| TGP fee 2% to 1.9% | 41/74 | r4 17, r5 7, r7 11, renewal 6 |
| Fence always passes | 3/59 | the r4 fence tests. conc, r8 and r9 stay green through defense in depth (CAS, durable op, claim re-proof) |
| No send-start budget | 3/30 | r9 |
| No OR-111-1 forward netting | 7/43 | r4 2, r5 5 |

- Conclusion: the tests pin hand-computed cents and the named protocol rules. None of them is a tautology, and none mocks away the boundary it tests.
- C-685-2 canary: the acceptance test is RED. The logger emitted `could not schedule the transfer re-check transfer=tr-25: AUDIT_CANARY_name_contact_at_example_invalid message`. The control half (lock loss rethrown, nothing sent) is green.

## Findings
- **C-685-1**: first-person coach notice copy.
  - Source: `payout-notice-copy.ts:67,79,93,101` (#682) and `coach-payout-adjustment.hbs:20` (#684). r5 pins the strings at lines 304, 310, 401, 460, 530, 543, 927, 937, 962 and 965.
  - This breaks the owner rule against first person in product copy.
  - Fix: rewrite the copy without "We" and update the r5 expectations in the same change.
- **C-685-2**: `transfer-orchestrator.service.ts:896`. The `scheduleRecheck` catch logs `err.message`. It is reachable from the park after the lock is lost when the park's `updateMany` throws. B-627-10's tests cover only the read-back failure.
  - Fix: log `parkFailureKind(err)` there, and add an r9 canary case for the CAS write throwing.
  - Proven by the probe above.
- **C-685-3 / C-686-2**: the fake `$transaction` in `test/utils/settlement-fakes.ts` (#682) has no rollback. The results in these pieces still hold, because every injection is at the first write or outside a transaction, and r7 installs its own rollback.
  - Fix: snapshot the tables on entry and restore them on throw.
- **C-686-1**: the #686 title and the commit 7be7d396 message name checkout and reconciliation specs that the piece does not contain.
  - Fix: retitle the PR.

## For the operator (items that belong to other PRs; they do not block #685 or #686)
1. Copy (#682 and #684): the coach payout notices and email are first person ("We took", "We will hold", "We paid", "We take it out").
   - Recommended default: one copy-only follow-up PR after the stack merges and before S-FEE goes live. It would change the copy, the template and the r5 expectations together.
   - The alternative is to fold the fix into #682 and #684 now, which would re-trigger T4 audits of 3 pieces.
2. Log hygiene (#682): C-685-2 is the same class as Sol's B-627-10, through a second exit at the same boundary. This lens rates it C: the text is DB-driver text, the values involved are ids, cents and internal codes, and there is no PII on this path.
   - Recommended default: fold it into the planned C-627-10 follow-up PR, with a closed code and a canary test.
   - If Sol's lens treats it as reopening B-627-10, the operator decides between fixing it in the follow-up and fixing it in #682 before merge.
3. Test utility (#682): add rollback to the fake `$transaction`. Optional, in the same follow-up.

## Cleanup
- Worktree `/home/user/workspace/wt/AUD-OPUS-F56-116-1` removed (`git worktree remove --force`).
- Remote branch `audit/AUD-OPUS-F56-116/686-canary-mutants` deleted (`git ls-remote` shows 0 `audit/AUD-OPUS-F56-116/*` branches). The run URL stays readable.
- Nothing was pushed to a PR branch. Nothing was merged. Production and settings were not touched.

## HANDOFF
- backend#685 @ 858d37165662ad83af7c380f5f57700fd3d47afa: Opus APPROVE 0/0/3 (comment 5975903398). CI green (10 pass, 1 skipping). Next: the operator merges the F1-F6 stack per the stack plan once both lenses approve at all heads. The C items go to the follow-up PR.
- backend#686 @ 7be7d396dcaab5f62c941a78e6e071ce3518ad28: Opus APPROVE 0/0/2 (comment 5975903521). CI green (10 pass, 1 skipping). The tree check passes (the tree equals #627 @ 66162285 merged with main d23fa317). Next: the stack merge per the operator. Optionally retitle (C-686-1) before merge.
- If either head moves, a fresh Opus lens does the short delta check against these heads, using this report and the verdicts as its evidence trail.
