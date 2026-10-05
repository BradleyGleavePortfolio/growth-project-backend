# AUD-OPUS-P34-120 — Opus lens, mobile programs P3 #357 + P4 #358 (first full review)

Job AUD-OPUS-P34-120, agent 120, lens Claude Opus 5.5. Started 09:28 PDT 10-05, verdicts posted 09:53 PDT (times from `TZ=America/Los_Angeles date`).
The Sol lens notes and comments for this round were not read before posting.

## Result
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#357 (G3: library, form, editor, day and asset pickers) | b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381 | REQUEST CHANGES | 0/1/7 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-5999063942 |
| mobile#358 (G4: assign, history, packages, stack, tab) | 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 | REQUEST CHANGES | 0/2/4 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/358#issuecomment-5999064225 |

Heads were re-read right before posting (09:53 PDT) and had not moved. Both PRs are draft and mergeable clean. PR CI on both heads: "Typecheck, lint, test" passed (runs 37154711217 and 37154713307).

## Split fidelity (checked)
- **Tree match:** the tree at #358 4dcf0aff equals `git merge-tree --write-tree fb76721f 367e6c48` (1361171f). G3 and G4 are #328 refreshed onto main 367e6c48, with no extra edits.
- **Byte match:** every G3 and G4 file blob is byte-identical to #328 fb76721f, the last dual APPROVE (Opus 5972129377).
- **Merge with main:** #358 merges cleanly with mobile main cc4ceeed (merge-tree 0cb15e98). Main touched no Programs or navigation file.
- **Evidence reuse (G09):** no verdict evidence is reused. The #328 rounds, including this lens's APPROVE at dd347633 and fb76721f, missed B-357-1, B-358-1 and B-358-2. All three are raised here for the first time on the same bytes.

## Probes (CI lanes only, no local runs)
- **#357:** branch audit/AUD-OPUS-P34-120/357-probes-1, probe commit 611d3547 on b364b9ea. Run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343560356 finished 4 failed / 7 passed. The probes are red as predicted, and existing programsScreens is green.
- **#358:** branch audit/AUD-OPUS-P34-120/358-probes-1, probe commit b1fc9fa0 on 4dcf0aff. Run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343344938 finished 5 failed / 23 passed. The probes are red, and existing programsFixRound, programsScreens and programsApi are green.
- **Copies:** spec copies are in ops/aud-120/AUD-OPUS-P34-120/probes/ (opusP34G3.probe.test.tsx, opusP34G4.probe.test.tsx, opusP34Roster.probe.test.ts). Lane logs are opus_p34_run357.log and opus_p34_run358.log in the same directory.
- **Control:** "DayPicker Retry of the same pick reuses the key" is green, so the retry design is correct and only the cross-body reuse is wrong.

## B findings
- **B-357-1** `src/screens/coach/programs/ProgramDayPickerScreen.tsx:79-110` (key at :86, kept at :101, rows unlocked at :159/:199).
  - **Problem:** after an unknown outcome on workout A, picking workout B sends B's body with A's key.
  - **Why it matters:** the backend route key `programs:setDay:<p>:<w>:<d>` (program-library.service.ts:680) has no body in it. The completed key replays A (workout-builder.service.ts:233-235), so the screen reports B saved while the day holds A.
  - **Fix rule:** bind the key to row id plus source. A different row gets a new key (the server then answers `program_day_filled` truthfully), or the other rows stay locked behind "Check again". Add tests.
- **B-358-1** `ProgramAssignScreen.tsx:64/318/423` via `src/api/programsApi.ts:320-343` (G1 code).
  - **Problem:** the roster comes from one `coachApi.getClients("active")` call (services/api.ts:584-585, no take or cursor). The backend returns the 20 newest clients (coach.service.ts:155, cap 50 in coach.controller.ts:72; the same on prod f48267f9). Older clients cannot be assigned, and `No clients match "X"` is false.
  - **Fix rule:** page take=50 plus cursor until a short page arrives, with a bounded loop and a visible notice if capped, or use server search. Add a test with more than 20 clients.
- **B-358-2** `ProgramHistoryScreen.tsx:53-91, :116-141`.
  - **Problem:** each copy gets its own row and Remove button, and the dialog counts only that copy.
  - **Why it matters:** `unassignClient` (program-library.service.ts:1462-1497) deletes the not-started workouts of every copy, including package-delivered copies (program-delivery.service.ts:250), and archives all of them.
  - **Fix rule:** one Remove per client with summed counts, truthful scope copy, and the server's removed/kept counts shown after the call. Add a two-run test.

