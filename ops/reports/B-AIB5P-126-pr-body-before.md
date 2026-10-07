Tier: T3 (mobile UI for an AI surface; no money, auth or PII logic on the device)
Why: owner 15:40 "lets build it - world class ... smooth transitions with haptic feedback layered in ... Push it live and ON". This is AIB-5 of AI_MASTER_BUILDER_PLAN.md (tgp-agent-context handoffs/op-125), job B-AIB5-126, head start by HS-AIB5-125 (agent 125). It must be in the 10-07 build.
T4 trigger scan: none on the device. The server owns consent (403 ai_consent_required), tenancy, metering (COACH_AI_BUDGET_EXHAUSTED), the kill switch and approval. The app renders the proposal and sends `accepted_change_ids`. Nothing reaches a client: Apply only changes the coach's own plan (plan section 2 item 4).
T3 trigger scan: new coach surface in CoachWorkoutBuilderScreen. It works against the CURRENT production backend: GET /ai/gateway/workout-builder/status 404 -> entry hidden (the only hide case, plan section 3); state paused / no_credits / not_configured -> entry visible with its own line. No EXPO_PUBLIC flag; eas.json unchanged. The entry needs autosave (EXPO_PUBLIC_FF_MWB_AUTOSAVE=true in production and clinic).
Bounded T1: copy strings, haptic intents.
Canonical builder: Claude Opus 5.5 (HS-AIB5-125, agent 125). Agent 126's B-AIB5-126 builder continues on this branch.
Acceptance evidence: the section 6 AIB-5 tests below, all new, so they fail on main. Run locally one file at a time: `aiBuilder.test.tsx` 10/10, `coachWorkoutBuilderUndo.test.tsx` 16/16 (3 new). Full CI runs on the PR.

Size: 797 changed lines (the plan asked for under 600; _COMMON says under 800). Everything is in one PR so the build gets the whole flow.

## What the coach gets (U-level feature, plan PART 1)
- Workout builder header: an "Ask AI" button. A prompt bar is pinned under the list ("Ask AI to change this workout"; on an empty workout "Describe the workout to build"; on an unsaved new workout "Save this workout first, then Ask AI can change it.").
- Sheet: a 1,000-character prompt and chips (Swap for injury, then the area: knee, shoulder, lower back, hip, elbow or wrist, ankle or foot, upper back or neck; Progress; Deload; Shorten; More volume; Explain). A staged reveal shows the three pipeline stages. Then change cards cascade in (60 ms stagger), each with a kind badge (text plus colour), the name, before -> after ("3 x 8 @ 135 lb -> 3 x 10 @ 115 lb"), the reason, any warnings and a keep switch. Below the cards: "N suggestions removed: <reason>", the screening banner, "Using <context_used>", the label "AI-suggested, coach-approved", and the buttons "Apply N changes" (the count follows the switches) and "Discard". Explain shows the summary and a Done button.
- Apply: before the proposal, pending autosave edits are saved first and the head lock token is sent (left out while only the bootstrap token is held). After Apply, the screen adopts the server head (`materialised_ref.revision_index` + `lock_token`), so the header Undo reverts the AI change like a manual edit. A toast reads "Applied N changes." with an Undo button for 10 s. If there is no lock token, the screen re-reads the plan through the existing edited-elsewhere path and the toast has no Undo.
- States, each with its own copy: out of credits (with the reset date, no purchase wording), no client consent, 409 changed on another screen, 422 no safe change, 503 or status paused ("Ask AI is paused for maintenance. Your workouts are unchanged."), 429, network, contract, server. No first person, emojis, exclamation marks or generic errors.
- Fun layer: chip = light, keep switch on = selectionAsync, off = warning, send = medium, each card = one light tick (at most 5), Apply = success, Discard = warning, toast Undo = medium, error = error. Reduce Motion: the sheet fades instead of sliding and the cards have no stagger or slide. Every control has a screen-reader label.

## Contract notes for AIB-2 / AIB-4 (backend)
- Approve response: `materialised_ref: { plan_id, revision_index, lock_token? }`. **Recommended: AIB-2 returns `lock_token`** (lock-token.helper) so Undo is offered at once.
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

### Remaining (later PRs, plan cut line)
- [ ] AIB-6: client context (`client_id`, "Using Sam's ..."), library / program week / client page entry points, revision history with the "AI-suggested, coach-approved" author chip
- [ ] Sparkle icon on the header button (text label only today)
- [ ] Owner device tap-through once AIB-2/AIB-4 are deployed (the stub provider is enough)

### Next step
Head c138b4c4803e536bfd29f3e4c0e82ccec770ad08, CI green (Typecheck, lint, test + CodeQL). Next: the dual lenses review this exact head, then the operator merges before the 10-07 build (plan: merge AIB-5 by 20:30; deadline 09:30). Files: src/api/aiBuilderApi.ts, src/components/coach/ai-builder/{aiBuilderCopy.ts,useAiBuilder.ts,AiBuilderSheet.tsx,__tests__/aiBuilder.test.tsx}, src/screens/coach/CoachWorkoutBuilderScreen.tsx, src/__tests__/coachWorkoutBuilder{Undo,Autosave,RowIdAdoption}.test.tsx.

