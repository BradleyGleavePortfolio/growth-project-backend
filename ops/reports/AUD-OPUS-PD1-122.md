# AUD-OPUS-PD1-122 — Opus lens: programs m#355-#358 delta + backend b#733 first review (agent 122)

Lens Claude Opus 5.5. Started 16:33 PDT 10-05, verdicts posted 16:46 PDT (45-minute time box, ends 17:18). Times come from `TZ=America/Los_Angeles date`.
The Sol lens's notes and comments for this round were not read before posting.
Claims are in ops/lanes122/claims/: mobile-355-36fd39d9-opus, mobile-356-d38b4a70-opus, mobile-357-670fea75-opus, mobile-358-dc47b493-opus and backend-733-635cabee-opus.

## Status: DONE

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #355 | 36fd39d9eea8f4603358734a3e6c53905310992d | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-6005712020 |
| mobile #356 | d38b4a7045da9c8aa0bec262adba2428dc8da287 | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-6005712237 |
| mobile #357 | 670fea7555e0621d475455d8f8490b0ac6f28c6d | APPROVE | 0/0/8 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-6005712547 |
| mobile #358 | dc47b4934b1feb5e77d6fc146e48aef3498c66cc | APPROVE | 0/0/4 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-6005712898 |
| backend #733 | 635cabeeae1c3e74dd3f9311e5a059680e917628 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/733#issuecomment-6005713155 |

All heads were checked just before and just after posting, and none had moved.

PR CI is green at every head:
- Mobile: Typecheck, lint, test on all four PRs, plus CodeQL on #355.
- Backend #733: build-and-test, mwb-3-live-tests, rls-live-tests, community-live-tests, CodeQL, banned casts, schema parity, danger, npm audit, sbom and size-label.

Sizes are within their limits: #355 1,953, #356 1,585, #357 2,421 and #358 1,588 against main or their base (grandfathered limit 3,000); #733 464 (1,500 rule).

## Prior Opus Bs: all closed
- **B-355-1 / B-356-1 (end to end with b#733):**
  - The clinic eas.json flips are removed; eas.json equals main across the whole stack.
  - The mobile parses the real #733 409 bodies: the envelope plus `head_revision_index` and `lock_token`, with code equal to error. Schema is not strict, and the cause comes from code or error.
  - In probe PD1-4, the first save of a session (placeholder token) adopts the head and token from the exact #733 `autosave_lock_stale` body and ends `saved`, using the real parser and the real hook.
  - A bare `undo_head_moved` is now unknown, so editing pauses at Check again.
- **Roster capped at 20 (B-355-3, Sol B-355-1, Opus B-358-1):** judged by the real call `getClients(status, cursor, take)` against the backend paging contract. PD1-3 returns every client for 1, 19, 20, 21, 25, 45 and 60 clients. A failed page or a reply that is not a list fails the load with specific copy.
- **B-356-2:** on Check again, only a 200 or a parsed head move settles the outcome; any other answer keeps the gate. A 401 gets sign-in copy.
- **B-358-2:** one Remove per client. The dialog states the true scope (every run, including package copies), gives "Up to N" summed across runs only when every page is loaded, says it cannot be undone, and shows the server's removed and kept counts afterwards.
- **Sol B-358-3:** no client name or package title reaches Sentry action text. A grep of every `describeProgramFailure` call confirms it.
- **Operator rulings, not re-raised:** B-355-2 and B-357-1 are C.

## Merge checks (git merge-tree)
Every merge commit's tree equals its merge-tree result, so no merge resolved a conflict:

| Merge | PR | Parents | Tree |
|---|---|---|---|
| df981c1 | #355 | 902c64a6 + main 203e80e3 | eb1a527f |
| 95aeeeb | #356 | 40ee678a + 36fd39d9 | 9b95d2ae |
| 670fea75 | #357 | b364b9ea + d38b4a70 | 456d4626 |
| dc47b493 | #358 | b2a02e8 + 670fea75 | 7295508b |

The 7 P3 files at #357 are byte-identical to b364b9ea.

## Probes (one CI lane, no local runs)
- **Lane run:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389877384, on stack top dc47b493 plus probes, branch audit/AUD-OPUS-PD1-122/1 (now deleted).
- **Result:** 76 of 77 tests passed.
- **Green:**
  - new probes PD1-1..3 (opusPD1Contract) and PD1-4 (opusPD1Bootstrap);
  - the strengthened B-358-2 probe (opusPD1History);
  - the replayed P356-B and P356-C;
  - the controls programsApi, workoutAutosaveApi, programHistoryRemove and coachWorkoutBuilderUndo.
- **The one red:** the replayed P356-D. Its harness expects a second identical request, but the fixed screen now pauses at Check again instead of looping, which is the intended behaviour.
- **Files:** sources are in ops/aud-122/AUD-OPUS-PD1-122/probes/, the log is ops/aud-122/AUD-OPUS-PD1-122/lane-1.log, and the comment sources are ops/aud-122/AUD-OPUS-PD1-122/comment-*.md.

## Cs (carried or ruled; no new Bs)
- #355: C-355-1 (the programs_unavailable copy says "Your existing templates still work").
- #355: the autosave pill copy when a 409 lacks head or token (operator ruling).
- #356: C-356-1..3; the Sol race and 408 findings (ruled); the P356-D harness note.
- #357: B-357-1 (ruled); C-357-1..7; Sol B-357-1..4 (ruled).
- #358: C-358-1..4; Sol B-358-1 and B-358-2 (ruled).
- #733: the P2034 plain 409 (ruled); the "Conflict Exception" message, which never reaches users because the app shows its own copy.

## Operator decisions (recommended defaults)
1. **Landing order.** Recommended default:
   - merge and deploy b#733 first;
   - then turn on backend FEATURE_MWB_AUTOSAVE_UNDO and MWB_AUTOSAVE_LOCK_TOKEN_SECRET (plus FEATURE_MWB_TEMPLATES and FEATURE_NAMED_REGIMES);
   - land the mobile stack #355-#358 as one, under rule 11;
   - only then open the separate one-line clinic eas.json flag PR.
2. **The red replayed P356-D.** Recommended default: count it as a harness expectation, not a defect.

## HANDOFF
- Done. All five verdicts are APPROVE at the exact heads above, with comments posted and verified.
- Cleanup:
  - worktrees wt/AUD-OPUS-PD1-122-m and wt/AUD-OPUS-PD1-122-b are removed;
  - the remote audit/AUD-OPUS-PD1-122/1 branch is deleted;
  - no locks were held;
  - no PR branch was pushed, nothing was merged or deployed, and no money was spent.
- Claims can be released.
- Next: the operator pairs these verdicts with the Sol PD1 verdicts. If both lenses approve with green checks, merge b#733, deploy it, and land the mobile stack as in decision 1.
