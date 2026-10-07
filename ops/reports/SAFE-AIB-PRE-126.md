# SAFE-AIB-PRE-126 — AI workout builder: safety pre-pass on the OPEN heads (agent 126 worker, Claude Opus 5.5, T4 AI, read-only)

Started 18:00 PDT 2026-10-06 (times from `TZ=America/Los_Angeles date`). Read-only: no PR, no worktree, no flag flipped, no production touched.
Not a verdict: the dual lenses still decide. Plan section 2 (SAFE 1-12) run against the PR heads, read with `git show pr/<n>:<path>`.

| PR | Head read | State at read | Lines | CI at read |
|---|---|---|---|---|
| backend b#808 (AIB-4 status + revisions + manifest) | 9487faa216ac9fd79cffc704a9e1ac4ce3c09b1d | MERGED 18:07 PDT as 2df556b7 (now main) | +607 -8 | 21 success, 1 skipped |
| backend b#809 (AIB-2 generator) | c0984e2af2be79134c3f6eafeee0b72de73229b0 | open, DRAFT (being split; needs rebase on 2df556b7: both edit ai-gateway.module.ts `controllers:`) | +1105 -7 (over the 800 cap) | 1 failure, 15 success |
| mobile m#439 (AIB-5 Ask AI) | 63417260fae82291539cadc3dcdf88b8c0b81bf1 (also read c138b4c4; findings unchanged) | open | +792 -0 | 2 pending, 1 success, 1 neutral |

