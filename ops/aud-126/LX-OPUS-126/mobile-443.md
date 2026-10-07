AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-mobile#443 @ 82d8b2525e8786a5a561172f6c7cebe23245a506 — VERDICT: APPROVE

B=0 U=0 C=3. FIX ROUND 3 head (retargeted to main, merge only). T3 mobile AI builder. CI at this head: "Typecheck, lint, test" SUCCESS; CodeQL and both Analyze jobs SUCCESS. Size 700 changed lines (695 + 5) against main, tests included.

Round 3 (276bec2b..82d8b252) is a merge of origin/main @ 1f9b919a only. Checked: `git diff 1f9b919a 82d8b252` and `git diff 030e5721 276bec2b` are line-for-line identical in all 12 PR files (same 695/-5), so the code reviewed at round 2 below is exactly what lands. m#448 WorkoutsTab hunks merged clean.

Round 2 delta (502205bb..276bec2b; WeekAiSheet.tsx, RevisionHistorySheet.tsx, aiEntry.test.tsx):
- B-443-1 fixed. The kept-state map is keyed by `selKey(day, change_id)` = `${plan_id}:${change_id}`: initial `kept`, the row's `kept` prop, the Switch `onToggle(id)` and `accepted()` all use it. So the `c0`... ids that b#809 restarts in every proposal (validator `change_id: c${changes.length}`) no longer cross days. Each draft's PATCH still gets its own bare ids (`accepted()` maps back to `c.change_id`), and the Apply count `n` follows the per-day keys. React keys stay `change_id` within each day's own container (unique per day). The regression test covers two days that both hold `c0`.
- U-443-1 fixed. RevisionHistorySheet uses `useReduceMotion() ? 'fade' : 'slide'`, the same as the other AI sheets.

Whole PR re-checked against SAFE 1-12 and "What you hunt":
- Entry visibility: week "Ask AI" shows when status is on/paused/no_credits/unreadable and hides only on a 404 status (useAiEntryStatus). Paused/not_configured shows "Ask AI is paused for maintenance. Your workouts are unchanged." and asks nothing.
- Human in the loop and label: nothing changes before Apply; only kept ids are sent per draft. Unkept days are rejected. "AI-suggested, coach-approved" shows in the sheet and in the editor notice. No purchase wording, no first person, no exclamation marks.
- Server side: tenancy, consent and the kill switch are enforced by b#809 propose (plan.coach_id = tenant). Program day plans carry head_revision_id (program-library.service.ts writeDayPlan), so there is no false 409. Main has forbidNonWhitelisted, so until b#815 merges an Apply with `accepted_change_ids` fails loudly with 400 instead of applying unkept changes.
- Revisions sheet matches the b#808 RevisionListItem shape (revision_index, author_kind, cause, created_at, summary); a 404 says so plainly. Client Workouts tab "Build a program for <first name> with AI" opens the existing Coach AI generator; nothing reaches the client before approval.

C (none block):
- C (edge, deferred to 10k clients): drafts proposed before the sheet is closed mid-run stay pending until they expire. No plan changes.
- C: the Workouts tab entry is not gated on Coach AI v1 readiness. An offline engine lands on the existing "AI offline" caption on Summary.
- C: entry status is read once per Program editor mount.
