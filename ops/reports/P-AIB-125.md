# AI MASTER WORKOUT BUILDER: plan for agent 126 (agent 127 continues)

Planner: P-AIB-125 (Claude Opus 5.5, read-only), 15:41-15:55 PDT 2026-10-06 (times from `TZ=America/Los_Angeles date`).
Owner 15:40 (verbatim): "lets build it - world class, better UI and UX than any competitor, more per client intelligent, and smooth
transitions with haptic feedback layered in. I want the FUN part of being a trainer to be fun in-app. But, dont turn it off or hide it.
Push it live and ON! Lets get a planner agent on that for agent 126 - notated as his responsibility to do!"
**Owner of execution: agent 126 (tonight), then agent 127.** This file is the plan; nothing in it is built yet except AIB-1 (in flight).
Code read at backend origin/main a6f4b5a9 and mobile origin/main 950689a (RO worktrees, `git show origin/main:`).
Inputs: HANDOFF.md "AI MASTER WORKOUT BUILDER" (AIB-1..6), ops/reports/SAFE-MWBAI-125.md (NO-GO, 6 blockers), AUDIT-14-125 (per-client
generator), AUDIT-07-125 (builder), B-ROMANIQ-125 (model ids), operator mail 15:46 (AIB-1 builders started).

---

## PART 1. PLAIN WORDS

### What the coach gets
Inside the workout builder a coach types a sentence, or taps a chip, and the AI proposes changes to the workout. Every change shows as a
card (added, changed, removed, moved) with the before and after numbers and a one-line reason. The coach keeps or drops each card, taps
Apply, and can undo. Nothing reaches a client until the coach applies it. The AI only uses exercises from the TGP library, stays inside
hard training limits, steers around the client's reported injuries, and never makes medical claims. Each request uses the coach's AI
credits; when they run out the screen says so plainly.

### The 7 coach jobs it nails
1. **New workout from a goal.** "Upper body hypertrophy, 60 min, dumbbells only" on a blank workout -> a full workout from the library.
2. **New program for a client.** Client page > Build with AI > New program: the existing per-client generator (live today), now with the
   client's injuries, history and schedule, and "Approve & assign" really assigns the days (B-AIASSIGN-125, in flight).
3. **Edit by sentence.** "Swap squats for something knee-friendly", "make it 45 minutes", "add a finisher".
4. **Injury swaps.** Chip "Swap for injury" -> area chips (knee, shoulder, lower back, hip, elbow/wrist, ankle/foot, upper back/neck).
   Pre-filled from the client's consultation answers when the workout is a client's copy.
5. **Progress or deload.** Chips "Progress" (one step: +1 rep or +2.5-5% load, inside bounds, from logged loads when present) and "Deload"
   (sets down about 40%, same exercises). Week-level (all days of a program week) is AIB-6.
6. **Template to client.** Open a library template for a client ("Adjust for Sam") -> the AI fits it to Sam's equipment, days and
   injuries, as a diff on Sam's copy.
7. **Explain.** "Why?" on any card shows the reason; chip "Explain this workout" returns a short coach-facing summary, no changes.

