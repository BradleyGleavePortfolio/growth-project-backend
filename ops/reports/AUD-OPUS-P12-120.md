# AUD-OPUS-P12-120 — Opus lens, mobile programs P1 #355 + P2 #356 (first review)

Job: AUD-OPUS-P12-120, agent 120, lens Claude Opus 5.5. Started 09:29 PDT 10-05; verdicts posted 09:56 PDT 10-05.
Claims: ops/lanes120/claims/mobile-355-902c64a6-opus, mobile-356-40ee678a-opus.
Lens notes and probe sources: ops/aud-120/AUD-OPUS-P12-120/ (comment-355.md, comment-356.md, probes/).
Independence: the Sol lens notes and comments for this round were not read before posting.

## Status: DONE

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #355 (P1 data) | 902c64a64156255ce9ce54147db896ac2142a954 | REQUEST CHANGES | 0/3/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/355#issuecomment-5999100428 |
| mobile #356 (P2 builder undo) | 40ee678adf7a70bdfa18c49cafdbd64a2dc589a5 | REQUEST CHANGES | 0/2/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/356#issuecomment-5999100681 |

Tier: T4 for both (client PII in roster, idempotent creates, unassign removes client workouts; #356 inherits the stack's tier). Sizes 1,716 / 1,501 are within the grandfathered 3,000 limit, so size is not a failure.
PR CI at the exact heads: #355 Typecheck, lint, test success plus CodeQL success; #356 Typecheck, lint, test success. #355 is BEHIND main but merges cleanly with no overlapping files. Heads were re-read after posting and had not changed.

## Findings

### #355
- **B-355-1** `eas.json:58-59` turns on EXPO_PUBLIC_FF_MWB_PROGRAMS and EXPO_PUBLIC_FF_MWB_AUTOSAVE in the clinic profile, but the backend cannot serve them yet:
  - The backend flags and secret are unset (`fly-env-desired-state.json:36-43`, :96). The autosave 404 lands in `useAutosave.ts:984-1000` as 'offline', and the pill then says "Offline — saved on device, will sync", which is false.
  - Even with the flags on, HttpExceptionFilter strips `head_revision_index` and `lock_token` from the `autosave_lock_stale` 409, so the bootstrap first save can never complete (probe P355-B).
  - Fix rule: drop the flips from this PR. Flip them in their own PR only after the backend fix below ships and the backend flags are on.
- **B-355-2** `programErrors.ts:37-43`: the withIdempotency in-flight 409 ("Request in progress — retry in a moment", error "Conflict", no code) is classified as definite. The #357 form then drops the key, and the next tap creates a duplicate program (probe P355-A). Fix rule: treat a 409 with no known code as outcome-unknown, keep the key and body, and show the "still finishing" copy.
- **B-355-3** `programsApi.ts:320-342`: `assignableClients` makes one call to GET /coach/clients, which caps at 20 rows by default (backend `coach.service.ts:155`). The bulk-assign picker silently shows 20 of 25 (probe P355-C). A body that is not an array also returns `[]` with no error. Fix rule: page with take=50 and the cursor up to a bounded cap, and fail closed when the list is incomplete.

### #356
- **B-356-1** `workoutAutosaveApi.ts:236-240,505` together with the backend HttpExceptionFilter: the `undo_head_moved` body arrives without head or token, so `headMoved` stays undefined and the screen says "nothing was undone. Tap Undo again." (probes P356-A, P356-C, P356-D). As a result:
  - a lost-response retry after an undo that did commit reports nothing undone;
  - a head moved by another session leaves the coach in a loop.
  - Fix rule: the backend carries the fields (see the operator decision below), and the app never treats an `undo_head_moved` without a payload as a definite refusal.
- **B-356-2** `CoachWorkoutBuilderScreen.tsx:1380-1387`: on Check again, a definite refusal of the retry (401/403/404/429/plain 409) is reported as "nothing was undone" and editing reopens (probe P356-B). Fix rule: on a retry, only a 200 or a parsed head-moved answer settles the outcome; any other answer keeps the 'unconfirmed' gate.

## Probes (CI lanes; probe specs only, on branches cut from the exact heads; all failed as expected against the defects)
- Mobile #355: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343148250. P355-A and P355-B fail; the control `programErrors.test.ts` passes.
- Mobile #355 roster: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37344236942. P355-C observed "20 of 25 clients". (Run 37343980643 had a probe syntax error and is superseded.)
- Mobile #356: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343202834. P356-A, B, C and D fail; the control `coachWorkoutBuilderUndo.test.tsx` passes. P356-A observed kind conflict, headMoved null, unknown false.
- Backend production f48267f9: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343254265. The real service exception passed through the real HttpExceptionFilter gives the undo 409 body `{statusCode, code, message, error, timestamp, path}` and the autosave 409 body `{statusCode, message:"Conflict Exception", error, timestamp, path}`; head and token are absent from both. The control spec `mwb-undo-head-fence.spec.ts` passes.
- Backend main ee55f814: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343228885. Same result as production.

## Follow-ups (C)
- C-355-1 `src/utils/programErrors.ts:46-49`: the programs_unavailable copy says "Your existing templates still work", but #358 `CoachNavigator.tsx:601` replaces the templates route when the flag is on. Fix rule: claim only what is true.
- C-356-1 `src/screens/coach/CoachWorkoutBuilderScreen.tsx:1369`: on a retry, head === expectedHead + 1 is read as 'applied' even when another session saved exactly once. Fix rule: confirm against the refetched head revision, or a server replay, before claiming the undo applied.
- C-356-2 `CoachWorkoutBuilderScreen.tsx:745-746,1412`: the render-assigned `autosaveHasPendingRef` is read right after `await autosave.flush()`, so a stale true can show a spurious HISTORY_WAIT_FOR_SAVE. Fix rule: flush resolves with the pending state.
- C-356-3 `src/screens/coach/workoutBuilderUndo.ts:61-81`: a 408 counts as definite here but as unknown in `programErrors.ts:42`. Fix rule: treat 408 as unknown in both.
- Outside this entry (for the operator, backend): every backend MWB spec reads `exception.getResponse()` directly, and none goes through HttpExceptionFilter. The autosave 409s at `workout-builder-autosave.service.ts:209-223` set no `code`.

## Operator decisions
1. **Backend contract fix (required for B-355-1 and B-356-1).** Open a backend PR that:
   - adds `code` to the `autosave_lock_stale` and `autosave_conflict_retry` 409s;
   - adds allowlist entries in `src/filters/error-details.ts` for `autosave_lock_stale`, `autosave_conflict_retry` and `undo_head_moved`, with `head_revision_index` an integer ≥ 0 and `lock_token` matching `/^[0-9a-f]{16}$/`;
   - includes an HTTP-level spec through HttpExceptionFilter.
   Recommended default: yes, T4 backend lane. The mobile builder autosave cannot work without it, and this is pre-existing MWB-4 behaviour on main.
2. **Flag order.** Recommended default: remove the clinic eas.json flips from #355 now. A separate one-line mobile PR flips them after the backend fix has deployed and FEATURE_MWB_TEMPLATES, FEATURE_MWB_AUTOSAVE_UNDO, FEATURE_NAMED_REGIMES and MWB_AUTOSAVE_LOCK_TOKEN_SECRET are on (MERGE_DEPENDENCY_GUIDE rule 5).
3. **Later pieces.** #357 and #358 consume the #355 helpers (`isOutcomeUnknown` and `assignableClients`), so their lenses should re-check those helpers after the fix. Recommended default: fix in #355 and rebase the stack.

## Cleanup
- Worktrees `wt/AUD-OPUS-P12-120-1`, `-2`, `-be1` and `-be2` removed. Remote branches audit/AUD-OPUS-P12-120/{355-1,355-2,355-3,356-1} (mobile) and {be1-1,be2-1} (backend) deleted. Local probe branches deleted. Run logs remain at the URLs above.
- No PR branch was pushed, nothing was merged or deployed, no lockfile was edited, and no money was spent.

## HANDOFF
- Both verdicts are REQUEST CHANGES at the exact heads above, with zero A findings.
- The next round needs new heads on #355/#356 after the fixes (B-355-1..3, B-356-1..2) and the backend contract PR (operator decision 1).
- Re-review must re-run the probes in ops/aud-120/AUD-OPUS-P12-120/probes/ against the new heads. The `deployedHeadMoved` and `autosave_lock_stale` envelopes should be updated to whatever body the fixed backend actually sends.