Main used for context: backend f71bb9a4 (b#805 metering + b#807 coach-approves merged), mobile 950689af.

## Blockers by PR (smallest fix each)

### m#439 — 2 blockers
**B1 (B: false claim + dead end). Apply succeeds on the server, but the app says "Your workout is unchanged."**
Story: a coach taps Apply on an Ask AI suggestion; the server edits the workout, but the app shows "The AI reply arrived in a format this app version cannot read. Your workout is unchanged.", keeps the old rows, and a second tap on Apply is refused ("This account cannot use Ask AI on this workout").
- Mobile `src/api/aiBuilderApi.ts:40-41`: `DecideSchema.materialised_ref` must be an object `{plan_id, revision_index, lock_token?}` or null.
- Backend (main and b#809) `PATCH /ai/gateway/drafts/:id` returns the Prisma `AiActionDraft` row (`ai-approval.service.ts:467` `return updated;`), whose `materialised_ref` is `String?` (prisma/schema.prisma:3203) holding the plan id (edit-workout-plan.materialiser.ts:324/340). The string fails zod -> `contract` error -> `onApplied` never runs. The mobile test mocks an object (aiBuilder.test.tsx:82), so CI cannot catch it.
- Smallest fix (mobile, works with every backend): `materialised_ref: z.union([RefSchema, z.string()]).nullable().optional()` and map a string to `null` so the screen takes its existing re-read path (`runReplayRefetch`). Optional backend half (b#809): for live-create drafts return `{ status, materialised_ref: { plan_id, revision_index, lock_token } }` per plan section 3 (also what B-AIB5P-126 asked for) — but mobile must tolerate the string either way because the build ships first.

**B2 (flip-blocking U: dead buttons). Shorten, Explain and any reorder or rename always fail.**
Story: a coach taps the Shorten chip (or Explain, or asks to reorder) and always gets "The AI reply arrived in a format this app version cannot read."
- Mobile `src/api/aiBuilderApi.ts:29` `exercise: z.object(...)` is required and `:34` `draft_id: z.string().min(1)`.
- Backend b#809 `workout-diff.validator.ts:147` sends `exercise: null` for every remove, reorder and plan_meta change (exId is only set for add/update), and `workout-builder-ai.service.ts:159-161,188` sends `draft_id: null` for Explain (no draft). One such change fails the whole proposal.
- Smallest fix (mobile): `exercise: ExerciseSchema.nullable()`, `draft_id: z.string().min(1).nullable()`; in `AiBuilderSheet.tsx:38,41` fall back to the kind label ("New order", "Workout details") when `exercise` is null; when `draft_id` is null show the summary with "Done" and no Apply/Discard call. Optional backend half (b#809, 1 line): for `remove_exercise` fill `exercise` from `before.exercise_external_id`.

### b#809 — 2 blockers (plus the backend halves of B1/B2 above)
**B3 (B: core-flow dead end for team coaches). The "model wrote this" marker never matches after the database round trip.**
Story: a Scale-tier head coach who has one active sub-coach taps Apply on any Ask AI suggestion and is refused ("This account cannot use Ask AI on this workout").
- `ai-gateway.service.ts:403` hashes `JSON.stringify(modelPayload)` (keys in write order `capability, target_plan_id, base_revision_index, diff`). `ai-approval.service.ts:70` re-hashes `JSON.stringify(draft.payload)` read back from Postgres. `AiActionDraft.payload` is JSONB (migration 20260427000100 `"payload" JSONB`), and JSONB does not keep key order (it returns `diff, capability, target_plan_id, base_revision_index`, and reorders every op's keys). The hashes never match, so `isWorkoutBuilderModelDraft` is always false in production; `tenantCoachMayDecideOwnDraft` (`:146-151`) then falls to the "no other human in the tenant" rule, which is false for a coach with a sub-coach -> 403 "A draft cannot be decided by its requester". Solo coaches are unaffected. The spec builds the draft in memory (aib2 spec :245), so it passes.
- Smallest fix: the marker is already unforgeable (the gateway strips caller provenance with that source, `ai-gateway.service.ts:351-353`, and only `resolveProposedAction` adds it), so drop the hash comparison and check `source === WORKOUT_BUILDER_MODEL_DIFF_SOURCE && isMwbLiveCreateCapability(draft.capability)`. Or hash a canonical (recursively key-sorted) JSON on both sides. Add a spec that reorders the payload keys before `decide`.

**B4 (B for team tiers: core-flow dead end for sub-coaches). A sub-coach can never use Ask AI.**
Story: a sub-coach on a Scale team opens a workout, asks AI, and gets "paused for maintenance" on their own plans or a refusal on Apply on the head coach's plans.
- `workout-builder-ai.service.ts:72-73,88`: `tenantCoachId` = head coach, and a plan is accepted only when `plan.coach_id === tenantCoachId`, so a sub-coach's own plan returns 404 (mobile maps 404 to the paused copy). On a head-coach plan the draft is stamped `tenant_coach_id` = head coach, and `decide` (`ai-approval.service.ts:174`, tenant check `draft.tenant_coach_id !== input.decider.id`) refuses the sub-coach.
- Smallest fix (recommended default for 10-07): hide Ask AI for sub-coaches — the status route returns 404 for a user that `getHeadCoachIdForSubCoach` maps to another coach (mobile hides the entry on 404), and propose returns the same 404. Full support (sub-coach applies their own model draft inside their head coach's tenant, plan scope via the autosave `authorisePlanAccess` gate) is a T4 tenancy change for v1.1. If Scale teams are not in launch scope, the operator may reclassify B4 to U.

### b#808 — 0 blockers (merged)
Status route, revisions list and manifest entries are sound: the flag is read per call (`workout-builder-status.service.ts:38-49`), approval is forced for both workout capabilities whatever AI_GATEWAY_REQUIRE_APPROVAL says (`ai-gateway.config.ts` `requireApprovalFor`), the allow-list closed set is exactly the two workout capabilities (`*` rejected), revisions use the autosave owner/visibility gate and return counts only. Closes SAFE-MWBAI-125 blocker 6.

## SAFE checklist 1-12 (train = b#808 merged + b#809 + m#439)
| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Consent | PASS | `subjectUserId: input.client_id` (workout-builder-ai.service.ts:140) -> `namedClientIds` (ai-gateway.service.ts:643-661) -> requester-may-act 404 then box-2 `egress.assertMaySend` before the provider call (:241-247), re-read in the Anthropic adapter. Client context is read from the DB before the check but never sent before it. AIB-5 sends no `client_id`, so this build sends no client data at all. |
| 2 | Minimisation | PASS (C) | `loadClientContext` (service:193-209): goal, experience, equipment (12 x 40 chars), days/week, injury enums, screening boolean. No name, email, snacks, weights or message excerpt; spec asserts no email/snack in the prompt (aib2 spec :202). C: equipment strings are not checked against an enum. |
| 3 | Tenancy | PASS | Client via `canAccessClient` (service:75-78); plan must be tenant-owned and not archived (:84-90); decide keeps the B-AIB1 roster and payload-client checks. Owner role bypass is by design. |
| 4 | Human in the loop | PASS, but dead ends B3/B4 | Draft is `pending`; nothing writes until `decide`; approval forced for both caps (b#808); `approvalRequired && modelPayload !== null` (ai-gateway.service.ts ~:409). Subset approve only removes ops; the materialiser re-validates and dry-runs. |
| 5 | Prompt injection | PASS | Instruction and rows go in the user turn as JSON (prompt.ts:45,68-85); output is parsed only as `{summary, changes[{op, reason}]}` (:87-103); capability and target ids are filled by the server (service:169-171); callers cannot set the model marker (gateway strips it). |
| 6 | Output validation | PASS | Per op: `WorkoutDiffOpSchema` -> library id -> bounds -> loads -> screening/deload -> contraindications -> pure-applier dry-run -> per-workout caps (validator.ts:93-152); one repair attempt (service:127-180); then 422 `AI_NO_SAFE_PROPOSAL`. |
| 7 | Domain safety | PASS with gaps | Bounds sets 1-10, reps 1-30, 5-3,600 s, rest 0-600, 14 exercises, 12 hard sets/muscle, +10% load / +2 reps; no invented loads; contraindication table (training-safety.constants.ts:21-34); medical claims stripped from summary, reason, notes. Gaps: U1 plan name not filtered; C weekly caps and deload floor not enforced. |
| 8 | Cost | PASS | Both caps metered on main (b#805, ai-credits.constants.ts:78-79); pre-call budget gate; per-user throttle 60/h (controller:46, UserThrottlerGuard); at most 2 provider calls per propose, each metered. |
| 9 | Kill switch | PASS | `FEATURE_MWB_AI_LIVE_CREATE` checked first, 503 `AI_PAUSED` before any read or draft (service:68-70); status `paused`; materialisers re-check; read per call. |
| 10 | Logs | PASS (C) | Prompt/response kept as hashes; no instruction, context or health values in logger lines. C: no `aiRequestAudit` row when the resolver throws (422/503 after a real call); the debit is still recorded. |
| 11 | Store/legal | PARTIAL | Label "AI-suggested, coach-approved" in the sheet (AiBuilderSheet AI_LABEL) and revision history (cause `ai_apply`); no purchase wording in the no-credits copy. Fails on B1 (false "unchanged" claim) and U1 (plan name claim). |
| 12 | Mobile reachability | PASS, but B1/B2 | No EXPO flag; entry hidden only on status 404; clinic and production have EXPO_PUBLIC_FF_MWB_AUTOSAVE true (eas.json:45,69). Needs the b#808 deploy to show (status 404 on current prod hides it). |

## U list (fix if small)
- U1 (b#809) Model-written plan names skip the medical-claim filter: `validator.ts` never runs `plan_meta.name` through `MEDICAL_CLAIM_PATTERN` (only reason/summary/notes, :65,:144; summary in service:156-158). Story: Ask AI renames a workout "Knee rehab day", the coach applies and assigns it, and the client sees a medical claim. Fix: drop a `plan_meta` op whose `name` matches the pattern, with a reason (2 lines + 1 test).
- U2 (m#439) `AiBuilderSheet.tsx:146` shows raw keys: "Using exercise_library, current_workout". Fix: map to labels ("exercise library, current workout, goal, injuries").
- U3 (b#809) The model sees existing rows as ids only (`workout-builder-prompt.ts:75-82`, no name). For non-seed ids (ExerciseDB) it cannot tell what an exercise is, so "swap squats" edits can miss. Fix: add `name: LIBRARY.get(id)?.name ?? null` per row.
- U4 (m#439) 503 `AI_NOT_CONFIGURED` "could not reach the model" (provider failure) maps to the "paused for maintenance" copy (`aiBuilderApi.ts` byStatus 503). Fix: map `code === 'AI_NOT_CONFIGURED'` to the `server` copy.

## C one-liners
- C: screening flag blocks increases on existing rows but still allows `add_exercise` (more volume); reachable only once a client_id is sent (AIB-6).
- C (edge, deferred to 10k clients): partial apply that keeps an update of a rejected add fails in the materialiser (500).
- C: weekly hard-set caps (24, beginner 16) and the 30-50% deload floor are not enforced (per-workout only).
- C: contraindication filter and per-muscle cap only know seed-catalog ids; ExerciseDB ids in the baseline are not classified.
- C: a plan with no `head_revision_id` returns 409 "changed on another screen" (old plans only).
- C: b#809 must rebase on 2df556b7 (b#808 and b#809 both edit `ai-gateway.module.ts` `controllers:`); b#809 is +1,112, over the 800 cap (split in progress).

## SAFE-MWBAI-125 six blockers: status
| # | Blocker | Status | Where |
|---|---|---|---|
| 1 | The AI does not write the plan | Closed by b#809 (open, draft) | `workout-builder-ai.service.ts:147-172` (resolveProposedAction), `ai-gateway.service.ts:397-408` (model payload becomes the draft) |
| 2 | No app surface | Closed by m#439 for saved plans in the builder | `CoachWorkoutBuilderScreen.tsx` Ask AI header + prompt bar, `AiBuilderSheet.tsx`; client-page and program entries = AIB-6 (B-AIB6-126, no PR yet) |
| 3 | Coach cannot approve own draft | Closed on main for solo coaches (b#807, `tenantCoachMayDecideOwnDraft`); STILL OPEN for head coaches with sub-coaches (B3) and sub-coaches (B4) | owner: b#809 builder (B-AIB2-126) |
| 4 | Not metered | Closed on main (b#805) | `src/ai-credits/ai-credits.constants.ts:78-79` |
| 5 | No domain safety | Mostly closed by b#809 | `training-safety.constants.ts`, `workout-diff.validator.ts`; injuries/history context v2 = AIB-3 (B-AIB3-126, no PR yet); plan-name claim filter (U1) owned by nobody -> b#809 builder |
| 6 | Not flippable via the manifest | Closed by b#808 (merged 2df556b7) | `.github/fly-env-desired-state.json` flags + gates; `src/common/env-validation.ts` closed sets; stale R2b excluded notes removed |

Owned by nobody today: the decide response shape between b#809 and m#439 (B1) and the nullable fields (B2). Recommended owner: m#439 builder (mobile tolerance, ships in the build), with the backend half in b#809.

## Covered by open PRs
- None of B1-B4 is fixed by any open PR. Checked every open agent126 PR (b#809, m#439) and b#808 (merged).

## PRs opened
- None (read-only pre-pass).

## Not fixed (needs operator)
1. B1 -> m#439 builder: `src/api/aiBuilderApi.ts:40-41` accept a string `materialised_ref` (map to null -> re-read). Optional b#809: return the plan section 3 shape.
2. B2 -> m#439 builder: `aiBuilderApi.ts:29,34` nullable `exercise` and `draft_id`; `AiBuilderSheet.tsx:38,41` label fallback; Explain shows summary only.
3. B3 -> b#809 builder (T4): `ai-approval.service.ts:68-77` drop the hash comparison (marker + live-create capability) or canonical JSON on both sides; spec with reordered keys.
4. B4 -> operator decision (T4 tenancy): recommended default hide Ask AI for sub-coaches on 10-07 (status and propose 404 for a sub-coach); full support v1.1.
5. U1 -> b#809 builder: plan_meta name through `MEDICAL_CLAIM_PATTERN`.

## HANDOFF
Done 18:15 PDT (inside the 45-min box). Report complete; one SAFETY PRE-PASS comment posted on each PR (bodies saved as
ops/reports/SAFE-AIB-PRE-126-{b808,b809,m439}.md):
- b#808 @ 9487faa2 (0 blockers): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808#issuecomment-6028751787
- b#809 @ c0984e2a (2 blockers): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/809#issuecomment-6028752035
- m#439 @ 63417260 (2 blockers): https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439#issuecomment-6028752175
Notify line at
/home/user/workspace/ops/lanes126/notify/SAFE-AIB-PRE-126.txt. No worktree, no ci/* branch, no locks. If b#809 is split, re-check
B3 and U1 on whichever new PR carries `ai-approval.service.ts` / `workout-diff.validator.ts`; B1/B2 on the next m#439 head.
