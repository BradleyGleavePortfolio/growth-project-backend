Tier: T3 (mobile UI for an AI surface; no money, auth or PII logic on the device)
Why: owner 15:40 "lets build it - world class ... smooth transitions with haptic feedback layered in ... Push it live and ON". This is AIB-5 of AI_MASTER_BUILDER_PLAN.md (tgp-agent-context handoffs/op-125), job B-AIB5-126, head start by HS-AIB5-125 (agent 125). It must be in the 10-07 build.
T4 trigger scan: none on the device. The server owns consent (403 ai_consent_required), tenancy, metering (COACH_AI_BUDGET_EXHAUSTED), the kill switch and approval. The app renders the proposal and sends `accepted_change_ids`. Nothing reaches a client: Apply only changes the coach's own plan (plan section 2 item 4).
T3 trigger scan: new coach surface in CoachWorkoutBuilderScreen. It works against the CURRENT production backend: GET /ai/gateway/workout-builder/status 404 -> entry hidden (the only hide case, plan section 3); state paused and not_configured -> entry visible, sheet shows the paused copy and no prompt (no propose call); no_credits -> the credits copy; status unreadable (network or 5xx) -> entry visible, sheet shows the specific error and Try again (B-AIB5P-126). No EXPO_PUBLIC flag; eas.json unchanged. The entry needs autosave (EXPO_PUBLIC_FF_MWB_AUTOSAVE=true in production and clinic).
Bounded T1: copy strings, haptic intents.
Canonical builder: Claude Opus 5.5 (HS-AIB5-125, agent 125). Agent 126's B-AIB5-126 builder continues on this branch.
Acceptance evidence: the section 6 AIB-5 tests below, all new, so they fail on main. Run locally one file at a time: `aiBuilder.test.tsx` 10/10, `coachWorkoutBuilderUndo.test.tsx` 16/16 (3 new). Full CI runs on the PR.

Size: 792 changed lines after B-AIB5P-126 fix round 2 (was 797) (the plan asked for under 600; _COMMON says under 800). Everything is in one PR so the build gets the whole flow.

## What the coach gets (U-level feature, plan PART 1)
- Workout builder header: an "Ask AI" button. A prompt bar is pinned under the list ("Ask AI to change this workout"; on an empty workout "Describe the workout to build"; on an unsaved new workout "Save this workout first, then Ask AI can change it.").
- Sheet: a 1,000-character prompt and chips (Swap for injury, then the area: knee, shoulder, lower back, hip, elbow or wrist, ankle or foot, upper back or neck; Progress; Deload; Shorten; More volume; Explain). A staged reveal shows the three pipeline stages. Then change cards cascade in (60 ms stagger), each with a kind badge (text plus colour), the name, before -> after ("3 x 8 @ 135 lb -> 3 x 10 @ 115 lb"), the reason, any warnings and a keep switch. Below the cards: "N suggestions removed: <reason>", the screening banner, "Using <context_used>", the label "AI-suggested, coach-approved", and the buttons "Apply N changes" (the count follows the switches) and "Discard". Explain shows the summary and a Done button.
- Apply: before the proposal, pending autosave edits are saved first and the head lock token is sent (left out while only the bootstrap token is held). After Apply, the screen adopts the server head (`materialised_ref.revision_index` + `lock_token`), so the header Undo reverts the AI change like a manual edit. A toast reads "Applied N changes." with an Undo button for 10 s. If there is no lock token, the screen re-reads the plan through the existing edited-elsewhere path and the toast has no Undo.
- States, each with its own copy: out of credits (with the reset date, no purchase wording), no client consent, 409 changed on another screen, 422 no safe change, 503 or status paused ("Ask AI is paused for maintenance. Your workouts are unchanged."), 429, network, contract, server. No first person, emojis, exclamation marks or generic errors.
- Fun layer: chip = light, keep switch on = selectionAsync, off = warning, send = medium, each card = one light tick (at most 5), Apply = success, Discard = warning, toast Undo = medium, error = error. Reduce Motion: the sheet fades instead of sliding and the cards have no stagger or slide. Every control has a screen-reader label.

## B-AIB5P-126 round (agent 126): paused state, never hidden
- U1: a coach opens the builder while the server switch is still off (status `not_configured`) and the sheet said "Ask AI is not set up on this account yet.", which is false (it is a server switch, not the account). Now it shows "Ask AI is paused for maintenance. Your workouts are unchanged.", the same as `paused`.
- U2: a coach on a weak connection opens the builder, the status read fails, and the sheet showed the prompt as if Ask AI were on, with no way to re-check. Now the entry stays visible and the sheet shows the specific line (for example "No connection. ...") with a Try again button that re-reads the status.
- Propose sends no `lock_token` until the builder holds a real head token (none, empty or the bootstrap token are all left out); backend b#809 accepts that.
- Only a 404 from the status route hides the entry (unchanged).
- Specs: aiBuilder.test.tsx (+2: paused/not_configured each show the paused copy with no prompt, chips or propose; network -> retry -> prompt; no-lock-token propose folded into the Discard case), coachWorkoutBuilderUndo.test.tsx (paused and not_configured visible, tap shows the paused copy, no propose; network keeps the entry with a retry).

