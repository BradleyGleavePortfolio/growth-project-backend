# SAFE-MWBAI-125 — AI in the workout builder: safety pass (agent 125 worker, Claude Opus 5.5, T4 AI)

Started 14:59 PDT 2026-10-06, finished 15:06 PDT (times from `TZ=America/Los_Angeles date`). Read-only: no PR, no flag flipped, no production config touched.
Code read at backend origin/main a233a020 and mobile origin/main d16d5c1 (RO checkouts, `git show origin/main:`).
Flags: backend `.github/fly-env-desired-state.json` (main), `src/common/env-validation.ts`; mobile `eas.json` "clinic" (extends "production"), `src/config/featureFlags.ts`.

## VERDICT: NO-GO (leave FEATURE_MWB_AI_LIVE_CREATE unset; no flags to flip)
Turning it on is not unsafe for clients, but it switches on nothing that works. The feature is not built end to end:
1. **The AI does not write the plan.** For `draft.create_workout_plan` / `draft.edit_workout_plan`, the plan diff is whatever the
   caller sends in `proposed_action` (ai-gateway.service.ts:390). The model's reply is stored only as a 1,000-char `rationale` string
   (ai-gateway.service.ts:431). No server code turns model output into a diff, and nothing in backend `src/` or mobile calls these two
   capabilities (git grep: only the config, the validator table and the analytics enum name them).
2. **No app surface.** The 10-07 clinic build has no UI for it and no mobile flag for it: CoachWorkoutBuilderScreen has no AI entry,
   the mobile `aiGatewayClient` has no screen that calls it (components/trust/README.md "no screen surfaces that call it"), and
   PendingAiDrafts only knows `draft.assign_workout|assign_meal_plan|send_notification` (src/api/types/coachAiExecution.ts:36-39).
   Turning it on needs a later build.
