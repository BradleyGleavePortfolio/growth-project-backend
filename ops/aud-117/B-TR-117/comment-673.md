FIX ROUND 7 (restack, merge-only) (B-TR-117, agent 117) — growth-project-backend#673 @ 4ebf2a435c8c7f50ee5baa69836b0aac116e7a29

Restack under the `trials` stack lock: merges T2 fix round 7 (`6ce54002` = T1 `c75002c9` + main `b644198b` incl. #675, the #675 conflict resolution in T2, and its composed-behaviour spec) into T3. No content change in this piece.

| Item | Change | Commit | Evidence |
|---|---|---|---|
| T2 moved `4fa2fe4a` -> `6ce54002` | merge commit, no conflicts; no T3 file is touched by the merged delta | `4ebf2a43` | `git diff 6ce54002 4ebf2a43` equals `git diff 4fa2fe4a 9719cb88` byte for byte (11 files, +2,548 / -8) |
| The #675 conflict T3 inherited from main | resolved in T2 (`650c9ea2`), where the packages files live; T3 changes neither file | — | #672 FIX ROUND 7 (failing-before runs [37179924220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179924220) and [37179934691](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179934691), passing-after [37179946404](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179946404)) |
| T3's own composed gate `test/b-trials-idempotent-create-compose.spec.ts` | its `describeIfComposed` block (skipped while `createIdempotent` was absent from the base) now executes on this tree | — | build-and-test at this head (below); locally 14/14 with T2's new HTTP spec |

Open findings: #673 has no piece verdict yet. The original #656 B findings (Sol B-656-1..7) were closed in #656 fix rounds 4 and 5 (B-656-6, the T3 conflict worker's separate billed-alert receipt, in FIX ROUND 5 `86223987`); nothing unanswered. Carried: C-656-1 (one trial ledger with recurring #680), owed by the trials stack before it lands on a main that has #680; not changed here (see the B-TR-117 report for what T3 needs once #680 lands).

Size: 2,556 changed lines vs T2 (unchanged; under 3,000).

Checks at `4ebf2a43`: every reported check green on this stacked base ([CI run 37179990103](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179990103): build-and-test 12,682 passed / 245 skipped, the same skipped count as T2, so the three formerly skipped composed-gate tests now run and pass; rls-floor-guard, rls-live-tests, mwb-3-live-tests, community-live-tests; npm audit; Schema parity). CodeQL, danger, banned casts and SBOM run only on PRs based on main; H4 deploy-readiness-gate skips by design.

READY FOR AUDIT