## Follow-ups (C)
- **C-357-1** `ProgramFormScreen.tsx:234-241` + `src/utils/programErrors.ts:37-43`.
  - **Problem:** the in-progress 409 (`{statusCode:409,error:"Conflict"}`, no code; workout-builder.service.ts:232/239) is treated as definite. The key rotates and a second create is possible, despite the copy at :405-406. The probe is red.
  - **Fix rule:** treat a 409 without a known code as unknown (fix in #355 isOutcomeUnknown).
- **C-357-2** `ProgramsLibraryScreen.tsx:60-65`, `ProgramFormScreen.tsx:78`, `ProgramEditorScreen.tsx:125`, `ProgramAssetPicker.tsx:50`, plus the G4 History, Assign and Packages screens.
  - **Problem:** `describeProgramFailure` runs during render, giving one Sentry event and a new reference per render. The probe is red (3 events for 3 renders).
  - **Fix rule:** `useMemo` per error object.
- **C-357-3** `ProgramFormScreen.tsx:74`, `ProgramEditorScreen.tsx:116`.
  - **Problem:** a background refetch error replaces the screen even when data is cached, and form edits are lost.
  - **Fix rule:** show the full-screen failure only when `!data`, and an inline failure otherwise.
- **C-357-4** `ProgramAssetPicker.tsx:24-43`.
  - **Problem:** only the first page is used, with a client-side filter.
  - **Fix rule:** page until done, or add search plus load more.
- **C-357-5** `ProgramEditorScreen.tsx:210-240`.
  - **Problem:** the promote dialog omits that promotion is irreversible, and every 404 maps to the "regimes not switched on" copy (a sub-coach can get "Program not found").
  - **Fix rule:** state permanence, and map only the unavailable code to that copy.
- **C-357-6** `ProgramEditorScreen.tsx:141-158`, :104.
  - **Problem:** Retry of "New workout" does not open the builder.
  - **Fix rule:** run the post-success step on the retry path too.
- **C-357-7** G3 tests.
  - **Problem:** Form tests ship only in #358, and DayPicker and AssetPicker have no tests anywhere in the stack.
  - **Fix rule:** add DayPicker key tests with B-357-1.
- **C-358-1** `ProgramAssignScreen.tsx:183-197`.
  - **Problem:** unknown-outcome chunks are labelled "failed, could not reach the server".
  - **Fix rule:** label them "not confirmed, retry to check".
- **C-358-2** `ProgramPackagesScreen.tsx:142-145`.
  - **Problem:** the hand-rolled price is wrong for zero-decimal currencies, and "Free ($0)" ignores the currency.
  - **Fix rule:** use `formatCurrencyCents` (src/utils/currency.ts:8).
- **C-358-3** `ContentAttachForm.tsx` (Modal :294) + `ProgramUi.tsx:82-83`.
  - **Problem:** "Contact support" inside the attach modal navigates behind the modal.
  - **Fix rule:** close the modal first, or hide the action.
- **C-358-4** `CoachNavigator.tsx` tab swap + programErrors `programs_unavailable` copy.
  - **Problem:** with the mobile flag on and backend FEATURE_MWB_TEMPLATES off (the default), legacy Templates is unreachable while the copy says "Your existing templates still work".
  - This is an operator decision (below).

## For the operator
- **Fix location:** B-358-1's code lives in G1 (#355 programsApi.ts). Tell the #355 lenses and builder that the fix may land there. The stack lands as one, so a fix in either PR clears it.
- **Same bytes as #328:** all three B findings exist byte-identically in #328 fb76721f, which was dual-approved.
- **Decision 1:** ship with the clinic `eas.json` mobile flag on only if backend FEATURE_MWB_TEMPLATES (and the autosave and regimes flags) are confirmed on at deploy. Recommended default: keep the flag on, and confirm the backend flags before the build. Otherwise drop the hunk to ship dark.
- **Decision 2:** grade of C-357-1 (duplicate create in a narrow window, with copy that claims it cannot happen). Recommended default: C, fixed alongside the B round.

## Cleanup
- **Worktree:** /home/user/workspace/wt/AUD-OPUS-P34-120-1 removed.
- **Branches:** audit/AUD-OPUS-P34-120/357-probes-1 and 358-probes-1 deleted (0 refs left). The run URLs remain viewable.
- **Untouched:** no push to PR branches, no merge, no deploy, no production access.

## HANDOFF
- **Done:** both verdicts are posted at the exact heads: #357 REQUEST CHANGES 0/1/7 (5999063942) and #358 REQUEST CHANGES 0/2/4 (5999064225).
- **Next:** builder fix round for B-357-1, B-358-1 and B-358-2, with tests, at new heads. Then a lens re-review at those heads, where the probe specs in ops/aud-120/AUD-OPUS-P34-120/probes/ should turn green.
- **Claims:** ops/lanes120/claims/mobile-357-b364b9ea-opus and mobile-358-4dcf0aff-opus can be released.
