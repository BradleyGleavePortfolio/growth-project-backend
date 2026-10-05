AUDIT Claude Opus 5.5 — growth-project-mobile#358 @ 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 — VERDICT: REQUEST CHANGES
Lens AUD-OPUS-P34-120, agent 120. First full review of split G4 of #328 (base agent115/programs-split-3-program-editor @ b364b9ea = #357 head).

A/B/C = 0/2/4

**Scope and evidence reuse (G09).** Every line of the 7-file diff was read at this head, with the backend contract read at growth-project-backend main ee55f814 (the roster route is the same on production f48267f9).
- **Split fidelity:** this head's tree equals `git merge-tree --write-tree fb76721f 367e6c48` (1361171f). Every file is byte-identical to #328 @ fb76721f.
- **Merge with main:** this head merges cleanly with mobile main cc4ceeed (no conflicts, and main touched no Programs or navigation file).
- **Reuse:** no verdict evidence is reused from the #328 rounds. Those rounds covered the same bytes and missed B-358-1 and B-358-2, so both are raised here for the first time.
- **Stacked:** this PR cannot land without #357, so B-357-1 (DayPicker key reuse) also gates this stack.

**Probes (CI lane, no local runs):** branch `audit/AUD-OPUS-P34-120/358-probes-1`, probe commit b1fc9fa0 on this exact head, run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343344938.
- **Results:** 5 red as predicted. The existing `programsFixRound`, `programsScreens` and `programsApi` suites are green (23 passed / 5 failed).
- **Specs:** copies are in the ops workspace at `ops/aud-120/AUD-OPUS-P34-120/probes/` (`opusP34Roster.probe.test.ts`, `opusP34G4.probe.test.tsx`).

### B-358-1 — Assign shows at most 20 clients
- **Where:** `ProgramAssignScreen.tsx:64` reads `useAssignableClients()`, which calls `programsApi.assignableClients()` (`src/api/programsApi.ts:320-343`, G1 code). That makes one call to `coachApi.getClients("active")`.
- **Backend:** `GET /coach/clients` returns `take ?? 20` ordered newest first, with a 50 cap and an id cursor (`coach.controller.ts:68-73`, `coach.service.ts:155-156`).
- **What goes wrong:** a coach with 21 or more active clients cannot assign the program to older clients.
  - The screen says "Select all shown (20)" (:318) and `No clients match "X"` (:423) for a real client.
  - This is the stack's core "assign to many" path, and nothing tells the coach the list is partial.
- **Probe:** "returns all 25 active clients when the roster route pages at 20" is red: received length 20.
- **Fix rule:** page `/coach/clients` with `take=50` plus cursor until a short page arrives. Use a bounded loop, and if the bound is hit, show a visible "showing first N" notice. Alternatively, use server-side search.
  - The fix can sit in `programsApi.assignableClients` (#355) or in this PR. The stack lands as one, so either location clears this finding.
  - Add a test with more than 20 clients.

### B-358-2 — Remove is shown per run but deletes every run's upcoming workouts
- **Where:** `ProgramHistoryScreen.tsx:53-91` and `:116-141`.
  - The list has one row per copy (key `client_id:copy_program_id`, :118), each with its own Remove button.
  - The confirmation counts only that copy: `workouts - completed` upcoming, and it counts started workouts as removed.
- **Backend:** `unassignClient` (`program-library.service.ts:1462-1497`) deletes every not-started workout of every copy of this program for that client and archives all copies. That includes copies delivered by a package, because package delivery writes the same `cloned_from_id` copies (`program-delivery.service.ts:1-29`, :250).
- **What goes wrong:** a client has run 1 nearly done and run 2 upcoming (or a package copy). The coach taps Remove on run 1, sees "1 upcoming workout is removed", and the server deletes 13 with no undo.
- **Probe:** "a client on two runs: the confirmation covers every run the server removes" is red. Two Remove buttons are shown and the message is "1 upcoming workout is removed from their plan. 11 finished workouts stay in their history."
- **Fix rule:**
  - Show one Remove per client, with counts summed across that client's copies.
  - The copy should say every run (including package copies) loses its not-started workouts, and started and finished ones stay.
  - After the call, show the server's `removed_workouts` / `kept_workouts`.
  - Add a two-run test.

### Follow-ups (C)
- **C-358-1:** `ProgramAssignScreen.tsx:183-197`.
  - **Problem:** a chunk with an unknown outcome (for example a 30 s timeout on a long program times 50 clients) is marked "failed" with "could not reach the server", although the server may have assigned it. "Retry N failed" with the same key resolves it correctly.
  - **Fix rule:** label these rows "not confirmed, retry to check" rather than failed.
- **C-358-2:** `ProgramPackagesScreen.tsx:142-145`.
  - **Problem:** the price is hand-rolled as `(priceCents/100).toFixed(2)`, which is wrong for zero-decimal currencies, and the label says "Free ($0)" whatever the currency.
  - **Fix rule:** use `formatCurrencyCents` (`src/utils/currency.ts:8`).
- **C-358-3:** `ContentAttachForm.tsx` (Modal at :294, picker block) with `ProgramUi.tsx:82-83`.
  - **Problem:** inside the attach Modal, the picker's FailureBox "Contact support" navigates to SupportInbox behind the open modal, so nothing visible happens.
  - **Fix rule:** close the modal first, or hide the support action inside the modal.
- **C-358-4 (operator decision):** `CoachNavigator.tsx` tab swap.
  - **Problem:** with `EXPO_PUBLIC_FF_MWB_PROGRAMS` on and backend `FEATURE_MWB_TEMPLATES` off (the backend default is OFF), the legacy Templates screen becomes unreachable. Meanwhile the `programs_unavailable` copy (programErrors.ts, G1) says "Your existing templates still work".
  - **Fix rule:** confirm the backend flags are on before shipping any build with the mobile flag on. Otherwise, fall back to the legacy screen on `programs_unavailable`.

APPROVE needs B-358-1 and B-358-2 fixed with tests at a new head, and #357's B-357-1 fixed. The C items can follow.
