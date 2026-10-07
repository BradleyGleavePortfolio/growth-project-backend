AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#813 @ dee67d534ac927c2c87ab0960d50185ed9cb3b5f — VERDICT: APPROVE

A=0 B=0 C=4. CI: green at this head (15 SUCCESS, 1 SKIPPED); mergeable clean. This is a re-review after fix round 1 (c3eae417..dee67d53 is one commit, +45/-46).

**Fix delta (B-813-1, from the other lens; I missed it at c3eae417)**
- At c3eae417, any mention of an exercise name in focus or notes exempted it from the injury filter. "avoid back squat" therefore kept Back Squat for a knee client.
- Now `coachAskedToKeep` requires a keep word (keep, include, add, use, still, want, incorporate, program) in the same clause, before the name, and no negation in that clause (no, not, never, avoid, without, skip, exclude, remove, drop, replace, swap, instead, except, don't, nothing). Clauses split on `. ; , ! ?`, newline and "but".
- Traced by hand:
  - "avoid back squat": swapped.
  - "keep everything except squats": swapped.
  - "add squats but no lunges": squats kept, lunges swapped.
  - "squats are fine": swapped (conservative).
- Every kept row is now named in coach_notes ("Kept at the coach's request despite the client's limitations: X (knee)"), so the coach sees it before assigning.
- The rest of the delta is whitespace and comment compaction in `workout-context.service.ts` and `coach-ai.service.ts`, with no behaviour change. I checked that the same selects, takes and filters are kept.

The earlier analysis at c3eae417 still holds for the unchanged code:

**T4 checks (SAFE 1-12 where this PR touches them)**
1. Consent:
   - `generateWorkoutProgram` still passes `dataSubject: clientDataSubject(clientId, 'coach')` after `assertCoachOwnsClient`, so the client's box-2 grant is required before anything leaves the server.
   - The new signals (check-in energy, soreness and sleep, the wearable sleep average and RHR/HRV trend) are covered by the v4 copy ("your information is sent to Anthropic so ... your coach can use AI drafts about your training").
   - Recovery data is read only while a wearable connection is `connected` and not disconnected.
2. Minimisation, an improvement on main:
   - `serializeContextForPrompt` drops client_id, name/identity, body weight trend, calories, snacks, diet, bio, macros and client workout notes.
   - The gateway's `workoutBlock` drops the name, body weight, height and snacks, and does not even read the coach message row (`take: 0`).
   - `WorkoutContextService` sends enums and numbers only: equipment must pass `ENUM_TOKEN`, and history uses seed ids only, so custom exercise names typed by a client are never sent.
   - Coach style aggregates only the coach's own plans and holds no client data.
3. Tenancy: no change. The callers' checks run first (`assertCoachOwnsClient`, the gateway's `canCoachActOnClient`), and context v2 is read only after them.
4. Human in the loop: no change. Output is still a persisted draft; nothing is applied.
5. Injection: focus and notes still go through `sanitizePromptInput`, and WORKOUT_CONTEXT is JSON of numbers and enums.
6-7. Output safety:
   - `applyProgramSafety` runs server-side before the draft is stored. It swaps any row that loads an injury area to a library swap that loads no other listed area, or drops the row and names it in coach_notes.
   - It clamps sets to 1-10, reps or seconds to 1-3600 and rest to 0-600, trims notes to 200 characters, and caps a day at 14 exercises.
   - A load is kept only for an exercise with a logged weight, at most 105 percent of it.
   - An exercise the coach typed in focus or notes is kept.
   - Context v2 failures fall back to the base context, so the generator never dead-ends.
8-10: no change to metering (`assertBudget` / `recordSpend`), the `assertReady` switch or logging. The new warn line logs the error name only.
- Injury input: mobile never writes `injuries` (only the consultation's T3 enums do, in `consultation-answers.ts:424`). Older free text maps by keyword, otherwise to `other`.

**C (never block)**
- C-813-1: substitutions ignore the client's equipment, as the PR states. The coach reviews every draft. C (edge, deferred to 10k clients).
- C-813-2: if every row of a day loads an injury area and has no safe swap, the day can come back with zero exercises.
- C-813-3: this generator relies on prompt rule 10 for medical claims. Unlike b#809, it has no server-side `stripMedicalClaims` pass on `notes` or `coach_notes`. Main has the same behaviour, and the coach reviews before assigning. Recommended for the AIB-3b follow-up.
- C-813-4: `styleCache` is a process-local Map with a TTL but no eviction (one small entry per coach). C (edge, deferred to 10k clients).