3. **A coach can never approve their own draft.** `AiApprovalService.decide` refuses a decision by the requester
   (ai-approval.service.ts:92) and a coach can only decide drafts in their own tenant (:98-104), so a coach-made live-create draft can
   only be approved by an owner-role user. Same dead end AUDIT-14-125 found for the Ask AI pill (U2, hidden in m#425).
4. **Not metered.** Neither capability is in `COACH_AI_METERED_CAPABILITIES` (src/ai-credits/ai-credits.constants.ts:39-70), so a real
   provider call is never checked against or debited from the coach AI pool (owner A6.4: every AI turn debits the pool). Only the
   20/hour/user throttle applies (ai-gateway.controller.ts:59).
5. **No domain safety.** The context sent to the model has no injuries, conditions or contraindications (private-context.service.ts:75-93),
   and the diff bounds are structural only (sets <= 100, reps/duration <= 86,400, weight <= 10,000 lb; workout-diff.types.ts:75-94).
   Acceptable while a human types the diff; not acceptable once the AI writes it.
6. **It cannot be flipped through the manifest.** FEATURE_MWB_AI_LIVE_CREATE and AI_GATEWAY_CAPABILITIES are in `excluded`
   (no closed value set in ENV_RULES, env-validation.ts:2137), and AI_GATEWAY_ENABLED / AI_GATEWAY_PROVIDER / AI_GATEWAY_REQUIRE_APPROVAL
   are not in the manifest at all (production value unknown; FLAGS-D1-123 recorded AI_GATEWAY_ENABLED unset). Any flip would need a
   manifest PR (values + gates entry) or a direct Fly secret write, which agents are not allowed to do.

What a real turn-on needs (a later lane, not 10-07): a server-side generator that asks the model for a diff and validates it with
`WorkoutDiffSchema` (with training bounds and the client's injury/contraindication notes in context); add both capabilities to
`COACH_AI_METERED_CAPABILITIES`; an approval model where the coach approves AI drafts made for them (requester = system/AI actor, or
allow the coach when the AI authored the payload); mobile UI in the workout builder behind a new EXPO_PUBLIC flag; manifest entries
for FEATURE_MWB_AI_LIVE_CREATE (values true/false), AI_GATEWAY_ENABLED, AI_GATEWAY_PROVIDER and AI_GATEWAY_CAPABILITIES.

## Kill switch and current production state (verified)
- Flag unset (production): `AiGatewayConfig.capabilityAllowed` returns false for both capabilities regardless of AI_GATEWAY_CAPABILITIES
  (ai-gateway.config.ts:103), and `invoke` throws 403 `AI_CAPABILITY_NOT_ENABLED` BEFORE any AiActionDraft row is written
  (ai-gateway.service.ts:213-220). Both materialisers re-check the flag and refuse (create-workout-plan.materialiser.ts:123,
  edit-workout-plan.materialiser.ts:102). The flag is read on every call (no redeploy needed). Nothing for the UI to hide.
- Also needed even with the flag on: the capability in AI_GATEWAY_CAPABILITIES (production: excluded/unknown, code default = none allowed).
  With AI_GATEWAY_ENABLED unset, any allowed call uses the stub provider: nothing leaves the server.

## R2b acceptance (manifest note "needs ... R2b acceptance")
- What it required (SoT A7 TO-DO 9 and the Wave table, SoT ~line 1640 and ~5212): the gateway refuses any AI call carrying client data
  unless the client has a live box-2 grant in the #622 ledger, with tests and a T4 dual audit, then flip.
- **Met.** R2b = backend #626, dual APPROVE at d9be0c0d, merged 22:48 10-01 (7a6cfd82), deployed; FEATURE_AI_CONSENT_LEDGER_ENABLED=true
  in the manifest. Gateway enforces it: `assertRequesterMayActOn` then `egress.assertMaySend` on every non-stub call
  (ai-gateway.service.ts:231-237); `target_client_id` is one of the derived client keys (ai-gateway.service.ts:613). The manifest note is
  stale on R2b; the real blockers are items 1-6 above.

## Safety checklist (verdict per item)
| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Consent | PASS | Non-stub calls: requester-may-act check (404) then box-2 ledger check via AiEgressService (403 ai_consent_required), re-read inside the Anthropic adapter per attempt (ai-gateway.service.ts:231-237; providers/anthropic-provider.adapter.ts:51). create: `target_client_id` is a data subject. edit: plan's assigned clients are not derived, but no plan data is sent to the model (C below). |
| 2 | Data minimisation | PASS (C) | Model gets only the subject's first name, role, goal, activity level, experience, current/target weight, height, preferred snacks, equipment, and a 240-char excerpt of the last coach message (private-context.service.ts:75-93), plus the coach's redacted free text. Nothing from other users. Snacks and the message excerpt are not needed for a workout (C). |
| 3 | Tenancy | PASS | Context load requires canCoachActOnClient (private-context.service.ts:65,133-141); materialisers check canAccessClient and tenant-owned seed/program/plan (create-workout-plan.materialiser.ts:151-166, :398, :472; edit-workout-plan.materialiser.ts assertScope :363-430); drafts list and decide are tenant-scoped (ai-gateway.controller.ts:126-127; ai-approval.service.ts:98-104). |
| 4 | Human in the loop | PASS (but dead end) | Both capabilities are in DEFAULT_APPROVAL_REQUIRED (ai-gateway.config.ts:154-155); writes happen only in `decide` after approval; create writes an unassigned plan in the coach library (create-workout-plan.materialiser.ts:275-283). The approver cannot be the requester, so a coach cannot approve their own (blocker 3). |
| 5 | Prompt injection | PASS | Model output never drives an action (payload is caller-supplied, model text is stored as `rationale` only); history roles demoted to user/assistant (ai-gateway.service.ts:288-294). Client-written `preferred_snacks` sits inside the system prompt but can only change rationale text. |
| 6 | Output validation | PASS for writes / N/A for model | Strict zod payload schema at draft creation and again at materialisation (ai-gateway.service.ts:404-421; create-workout-plan.materialiser.ts:55-85, edit-workout-plan.materialiser.ts:48-72); diff applied by one pure applier inside a Serializable txn. The model output itself is never parsed (blocker 1). |
| 7 | Domain safety | FAIL once AI authors | No injury/contraindication input, structural bounds only (blocker 5). Same gap in the live coach AI drafts path (no injury handling anywhere in src/ai/coach or src/ai/gateway). |
| 8 | Cost | FAIL | Not in COACH_AI_METERED_CAPABILITIES (blocker 4); throttle 20/h/user only. |
| 9 | Kill switch | PASS | See section above (403 before draft; materialiser re-check; read per call). |
| 10 | Logs | PASS | Audit row stores prompt/response SHA-256 hashes, not bodies (ai-gateway.service.ts:305, 448-477); logger lines carry ids, capability and error messages only; materialiser warns carry ids. Rationale (model text) is in the DB draft row, not logs. |
| 11 | Store/legal | N/A on 10-07 | No UI copy. Client box-2 consent text names Anthropic (5.1.2(i) disclosure + permission) and is enforced. When a UI ships: label drafts as AI-suggested and coach-approved; never claim the AI "built" a plan while blocker 1 stands. |
| 12 | Mobile reachability | NOT IN BUILD | No UI and no flag in eas.json clinic/production or featureFlags.ts; a later build is required. |

## B list (10-07 build, flags as they will be)
- None. No normal user can reach the feature on the 10-07 build (no UI, flag unset, not allow-listed).
- Flip blockers (each becomes a B the moment a UI ships or the flag is set): blockers 1-6 in the verdict.

## U list
- None reachable.

## C one-liners
- C: edit_workout_plan derives no client data subject from `target_plan_id` (only clientId/client_id/target_client_id keys, ai-gateway.service.ts:613); harmless today because no plan data goes to the model.
- C: a sub-coach caller stamps `tenant_coach_id` = their own id (ai-gateway.controller.ts:87), so a created plan lands under the sub-coach, not the head coach.
- C: preferred snacks and the last coach message excerpt are sent for workout capabilities (minimisation).
- C: stub path skips assertRequesterMayActOn (already logged by AUDIT-14-125; drafts unapprovable by the requester anyway).

## How this differs from the coach AI drafts already live (src/ai/coach/, AUDIT-14-125)
- Live today: Client detail > Coach AI section > Generate workout program -> POST /coach/ai/workout-program. CoachAIService asks the
  model (Anthropic via the egress consent gate) for a whole JSON program, saves an AIDraft, the coach reviews/edits in
  AIWorkoutDraftScreen and approves it themselves (no requester rule), and materializeWorkoutProgram creates unassigned plans in the
  coach library (AUDIT-14 B1: copy said "assigned"; mobile fixed in m#425). Not metered either (AUDIT-14 U4).
- New (MWB-5 live-create, OFF): a generic gateway capability that writes a plan from a structured diff (add/update/remove/reorder ops)
  with plan revisions (author_kind 'ai'), template-seed forking and edit-in-place with an optimistic revision token, approved through
  the gateway approval queue. It adds revision history and editing of existing plans; it does not yet add AI authorship.

## Covered by open PRs
- None. Checked every open backend PR touching src/ai/gateway, src/ai-egress, ai-credits.constants or the manifest: b#803 (model
  pricing constants in the gateway cost estimate), b#605, b#593, b#592, b#587 — none touch metering of these capabilities, the
  approval rule, or a generator.

## PRs opened
- None (read-only). The only small fix (metering, ~2 lines + a test) does not change the verdict and would spend a T4 dual-lens review
  on code that stays off; better landed with the later lane.

## Not fixed (needs operator)
1. Metering: add `'draft.create_workout_plan'` and `'draft.edit_workout_plan'` to COACH_AI_METERED_CAPABILITIES
   (src/ai-credits/ai-credits.constants.ts:39-70). T4 (money), ~2 lines + 1 spec.
2. Approval dead end: let the tenant coach approve an AI-authored live-create draft (requester = AI/system actor when the server
   generates the payload), ai-approval.service.ts:92. T4, ~20-40 lines + tests. Needs blocker 1 first.
3. Generator + domain bounds + mobile UI + manifest entries: a full lane (T4), not a small fix.
4. Manifest: the FEATURE_MWB_AI_LIVE_CREATE `excluded` note says "R2b acceptance"; R2b is met. Suggest the note read: "Not built end
   to end: no generator, no mobile UI, not metered, coach cannot approve own draft (SAFE-MWBAI-125)". One-line docs change, operator's call.

## HANDOFF
Done. Verdict NO-GO, no PR, no worktree, no ci/* branches, no locks. Report complete at this path; notify line written to
/home/user/workspace/ops/lanes125/notify/SAFE-MWBAI-125.txt.
