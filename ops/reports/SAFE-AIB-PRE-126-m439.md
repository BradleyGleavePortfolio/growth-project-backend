SAFETY PRE-PASS (SAFE-AIB-PRE-126) — growth-project-mobile#439 @ 63417260fae82291539cadc3dcdf88b8c0b81bf1 — 2 blockers

Not a verdict; the lenses decide. Read at the head above against backend b#809 c0984e2a and main 2df556b7 (b#808 merged). Plan section 2, SAFE 1-12: no EXPO flag, entry hidden only on status 404, label "AI-suggested, coach-approved" shown, no client data sent (no client_id), no purchase wording, haptics guarded. Both blockers are contract mismatches with the backend; the mobile tests mock the planned shape, so CI passes.

**B1: Apply succeeds on the server, but the app says "Your workout is unchanged."** A coach taps Apply; the server edits the workout, but the app shows "The AI reply arrived in a format this app version cannot read. Your workout is unchanged.", keeps the old rows, and a second Apply is refused.
- `src/api/aiBuilderApi.ts:40-41`: `materialised_ref` must be an object or null. The backend (main and b#809) returns the Prisma `AiActionDraft` row, whose `materialised_ref` is the plan id STRING (`ai-approval.service.ts:467`; the edit materialiser writes the plan id). zod fails -> `contract` -> `onApplied` never runs. `aiBuilder.test.tsx:82` mocks an object.
- Smallest fix: `materialised_ref: z.union([RefSchema, z.string()]).nullable().optional()` and map a string to `null` so the screen takes its existing re-read path (`runReplayRefetch`). Works with today's backend and with b#809 if it later returns the plan section 3 object.

**B2 (flip-blocking U): Shorten, Explain and any reorder or rename always fail.** A coach taps Shorten (or Explain, or asks to reorder) and always gets the "format this app version cannot read" error.
- `aiBuilderApi.ts:29` requires `exercise`, `:34` requires a non-empty `draft_id`. b#809 sends `exercise: null` for every remove, reorder and plan_meta change (`workout-diff.validator.ts:147`) and `draft_id: null` for Explain (no draft is written). One such change fails the whole proposal.
- Smallest fix: `exercise: ExerciseSchema.nullable()`, `draft_id: z.string().min(1).nullable()`; `AiBuilderSheet.tsx:38,41` fall back to a kind label ("New order", "Workout details") when `exercise` is null; with `draft_id` null show the summary with Done only (no apply or discard call). Add a test with a remove + reorder + explain response.

U (small): U2 `AiBuilderSheet.tsx:146` shows raw keys ("Using exercise_library, current_workout"); map to labels. U4 a 503 `AI_NOT_CONFIGURED` (provider failure) shows the "paused for maintenance" copy; map that code to the server copy.
C: a sub-coach hits a dead end (backend B4 on b#809; recommended default: the backend hides the entry for sub-coaches via status 404, no mobile change).

SAFE-MWBAI-125 blocker 2 (no app surface) is closed here for saved plans in the builder; client-page and program entries are AIB-6. Full report: ops/reports/SAFE-AIB-PRE-126.md.
