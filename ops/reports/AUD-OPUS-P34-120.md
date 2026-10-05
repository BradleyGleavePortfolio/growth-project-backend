# AUD-OPUS-P34-120 — Opus lens, mobile programs P3 #357 + P4 #358 (first full review)

Job: AUD-OPUS-P34-120, agent 120, lens Claude Opus 5.5. Started 09:28 PDT 10-05 (`date`).

## Status
- Claims: ops/lanes120/claims/mobile-357-b364b9ea-opus, mobile-358-4dcf0aff-opus.
- Heads verified 09:30 PDT: #357 b364b9eaaedfb6d297f55a40e4b6a15ac4d2a381 (base agent115/programs-split-2-builder-undo = #356 40ee678a),
  #358 4dcf0aff2644ff54fc5fe4de2c97751d7ac7cf94 (base agent115/programs-split-3-program-editor = #357).
- Worktree: /home/user/workspace/wt/AUD-OPUS-P34-120-1 (detached at #358 head). Notes: ops/aud-120/AUD-OPUS-P34-120/.
- Phase: code read done; probes being written (see Probes).

## Split fidelity (checked)
- Tree at #358 4dcf0aff == `git merge-tree --write-tree fb76721f 367e6c48` (1361171f): G4 = refreshed #328, no extra edits.
- Every G3/G4 file blob is byte-identical to #328 fb76721f (last dual APPROVE; Opus 5972129377). Evidence reuse is allowed but this job
  asked for a first full review, so every line was read again; findings below are new.
- #358 merges cleanly with mobile main cc4ceeed (merge-tree 0cb15e98, no conflicts; main touched no Programs/navigation file).

## Findings (draft, being proven)
- B-357-1 ProgramDayPickerScreen.tsx:79-110 — one key for different bodies on the same route.
- B-358-1 programsApi.ts:320-343 (G1 code) consumed by ProgramAssignScreen.tsx — roster capped at the backend default page of 20.
- B-358-2 ProgramHistoryScreen.tsx:53-91,116-141 — per-run Remove deletes every run's upcoming workouts; dialog counts one run.
- C list in progress.

## HANDOFF
- In progress: probes not yet run, verdicts not yet posted. Next: run probes in a mobile CI lane, post verdicts on #357 and #358.
