FIX ROUND 1 (B-PRG4-122, agent 122) — growth-project-mobile#358 @ dc47b4934b1feb5e77d6fc146e48aef3498c66cc — READY FOR AUDIT

**Commits:** b2a02e8 (fix) plus merge dc47b49. The merge brings in #357 @ 670fea75, which carries #356 d38b4a70 and #355 36fd39d9 from B-PRG2-122. The merge was clean, with no conflicts. Size is 8 files, 1,588 lines (grandfathered 3,000; was 1,323).

### Fixed
**Opus B-358-2 = Sol B-358-4: Remove now covers every run** (`ProgramHistoryScreen.tsx`)
- **Before:** a coach tapped Remove on one run of a client who has two runs or a package copy. The dialog counted only that run, while the server deletes the not-started workouts of every run.
- **One row per client:** the History list now has one row and one Remove button per client, with that client's runs listed under the name.
- **Confirmation:** it says that every run of the program on the client's plan, including copies delivered by a package, loses the workouts not yet started, and that started and finished workouts stay. It says the removal cannot be undone.
- **Count:** the dialog shows "Up to N upcoming workouts" only when every page is loaded. N is the client's sum across runs, and it is a ceiling because started workouts stay. If more pages are still to load, no count is shown.
- **After success:** the screen shows the server's own `removed_workouts` / `kept_workouts`.

**Sol B-358-3: no client names or package titles in failure telemetry**
- **Before:** any failed removal or package attach on a flaky network sent the client's name or the package title to Sentry in `extra.action`.
- **Now:** the action text is fixed copy, "remove this client from the program" and "add the program to this package" (`ProgramHistoryScreen.tsx`, `ProgramPackagesScreen.tsx`).

**Tests:** the new `src/screens/coach/programs/__tests__/programHistoryRemove.test.tsx` has 5 tests:
- a two-run client gets one Remove, and the scope copy says "Up to 7";
- no count is shown while more pages are still to load;
- the server's totals are shown after removal;
- no client name reaches the telemetry capture;
- no package title reaches the telemetry capture.

### Verified, fixed elsewhere
**Opus B-358-1 (Assign roster capped at 20):** fixed in #355 by B-PRG2-122 and now present in this stack. Its test "pages past the first 20 clients" passes in lane run 37388378121.
- The replayed Opus probe `opusP34Roster.probe.test.ts` is still red, but because of a harness mismatch, not the defect.
- The probe's fake `getClients(status, {cursor, take})` takes an options object. The real `coachApi.getClients(status, cursor, take)` (`src/services/api.ts:585`) takes positional arguments.
- So the fake ignores the cursor and returns page 1 again. The fix's repeated-cursor guard then fails the load truthfully instead of showing a partial list.

### Proposed C (edge, deferred to 10k clients), each pending an operator ruling
- **Sol B-358-1** (bulk assign keeps going after the coach leaves the screen): finishing the assignment the coach asked for is the intended result. The account-change variant only happens if the coach signs out and signs in again while a run is going.
- **Sol B-358-2** (a whole-program refusal leaves clients past the first 50 out of Retry): Assign is disabled for archived and empty programs. So this needs 51 or more selected clients plus a program archived from another device, or a 401/429 reply in the middle of the run.
- Opus C-358-1..4 stay follow-ups.

### Evidence
- **PR CI "Typecheck, lint, test": SUCCESS at this head.** https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388181057/job/112026655601
- **Probe replay, lane run 37388378121 at this head plus both lenses' P34 probe files, with tsc:** https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37388378121
  - Result: 35 passed, 10 failed.
  - **Green:** Opus B-358-2; Sol P4 privacy; Sol P4 destructive copy; the new spec; programsFixRound; programsScreens; programsApi.
  - **Red, all ruled or proposed C:**
    - Opus B-357-1 (operator C) and Opus C-357-1 (= Opus B-355-2, operator C);
    - Opus C-357-2;
    - Sol P3 conflict, day picker, duplicate and ownership (proposed C, see #357);
    - Sol P4 lifecycle and completeness (proposed C);
    - the Opus roster harness mismatch above.
- Pre-merge lane run 37387084998 on b2a02e8 gave the same picture.
- Report: ops/reports/B-PRG4-122.md.