## B-AIB5P-126 round 2: the real b#809 shapes (SAFE-AIB-PRE-126 B1, B2)
- B1: a coach taps Apply, the server edits the workout, but the app read the approve reply (the AiActionDraft row, `materialised_ref` = the plan id STRING) as a format error and kept the old rows. Now a string ref maps to null and the screen re-reads the plan; toast "Applied N changes." (no Undo until the backend returns the section 3 object, which is still accepted and adopted).
- B2: a coach taps Shorten or Explain, or asks for a reorder, and always got the format error. b#809 sends `exercise: null` for remove/reorder/meta and `draft_id: null` for explain. Now both nullable: removed cards show the exercise name (resolved from `before.exercise_external_id`), reorder "New order", meta "Workout details"; explain shows the summary and Done with no apply or reject call.
- U: `context_used` keys read as words ("Using your exercise library, this workout"); 503 `AI_NOT_CONFIGURED` (model did not answer) shows the server copy, not "paused for maintenance".
- Specs use the exact b#809 shapes (PlanExerciseSnapshot `before`, AiActionDraft row on approve, explain with `draft_id: null`).

## B-AIB5P-126 fix round 2: B-439-1 (Sol lens) and the b#815 approve shape
- B-439-1: a coach applies an AI change, the reply is the plan id only, and after the reload the builder still showed the old sets with Save blocked (runReplayRefetch bumped the adoption sequence before the GET, so the cached plan was adopted and the fresh one ignored). Now the screen awaits `refetchPlan()` and adopts that result directly: with a head token (b#815 `materialised_ref { plan_id, revision_index, lock_token }`) it adopts the head and the toast offers Undo; with no token (b#809 string, or no lock_token) the fresh copy becomes the autosave baseline and the undo history resets. Only a failed read uses the refresh path.
- Shapes accepted: approve `materialised_ref` string or object (lock_token optional, 16-hex); `exercise` null (b#809 c0984e2a) or an object with `id: ''` and a label (b#809 8b82ead8); `draft_id: null` for Explain.
- Screen regression: cached pre-Apply plan during a deferred GET, fresh plan after; the new sets show and Save sends them (fails on 030e5721).

## Contract notes for AIB-2 / AIB-4 (backend)
- Approve response today: the AiActionDraft row, `materialised_ref` = plan id string (handled: re-read). **Recommended: AIB-2 returns `materialised_ref: { plan_id, revision_index, lock_token }`** (lock-token.helper) so the toast Undo is offered at once; the app already adopts that shape.
- Propose: `lock_token` is optional (it is left out until the builder learns the real token); `client_id` arrives with AIB-6.
- Budget exhausted: 402 or 403 with `code: COACH_AI_BUDGET_EXHAUSTED` and `budget.period_end` both map to the credits copy.

## Checklist (agent 126 continues here)
### Done
- [x] `src/api/aiBuilderApi.ts`: zod-parsed status / propose / apply (accepted_change_ids) / discard; status 404 -> null; one code per refusal
- [x] `src/components/coach/ai-builder/aiBuilderCopy.ts`: all state copy, stages, chips, row format
- [x] `src/components/coach/ai-builder/useAiBuilder.ts`: status, staged reveal, prepare (autosave flush + lock token), keep toggles, apply, discard, haptics
- [x] `src/components/coach/ai-builder/AiBuilderSheet.tsx`: sheet + change cards, Reduce Motion
- [x] CoachWorkoutBuilderScreen hunk: header Ask AI, pinned prompt bar, adopt after apply + undo step, toast with Undo
- [x] Tests (section 6 AIB-5): 404 -> no entry; paused -> visible + copy; cards kind/before/after; toggles change Apply N; Apply sends accepted ids; Discard rejects; toast Undo calls the undo route; 402/403 budget, 403 consent, 409, 422 copy; haptics success/warning/light/error; Reduce Motion -> no stagger
- [x] Existing builder specs mock status 404 (unchanged behaviour)
- [x] B-AIB5P-126: not_configured reads as paused; unreadable status keeps the entry with Try again; propose without lock_token
- [x] B-AIB5P-126 round 2: approve row string ref, nullable exercise and draft_id (b#809 c0984e2a), context labels, AI_NOT_CONFIGURED copy

### Remaining (later PRs, plan cut line)
- [ ] AIB-6: client context (`client_id`, "Using Sam's ..."), library / program week / client page entry points, revision history with the "AI-suggested, coach-approved" author chip
- [ ] Sparkle icon on the header button (text label only today)
- [ ] Owner device tap-through once AIB-2/AIB-4 are deployed (the stub provider is enough)

### Next step
Head 63076852ff2c957333666a94a1f5d61c8a4424ef (B-AIB5P-126 fix round 2, main ad08af9b merged in), CI green (Typecheck, lint, test 648 suites / 8696 tests + CodeQL). Next: the dual lenses review this exact head, then the operator merges before the 10-07 build (plan: merge AIB-5 by 20:30; deadline 09:30). Files: src/api/aiBuilderApi.ts, src/components/coach/ai-builder/{aiBuilderCopy.ts,useAiBuilder.ts,AiBuilderSheet.tsx,__tests__/aiBuilder.test.tsx}, src/screens/coach/CoachWorkoutBuilderScreen.tsx, src/__tests__/coachWorkoutBuilder{Undo,Autosave,RowIdAdoption}.test.tsx.