### Exact screens and taps
- **Workout builder (CoachWorkoutBuilderScreen)**, both stand-alone and program-day:
  - Header: an "AI" button (sparkle icon, label "Ask AI", accessibilityLabel "Ask AI to change this workout").
  - Bottom of the exercise list: a pinned prompt bar "Ask AI to change this workout" (blank workout: "Describe the workout to build").
    Tap -> the AI sheet opens at half height with the keyboard up.
  - **AI sheet**: prompt field (1,000 chars), send button, quick-action chips in one scroll row: Swap for injury, Progress, Deload,
    Shorten, More volume, Explain. Client copy: a context row "Using Sam's goal, equipment, injuries, last 4 weeks" (truthful, from the
    server's `context_used`). Template: "Using your library and style".
  - **Thinking state (staged reveal)**: three real pipeline stages shown in order with a soft progress shimmer: "Reading the workout",
    "Checking limits and injuries", "Choosing from your exercise library". Then cards cascade in (60 ms stagger). Each stage label
    describes a step the server always runs, so the copy is never false.
  - **Diff preview**: summary line ("5 changes. Knee-friendly swaps, same weekly volume."), then one card per change: kind badge
    (Added / Changed / Removed / Moved; colour plus text, never colour alone), exercise name + thumbnail, before -> after
    ("3 x 8 @ 135 lb -> 3 x 10 @ 115 lb"), reason line, warning chip when relevant ("Loads the knee. Sam reported knee issues."). Each card
    has a keep toggle (default on). Footer: "Apply 5 changes" (count follows toggles) and "Discard". Dropped items show once as a quiet
    line: "1 suggestion removed: not in your exercise library."
  - **After apply**: sheet closes, the list animates to the new state (layout transition), a toast "Applied 5 changes. Undo" (10 s),
    and the header undo works as for manual edits. The workout shows a small "AI-suggested, coach-approved" tag on the revision.
  - **Revision history**: header overflow > History: revisions newest first, author chip "You" or "AI-suggested, coach-approved", time,
    one-line summary; tap -> "Restore this version" (uses the existing undo route step by step; full restore is 1.1).
- **Programs library (ProgramsLibraryScreen)**: "+" menu gains "New workout with AI" -> blank builder with the sheet open (AIB-6).
- **Program editor (ProgramEditorScreen)**: week row overflow: "Progress this week with AI", "Make this a deload week" -> one sheet
  that groups cards by day (AIB-6).
- **Client page (Client detail > Workouts tab, and the Coach AI section)**: "Build with AI" -> two choices: "New program for Sam"
  (existing generator -> AIWorkoutDraftScreen) and "Adjust Sam's current workouts" (opens Sam's assigned copy in the builder, sheet
  open, client context on) (AIB-6).
- **States (all specific, no generic errors; no first person, no emojis, no exclamation marks)**:
  - Out of credits: "AI credits for this month are used up. They reset on <date>." (no purchase or top-up wording on iOS).
  - Client without AI consent: "Sam has not allowed AI to use their data. Edit by hand, or build from a template without client data."
  - Plan changed elsewhere (409): "This workout changed on another screen. Reload it and ask again."
  - No safe proposal (422): "No safe change found for that request. Try: swap squats for a knee-friendly option."
  - Paused by the kill switch (503 / status off): button stays visible; sheet shows "Ask AI is paused for maintenance. Your workouts
    are unchanged." (owner: do not hide it).
  - Old backend without the route (404 on status): entry hidden. This only happens before the backend deploy; it is the only hide case.
  - Rate limit (429): "That is a lot of requests in an hour. Try again in a few minutes."

### The fun layer
- **Haptics** (expo-haptics ~56.0.3 is installed; reuse `HapticPressable` intents light/medium/success/warning/error and
  `useReduceMotion`): chip tap = light; keep toggle on a card = `selectionAsync`; send = medium; each card landing = one light tick,
  capped at 5 per reveal; Apply = success; Discard or turning a card off = warning (light); Undo = medium; any error state = error.
- **Motion** (react-native-reanimated 4.3.1 + gesture-handler 2.31, both installed): sheet spring (damping 18), cards `FadeInDown`
  with 60 ms stagger, removed rows strike through then collapse, accepted rows morph in place with `LinearTransition`, apply toast slides
  up. Reduce Motion on: no stagger, no springs, cross-fade only; haptics stay.
- **Copy voice**: a sharp training partner. Short, specific, numbers first. "Deload: sets down 40 percent, same exercises." "Knee-friendly
  swaps for Sam." "Progressed from Sam's last session: +5 lb on the press." Never "AI built your program"; always "AI-suggested,
  coach-approved".

### Competitor benchmark (what they do, from their own pages)
- **ABC Trainerize**: AI Workout Builder on all paid plans; builds a workout from coach instructions plus client profile, body stats,
  training/cardio history, equipment, injuries and preferences; refine in conversation; coach must review before it is assigned; builds
  individual workouts, a full program is built one workout at a time
  ([Trainerize blog](https://www.trainerize.com/blog/ai-coaching-software-with-coach-control/),
  [Trainerize AI Workout Builder](https://resources.trainerize.com/ai-workout-builder)).
- **Everfit**: AI Workout Builder turns text or program notes into trackable workouts; PDF import; the coach edits after; missing
  exercises can be created; AI usage is a shared workspace allowance with a counter at 90%
  ([Everfit help](https://help.everfit.io/en/articles/9373485-introducing-ai-workout-builder), [Everfit AI](https://everfit.io/ai/)).
- **TrueCoach**: AI builder generates workouts and e.g. a 4-week program from goals, experience and equipment; coach reviews and tweaks
  before assigning ([TrueCoach blog](https://truecoach.co/blog/the-fastest-way-to-build-a-client-program-in-2025/)).
- **Kahunas**: no published AI builder; manual drag-and-drop builder ([Scraler comparison](https://scraler.com/blog/kahunas-vs-everfit)).
- **Fitbod (AI-first, consumer)**: algorithm picks from 800+ exercises and sets sets/reps/weights from goal, equipment, logged performance,
  estimated 1RM, recovery and connected activity data ([Fitbod](https://fitbod.me/blog/fitbod-algorithm/)).
- **Future / Trainwell (human-coach apps)**: a human trainer builds plans; Apple Watch delivery
  ([Trainwell](https://www.trainwell.net/blog/online-personal-training-apps-worth-the-price)).

**What makes ours better** (none of the pages above describe these): (1) edit an existing workout or program by sentence with a
per-change diff the coach accepts change by change, plus undo and revision history; (2) Fitbod-style use of logged loads and recovery,
but for a coach-led product, inside the coach's own approval; (3) consultation injuries feed it automatically and contraindicated
exercises are removed server-side, not just "considered"; (4) library-only exercises (every pick has the TGP demo), hard bounds, no
medical claims; (5) it learns the coach's own style from their library (rep ranges, splits, favourite lifts) so output looks like the
coach wrote it; (6) it feels alive: staged reveal, motion, haptics. Claim discipline: never say "better than X" in app or store copy.

### Launch state (owner: ON and visible)
- The two mobile PRs (AIB-5, AIB-6) merge before the 10-07 build, so the screens ship ON and visible. There is no mobile flag.
- The server switch goes on (flags below) after the backend PRs deploy, the 12-point safety re-pass passes, and the owner taps through
  it once on a device (the ci APK). That needs no new build. Target: on before 09:00 10-07, before the build.
- Emergency kill (server-side, no build, read per call): set FEATURE_MWB_AI_LIVE_CREATE unset/false. The app then shows the paused state.

---

## PART 2. ENGINEERING

### 0. What exists today (verified)
- Engine (MWB-5 live-create): `src/ai/gateway` capabilities `draft.create_workout_plan` / `draft.edit_workout_plan`; strict zod diff ops
  `add_exercise | update_exercise | remove_exercise | reorder | plan_meta` (materialisers/__shared/workout-diff.types.ts), pure applier
  in a Serializable txn, WorkoutPlanRevision rows with `author_kind`, optimistic lock token (HMAC of planId, version, head_revision_id),
  template forking, tenancy checks in both materialisers, approval required by default (ai-gateway.config.ts DEFAULT_APPROVAL_REQUIRED).
- Blockers (SAFE-MWBAI-125): 1 the model does not write the diff (caller-supplied `proposed_action`, ai-gateway.service.ts:390; model text
  stored as 1,000-char `rationale`, :431); 2 no app surface; 3 coach cannot approve own draft (ai-approval.service.ts:92); 4 not metered
  (ai-credits.constants.ts:39-70); 5 no injuries/contraindications in context (private-context.service.ts:75-93), structural bounds only
  (workout-diff.types.ts: sets <= 100, reps/duration <= 86,400, weight <= 10,000); 6 not flippable via the manifest
  (fly-env-desired-state.json `excluded` lines 161-162; AI_GATEWAY_ENABLED/PROVIDER/REQUIRE_APPROVAL not in the manifest).
- `GET /ai/gateway/status` hard-codes 4 capabilities (ai-gateway.service.ts:577-583) and never reports the workout ones.
- Gateway config (ai-gateway.config.ts): AI_GATEWAY_ENABLED is global; a capability not in AI_GATEWAY_CAPABILITIES resolves to stub;
  `*` allows all. So the flip MUST list exactly the two workout capabilities (never `*`), or every other gateway capability
  (send_notification, wearable_insight, community_ai_triage, importer.mapping) would start calling Anthropic.
- Revisions: only `POST /workout-plans/:planId/undo` and `PATCH :planId/autosave` exist (workout-builder-autosave.controller.ts:59,94);
  no list route.
- Exercise ids: rows store a free string `exercise_external_id`; the mobile builder picks from `exerciseLibraryApi` / `useExerciseSearch`.
  ExerciseCatalogItem has slug, name, category, primary_muscle, secondary_muscles, equipment, difficulty. **AIB-2 step 0: confirm which id
  space the builder writes (library id vs catalog slug/uuid) and validate against that same table.**
- Client data available: UserProfile (goal_type, workout_days_per_week, equipment_access, injuries[] = INJURY_AREAS
  lower_back|upper_back_neck|shoulder|elbow_wrist|hip|knee|ankle_foot|other, workout_experience), ClientOnboardingIntake
  (screening_any_yes = any PAR-Q yes), ExerciseSet logs, ClientWorkoutAssignment completion, wearables ingest (ON).
- Mobile: expo-haptics ~56.0.3, reanimated 4.3.1, gesture-handler 2.31.1, `HapticPressable` (intents), `useReduceMotion`,
  CoachWorkoutBuilderScreen (1,936 lines, undo/redo stacks, autosave), ProgramEditorScreen, AIWorkoutDraftScreen, CoachAiSection,
  AIBudgetHardPauseModal. eas.json clinic has no AI flag (and gets none).
- **AIB-1 in flight (operator 15:46)**: B-AIB1-125 (branches agent125/b-aib1-125*): meter draft.create/edit_workout_plan + Coach AI v1,
  coach may approve AI-authored drafts (ai-approval.service.ts:92), SendNotificationMaterializer roster check. B-AIASSIGN-125
  (agent125/b-aiassign-125*): per-client "Approve & assign" really assigns days (coach-ai.service.ts approveDraft). Plan builds on both.

### 1. Per-client intelligence (signals, minimisation, consent)
All client data goes through the existing gates: `assertRequesterMayActOn` (tenancy) then `AiEgressService.assertMaySend` (AI consent
ledger, box-2 grant; FEATURE_AI_CONSENT_LEDGER_ENABLED is on). No grant -> 403 `ai_consent_required` -> the mobile consent state.
Template/library work with no client attached sends no client data and needs no client consent. Context is a typed JSON block built by
one function (`buildWorkoutContext`), enums and numbers only; client-written free text is never placed in the system prompt.

| Signal | Source | Sent to the model (minimised) | Gate |
|---|---|---|---|
| Goal | UserProfile.goal_type (consultation G1) | enum | box-2 |
| Schedule | workout_days_per_week (S1); session length from instruction | integer | box-2 |
| Equipment | equipment_access (S3/S3b) | enum list | box-2 |
| Experience | workout_experience | enum | box-2 |
| Injuries / limitations | UserProfile.injuries (T3_areas) + screening_any_yes + coach's instruction / injury chip | area enums + boolean | box-2 |
| Training history, loads | ExerciseSet, last 6 weeks, per library id: last weight x reps, best e1RM, sessions count; max 30 exercises | numbers per id | box-2 |
| Adherence | assignments completed / assigned, last 4 weeks | one percentage | box-2 |
| Check-ins | last 2 check-ins: energy, soreness, sleep quality scores (numbers only, no notes) | numbers | box-2 |
| Recovery (Health Connect / Apple Health) | 7-day sleep hours avg, resting HR and HRV trend | 3 values, direction only (up/flat/down) for HR/HRV | box-2 AND an active wearable connection |
| Coach style | coach's own library (WorkoutPlanExercise rows of plans they own): rep-range histogram, sets/exercise, rest, top 40 library ids, split pattern, superset rate | aggregates, no client data | coach's own data; no client consent needed |
| The workout itself | current rows (library id, sets, reps, load, rest, order) | as is | none extra |

Not sent (removed for workout capabilities, SAFE C): name (use "the client"), email, phone, weights/height (not needed for exercise
choice), preferred_snacks, last coach message excerpt. Coach style is learned without Roman v1.1: deterministic SQL aggregation per
request (cheap, cached 10 minutes in memory), plus 1.1: a "kept vs dropped" tally of the coach's past AI decisions per library id.

### 2. Safety built in (acceptance criteria for every AIB PR; SAFE checklist 1-12)
1. Consent: every client-data call passes the box-2 ledger check before the provider call (re-checked in the adapter per attempt).
2. Minimisation: exactly the table above; a unit test snapshots the context keys and fails if snacks/message/name/email appear.
3. Tenancy: client must be the coach's (canCoachActOnClient); plan must be tenant-owned; drafts list/decide tenant-scoped.
4. Human in the loop: model output becomes an AiActionDraft (status pending, requester = the AI system actor, `tenant_coach_id` = head
   coach); only an explicit coach decision materialises it; nothing is assigned or pushed to a client by this path. The coach IS the
   approver (AIB-1 changes ai-approval.service.ts:92 so the tenant coach may decide AI-authored drafts; the no-self-approval rule stays
   for coach-authored drafts).
5. Prompt injection: instruction and any client text go in the user turn as quoted data; the model output is only ever parsed as the
   diff schema; it cannot name a capability, client, plan id or route.
6. Output validation: structured output (tool/JSON schema) -> `WorkoutDiffSchema` -> library-id check -> training bounds ->
   contraindication filter -> applies cleanly to the current revision (dry-run with the pure applier). One repair attempt with the
   validator's errors; then 422 `AI_NO_SAFE_PROPOSAL`. Invalid single ops are dropped and reported in `dropped`, never written.
7. Domain safety: library ids only (no invented exercises); hard bounds (below); injury areas exclude movements that load them
   (table below), dropped server-side with a reason; screening_any_yes -> no Progress ops, a banner "Sam flagged a health screening
   question. Confirm medical clearance before increasing intensity."; medical claims filtered from `reason`/`summary`/`notes`
   (deny list: cure, treat, heal, rehab, diagnos, therapy, prescription, injury recovery promises) and the system prompt forbids them;
   extreme requests (e.g. daily two-hour fasted cardio for fast weight loss) are refused with a neutral line.
8. Cost: both capabilities metered against the coach AI pool before and after the call (AIB-1); propose route throttle 60/hour/coach
   with a specific 429 copy; out-of-credits = 403 COACH_AI_BUDGET_EXHAUSTED -> specific state.
9. Kill switch: FEATURE_MWB_AI_LIVE_CREATE unset -> propose 503 `AI_PAUSED` and status `state: 'paused'` before any provider call or
   draft write; materialisers still re-check; read per call.
10. Logs: prompt/response stored as SHA-256 hashes only; no context block, instruction or health values in logs or Sentry; draft rows
   hold the diff and reasons only.
11. Store/legal: label "AI-suggested, coach-approved" everywhere; never "AI built"; client box-2 consent text already names Anthropic
   (5.1.2(i)); no purchase wording in the out-of-credits state on iOS; no medical claims.
12. Mobile reachability: AIB-5/AIB-6 in the 10-07 clinic build, no EXPO_PUBLIC flag, visibility from the status route.

**Hard bounds (server, per op; tighter than the structural schema):** sets 1-10; reps 1-30; duration 5-3,600 s; rest 0-600 s; exercises
per workout <= 14; hard sets per primary muscle per workout <= 12 and per program week <= 24 (beginner 16); a progress step <= +10% load or
+2 reps per exercise vs current; deload = 30-50% fewer sets; `weight_lbs` only when the client has logged that exercise (<= 105% of
last logged working weight) or the current row already has a load, else null (the coach fills it). Notes <= 200 chars.

**Contraindication table (AIB-2 minimum, AIB-3 extends with substitutions):** knee -> drop deep knee flexion under load (back/front squat,
lunge, leg extension, jump) unless the coach typed that exercise; lower_back -> drop loaded spinal flexion/axial load (deadlift,
good morning, back squat, sit-up); shoulder -> drop overhead press, upright row, dips, behind-neck; elbow_wrist -> drop skull crusher,
heavy curls/front-loaded wrist extension; hip -> drop deep loaded hip flexion; ankle_foot -> drop jumps, running; upper_back_neck ->
drop shrugs under load, overhead carry; other -> no auto-drop, warning chip only. Matching uses ExerciseCatalogItem category,
primary_muscle and a small curated slug list in one file (`training-safety.constants.ts`). The coach can still add any exercise by hand.

### 3. API contract (lets mobile build in parallel with backend)
- `GET /ai/gateway/workout-builder/status` (AIB-4) -> 200
  `{ state: 'on'|'paused'|'no_credits'|'not_configured', create: boolean, edit: boolean, credits: { remaining_pct: number|null,
  resets_at: string|null }, label: 'AI-suggested, coach-approved' }`. 404 on the current production backend -> mobile hides entry.
- `POST /ai/gateway/workout-builder/propose` (AIB-2), coach/owner only, throttle 60/h:
  body `{ mode: 'create'|'edit', plan_id?: string, lock_token?: string, client_id?: string, instruction: string (<=1000),
  quick_action?: 'swap_for_injury'|'progress'|'deload'|'shorten'|'more_volume'|'explain', injury_area?: INJURY_AREA }`
  -> 201 `{ draft_id, summary (<=280), changes: [{ change_id, kind: 'added'|'changed'|'removed'|'moved'|'meta', op: WorkoutDiffOp,
  before?: Row, after?: Row, exercise: { id, name, thumbnail_url|null }, reason (<=200), warnings: string[] }], dropped: [{ reason }],
  context_used: string[], screening_flag: boolean, credits_remaining_pct }`; `explain` returns `changes: []` and a summary.
  Errors: 403 `ai_consent_required`, 403 `COACH_AI_BUDGET_EXHAUSTED`, 409 `REVISION_STALE`, 422 `AI_NO_SAFE_PROPOSAL`, 503 `AI_PAUSED`, 429.
- `PATCH /ai/gateway/drafts/:id` (existing; AIB-2 adds optional `accepted_change_ids: string[]`): applies only the accepted ops (re-validated
  and dry-run as a subset; a `reorder` op applies only if every op it depends on is accepted), returns `{ status, materialised_ref:
  { plan_id, revision_index } }`. Reject = `decision: 'rejected'`.
- Undo: existing `POST /workout-plans/:planId/undo` (head revision `author_kind: 'ai'`).
- `GET /workout-plans/:planId/revisions?limit=20` (AIB-4, read-only, tenant-scoped) -> `[{ revision_index, author_kind, cause,
  created_at, summary }]`.
- Mobile/autosave interplay: before propose, flush pending autosave and send the current lock token; after apply, refetch the plan and
  adopt server rows (reset local undo baseline to the new head), the same way the screen already adopts an autosave result.

### 4. Model choice per call (ids from B-ROMANIQ-125; follow b#803 adapter conventions: never send `temperature` (400 on 5.5 models),
explicit `thinking`/effort, max_tokens sized for thinking)
- propose `edit` + quick actions: `claude-sonnet-5-5`, thinking `between_tools`, effort `medium`, max_tokens 6,000, 25 s timeout
  (target p50 under 12 s).
- propose `create` (one workout): `claude-sonnet-5-5`, effort `high`, max_tokens 8,000, 40 s timeout.
- `explain`: `claude-sonnet-5-5`, effort `low`, max_tokens 1,500.
- Per-client multi-week program (existing generator, src/ai/coach): stays `claude-sonnet-5-5` effort high (b#803).
- `claude-opus-5-5`: not on the request path (always thinks; latency). Builder agents for every backend PR: Claude Opus 5.5 (T4). Lenses:
  dual (GPT-6.1 Sol + Claude Opus 5.5) at exact heads.
- Cost: about 6k in + 2k out per propose = about 3.2 cents at $2/$10 per MTok; metered to the coach pool.

### 5. Flags and values (launch: ON)
Backend, set by the FLIP PR after the safety re-pass and the owner's device tap-through (the operator runs the sync per SoT; agents never
write Fly secrets):
- `FEATURE_MWB_AI_LIVE_CREATE=true`
- `AI_GATEWAY_ENABLED=true`
- `AI_GATEWAY_PROVIDER=anthropic` (ANTHROPIC_API_KEY is already on Fly)
- `AI_GATEWAY_CAPABILITIES=draft.create_workout_plan,draft.edit_workout_plan` (exactly these two; never `*`; community_ai_triage stays out
  until v1.1+). Before the flip the operator lists Fly secret NAMES and records whether AI_GATEWAY_CAPABILITIES already exists; any other
  capability that is genuinely live today must be named by the operator and kept, nothing added.
- `AI_GATEWAY_REQUIRE_APPROVAL`: stays unset (defaults keep both capabilities approval-required); ENV_RULES rejects `false` for them.
- Mobile: no EXPO_PUBLIC_FF_* (none added). Visibility is server-driven; eas.json clinic unchanged.
- Manifest: AIB-4 moves the five names from `excluded`/absent into `flags` with closed value sets and gates, all "unset"; the FLIP PR
  only changes values to the ones above. Refresh the stale R2b notes (lines 161-162) in AIB-4.
- **Kill switch (no build):** first choice FEATURE_MWB_AI_LIVE_CREATE unset (only the builder stops; app shows "paused"); second
  AI_GATEWAY_CAPABILITIES without the two ids; last resort AI_GATEWAY_ENABLED unset (stops every gateway capability).

### 6. PR slices in merge order
Sizes are changed lines incl. tests (cap each under 600; hard cap 1,500). Every PR body opens with the SoT A3 8.1 tier header.

| # | Repo | Title | Main files | ~Lines | Tier | Depends on | Parallel |
|---|---|---|---|---|---|---|---|
| AIB-1a (in flight) | backend | B-AIB1-125: metering + coach approves AI-authored drafts + roster check | ai-credits.constants.ts, ai-approval.service.ts, send-notification.materialiser.ts, coach-ai.service.ts (meter) | ~300 | T4 | - | yes |
| AIB-1b (in flight) | backend | B-AIASSIGN-125: per-client Approve & assign assigns days | coach-ai.service.ts approveDraft | ~250 | T4 | - | yes |
| AIB-2 | backend | feat(ai): workout builder generator (model writes the diff, library ids, bounds, injuries minimum) | NEW src/ai/gateway/workout-builder/{workout-builder-ai.controller.ts, workout-builder-ai.service.ts, workout-builder-prompt.ts, workout-diff.validator.ts, training-safety.constants.ts}, ai-gateway.module.ts, ai-approval.service.ts (accepted_change_ids subset, after AIB-1a), edit/create materialisers (subset apply) | ~580 | T4 | rebase on AIB-1a before merge | starts now, parallel with AIB-4/AIB-5 |
| AIB-3 | backend | feat(ai): per-client context v2 + contraindication substitutions, same for the per-client generator | private-context.service.ts (workout context builder, drop snacks/message for workout caps), NEW workout-context.service.ts (history, adherence, check-ins, recovery, coach style), training-safety.constants.ts (substitutions), coach-ai.service.ts prompt (injuries + bounds) | ~550 | T4 | AIB-2 merged (wires into its validator), AIB-1b (same file coach-ai.service.ts) | pure modules + tests can start in parallel |
| AIB-4 | backend | feat(ai): workout builder status + revisions list + manifest entries | NEW workout-builder-status in the AIB-2 controller folder (own file), ai-gateway.service.ts getStatus (add workout caps), workout-builder-autosave.controller.ts (GET revisions), src/common/env-validation.ts ENV_RULES, .github/fly-env-desired-state.json (entries, all unset), docs/runbooks/launch-flags.md | ~350 | T4 (config + money state) | none | yes |
| AIB-5 | mobile | feat(coach): Ask AI in the workout builder (prompt bar, chips, diff preview, apply/undo, haptics) | NEW src/api/aiBuilderApi.ts (+ zod types), NEW src/components/coach/ai-builder/{AiBuilderSheet, PromptBar, QuickActionChips, ChangeCard, StagedReveal, useAiBuilder}.tsx, CoachWorkoutBuilderScreen.tsx (header button, pinned bar, adopt-after-apply, one hunk) | ~590 | T3 | contract in section 3 only (works against current prod: status 404 -> hidden) | starts now |
| AIB-6 | mobile | feat(coach): AI entry points (library, program week, client page) + history + AI draft screen polish | ProgramsLibraryScreen, ProgramEditorScreen (week actions, grouped-by-day sheet), client-detail/WorkoutsTab + CoachAiSection ("Build with AI"), NEW RevisionHistorySheet, AIWorkoutDraftScreen (haptics + motion, assigned_count copy), navigator registration | ~550 | T3 | AIB-5 merged | after AIB-5 merges |
| FLIP | backend | chore(flags): turn on the AI workout builder | .github/fly-env-desired-state.json values only | ~10 | T4 config | AIB-1a/2/4 deployed, SAFE-AIB GO, owner device tap | - |

Tests that must fail on main (each PR):
- AIB-2: propose route exists (404 on main); invented exercise id dropped; sets 40 rejected; reps 50 rejected; contraindicated add for
  knee dropped with reason; medical-claim words removed from reason; stale lock token -> 409; no box-2 grant -> 403 before any provider
  call; flag off -> 503 before draft write; budget debited once per call; subset approve applies only accepted ops; the tenant coach can
  approve the AI-authored draft (with AIB-1a); stub provider path returns a deterministic valid proposal (for CI and the safety pass).
- AIB-3: context snapshot contains injuries/history/adherence/recovery keys and NOT snacks/message/name; recovery absent without a
  wearable connection; per-client generator prompt includes injury areas and the bounds, and a generated knee-loading exercise is
  replaced by a substitution; coach-style aggregate uses only the coach's own plans.
- AIB-4: status returns `paused` with the flag off and `on` with flag + capability + key; getStatus lists the two caps; revisions list
  refuses another coach's plan; ENV_RULES rejects `AI_GATEWAY_CAPABILITIES=*` and REQUIRE_APPROVAL=false; manifest check passes.
- AIB-5: status 404 -> no entry; status paused -> entry visible + paused copy; propose renders cards with kind/before/after; keep toggles
  change the Apply count; Apply sends `accepted_change_ids`; Discard rejects; Undo calls the undo route; 403 budget, 403 consent, 409,
  422 each show their copy; haptic intents fired (success on apply, warning on discard, light on chip); reduce motion -> no stagger.
- AIB-6: each entry navigates on the correct stack (back works); week action groups cards by day; client page offers both choices;
  revision history renders author chips; AI draft approve shows "N workouts assigned" when `assigned_count` is present.

### 7. Timeline (PDT; build assumed 10:00 10-07 from mobile main, clinic profile; SoT gives no other time)
| Time | Agent 126 (tonight) |
|---|---|
| 15:46 | AIB-1a, AIB-1b building (agent 125 workers) |
| 16:30 | Launch B-AIB2-126, B-AIB4-126, B-AIB5-126 in parallel; B-AIB3-126 starts its pure modules |
| 17:45-18:15 | AIB-1a/1b READY -> dual lenses -> merge by 19:00 |
| 18:30 | AIB-5 READY (mobile first: it gates the build) -> lenses 30 min -> one fix round -> **merge AIB-5 by 20:30** |
| 18:45 | AIB-4 READY -> lenses -> merge by 20:30 |
| 19:00 | AIB-2 READY (rebased on AIB-1a) -> lenses -> fix -> merge by 21:30 |
| 20:30 | Launch B-AIB6-126 on main with AIB-5 |
| 21:30 | AIB-3 wires into AIB-2, READY by 22:30 -> merge by 23:30 |
| 22:30 | AIB-6 READY -> lenses -> **merge AIB-6 by 00:30** |
| Agent 127 | (overnight / early 10-07) |
| 00:30 | Operator backend deploy of AIB-1a/1b/2/3/4 per SoT deploy rules (flags still unset) |
| 01:00 | SAFE-AIB-127: 12-point re-pass on deployed main (read-only; stub provider) -> GO / GO AFTER FIXES |
| 01:00-06:00 | Fix any SAFE-AIB blockers (backend only; no build needed) |
| 06:00 | ci APK from mobile main (ci lane) for the owner |
| 07:30-08:30 | Owner device tap-through (DEVICE_PASS_10-07 + the 7 jobs above) |
| 08:30 | FLIP PR merged and synced by the operator -> live ON; one live smoke: one edit, one create, one apply, one undo |
| 09:30 | Mobile main freeze. 10:00 build. |

**Cut line (if time runs short):**
- Must be in the 10-07 build: AIB-5 (in-builder Ask AI with diff preview, apply/undo, all states, haptics). Its merge deadline is 09:30.
- Must be deployed before the flip: AIB-1a, AIB-2, AIB-4 (AIB-2 carries the minimum injury rule, so AIB-3 is not a flip gate).
- Slips without harm (backend, no build): AIB-3 (richer context, substitutions, per-client generator parity), AIB-1b if lenses disagree.
- If AIB-6 cannot merge by 09:30 -> 1.1: library and client-page entry points, week-level progress/deload, revision history screen,
  AI draft screen polish. The builder entry still reaches all 7 jobs except week-level (single workout) and job 2 (already live).
- If SAFE-AIB is not GO by 08:30: build still carries the screens; the server stays off and the app shows "paused" (visible, honest);
  flip later the same day with no build.
- 1.1: SSE streaming of real stages; kept/dropped style learning; full restore to any revision; multi-week create in the builder;
  coach-entered limitation notes field; per-coach default progression rules.

### 8. Ready-to-paste JOBS entries (for /home/user/workspace/ops/lanes126/JOBS126.md; workers read _COMMON_126, same rules as _COMMON_125)

## B-AIB2-126 (Claude Opus 5.5, BUILDER, T4 AI) — AI workout builder generator. Time box 120 min.
Plan: /home/user/workspace/tgp-agent-context/handoffs/op-125/AI_MASTER_BUILDER_PLAN.md sections 0-6 (read 0, 1, 2, 3, 4, 6). Backend only.
Build `POST /ai/gateway/workout-builder/propose` (contract section 3): the model returns the structured diff, validated server-side by
WorkoutDiffSchema, library-id check (step 0: confirm the id space the mobile builder writes), hard bounds, the minimum contraindication
table (section 2), medical-claim filter, dry-run on the current revision, one repair attempt, else 422. Draft written through the gateway
with requester = AI system actor and tenant_coach_id = head coach; add `accepted_change_ids` subset approval. Models per section 4 (no
temperature). Consent via AiEgressService; tenancy via canCoachActOnClient; metering per AIB-1 (rebase on agent125/b-aib1-125* once
merged; until then do not duplicate it). Flag off -> 503 before any draft. ONE backend PR under 600 lines, tests in section 6 that fail
on main. Acceptance: SAFE checklist 1-12 (section 2) each with file:line in the PR body. Do not touch the manifest (AIB-4 owns it).
Report /home/user/workspace/ops/reports/B-AIB2-126.md. READY comment per _COMMON item 5 with job B-AIB2-126. Never merge/deploy.

## B-AIB3-126 (Claude Opus 5.5, BUILDER, T4 AI) — per-client context v2 + contraindication substitutions. Time box 120 min.
Plan sections 1 and 2. Start now on pure modules (workout-context.service.ts: last 6 weeks loads per library id, 4-week adherence, last
2 check-in scores, recovery trend only with an active wearable connection, coach-style aggregates from the coach's own plans; the
substitution table in training-safety.constants.ts). Remove preferred_snacks and the coach message excerpt from workout capabilities in
private-context.service.ts. Apply injuries + bounds + substitutions to the per-client generator prompt in src/ai/coach/coach-ai.service.ts
(rebase on B-AIASSIGN-125 first; same file). Wire into the AIB-2 validator after AIB-2 merges. ONE backend PR under 600 lines; tests in
section 6. Box-2 consent gate unchanged and asserted. Report ops/reports/B-AIB3-126.md. READY comment per _COMMON item 5. Never merge/deploy.

## B-AIB4-126 (Claude Opus 5.5, BUILDER, T4 config) — status route, revisions list, manifest entries. Time box 75 min.
Plan sections 3 and 5. `GET /ai/gateway/workout-builder/status` (state on|paused|no_credits|not_configured, credits remaining_pct and
resets_at from the coach pool); add the two workout capabilities to getStatus (ai-gateway.service.ts:577-583); `GET
/workout-plans/:planId/revisions?limit=20` (tenant-scoped, read-only). ENV_RULES (env-validation.ts) closed sets: FEATURE_MWB_AI_LIVE_CREATE
true|false, AI_GATEWAY_ENABLED true|false, AI_GATEWAY_PROVIDER stub|anthropic, AI_GATEWAY_CAPABILITIES = comma list of known capability
ids (reject `*`), AI_GATEWAY_REQUIRE_APPROVAL must not disable the two workout caps. Manifest: move the five names into flags, ALL
"unset", with gates naming SAFE-AIB and the owner device tap; refresh the stale R2b notes. ONE backend PR under 400 lines. Report
ops/reports/B-AIB4-126.md. READY comment per _COMMON item 5. Never merge/deploy, never sync env.

## B-AIB5-126 (Claude Opus 5.5, BUILDER, T3 mobile) — Ask AI in the workout builder. Time box 120 min. MERGE BEFORE THE 10-07 BUILD.
Plan PART 1 (screens, states, fun layer) and sections 3 and 6. Build against the contract in section 3; it must work against the
CURRENT production backend: status 404 -> entry hidden; status paused -> visible with the paused copy. No EXPO_PUBLIC flag. New
src/api/aiBuilderApi.ts (zod-parsed), src/components/coach/ai-builder/* (sheet, prompt bar, chips, change cards, staged reveal,
useAiBuilder), and one hunk in CoachWorkoutBuilderScreen.tsx (header Ask AI, pinned prompt bar, flush autosave before propose, adopt
server rows after apply, undo via the existing route). Haptics via HapticPressable intents + selectionAsync as listed; reanimated motion;
Reduce Motion respected; every state has its specific copy (no first person, emojis, exclamation marks or generic errors); colour is
never the only signal; screen-reader labels on every control. ONE mobile PR under 600 lines; tests in section 6 that fail on main.
Report ops/reports/B-AIB5-126.md. READY comment per _COMMON item 5 with job B-AIB5-126. Never merge/deploy/build.

## B-AIB6-126 (GPT-6.1 Sol or Claude Opus 5.5, BUILDER, T3 mobile) — AI entry points + history + draft polish. Time box 100 min.
Start after AIB-5 merges, on main. Plan PART 1 screens: ProgramsLibraryScreen "New workout with AI"; ProgramEditorScreen week actions
(Progress this week / Make this a deload week; cards grouped by day; one propose per day plan, max 7, sequential with a shared staged
reveal); client-detail WorkoutsTab + CoachAiSection "Build with AI" (New program for <first name> -> existing generator; Adjust current
workouts -> builder with client context); RevisionHistorySheet from the AIB-4 route (hidden if 404); AIWorkoutDraftScreen haptics/motion
and "N workouts assigned" from assigned_count. Register every screen on the navigator the tab already uses (back must work). ONE mobile
PR under 600 lines; tests in section 6. If not mergeable by 09:30 10-07, stop and hand to 1.1 (cut line). Report
ops/reports/B-AIB6-126.md. READY comment per _COMMON item 5. Never merge/deploy/build.

## SAFE-AIB-127 (Claude Opus 5.5, SAFETY PASS, T4 AI, read-only) — 12-point re-pass of the AI workout builder. Time box 45 min.
Same checklist and output format as SAFE-MWBAI-125 (SAFETY PASSES block in JOBS125.md), on deployed backend main with AIB-1a/2/4 (and 3
if merged) and mobile main with AIB-5 (and 6). Verify the six SAFE-MWBAI blockers are closed with file:line; run the stub-provider
propose specs; confirm the flip values in plan section 5 are exactly right (two capabilities only, approval still required). Verdict GO /
GO AFTER FIXES / NO-GO. Report ops/reports/SAFE-AIB-127.md. Never flip a flag.

## FLIP-AIB (operator only, after SAFE-AIB GO and the owner's device tap-through)
One manifest PR: FEATURE_MWB_AI_LIVE_CREATE=true, AI_GATEWAY_ENABLED=true, AI_GATEWAY_PROVIDER=anthropic,
AI_GATEWAY_CAPABILITIES=draft.create_workout_plan,draft.edit_workout_plan. Operator merges and syncs per SoT, then the live smoke
(one edit, one create, apply, undo; check the coach pool debit and that a non-consented client gets the consent state). Kill switch per
section 5.
