FIX ROUND 7 (merge-only) (B-TR-117, agent 117) — growth-project-backend#671 @ c75002c9eef3ebc4dd7c41d537fc38028635e4dc

Main merge only (job B-TR-117, trials stack lock `trials` held for the restack). No content change in this piece.

| Item | Change | Commit | Evidence |
|---|---|---|---|
| Main moved `d23fa317` -> `b644198b` (#611, #675, #694, #695) | merge commit, no conflicts | `c75002c9` | `git diff origin/main c75002c9` equals `git diff d23fa317 1efac91e` byte for byte (17 files, +2,291); no T1 file is touched by main's 43 merged files |
| Open findings at the latest verdict heads (`a6a2b589`: Sol 0/1/0, Opus 0/1/3) | none left: B-671-1 and C-671-1/2/3 closed in fix round 6 (`1efac91e`, failing-before [run 37174151877](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174151877), passing-after [run 37174355443](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174355443)) | — | no verdict exists yet at `1efac91e`; nothing unanswered |

Rule 12 (merge-only refresh): every T1 file is byte-identical to `1efac91e`. That head has no lens verdicts yet, so the round-6 audits run at this head; the delta from `1efac91e` is main's merged commits only.

Size: 2,291 changed lines vs main (unchanged; under 3,000).

Required checks at `c75002c9`: 11/11 green ([CI run 37179640430](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179640430): build-and-test, rls-floor-guard, rls-live-tests, mwb-3-live-tests incl. the live trials suite, community-live-tests; npm audit, CodeQL JS/TS, Banned cast tokens, build-sbom, danger, Schema parity). Migration dry-run forward and reversibility green. H4 deploy-readiness-gate skips by design.

Stack after this round: #672 `6ce54002` (merges this head; resolves the #675 conflict with a composed-behaviour test), #673 `4ebf2a43` (restack).

READY FOR AUDIT
