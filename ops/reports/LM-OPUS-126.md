# LM-OPUS-126 (Claude Opus 5.5, MOBILE AI builder lens) — report

Started 18:00 PDT 10-06 (times from `TZ=America/Los_Angeles date`).
Queue: (1) m#439 after B-AIB5P-126's new READY; (2) B-AIB6-126's PR when READY; (3) agent126/ FU mobile PRs if LF pair has not reached them.

## Status
- 18:03 m#439 head still c138b4c4 (agent 125 READY only). Waiting for B-AIB5P-126 new READY; pre-reading code meanwhile.

## Pre-read notes (m#439 @ c138b4c4, before the new head)
Cross-checked against backend main f71bb9a4 and open b#809 @ c0984e2a, b#808 @ 9487faa2.
- P1 PATCH /ai/gateway/drafts/:id (live on prod today; b#809 keeps it) returns the raw AiActionDraft row, so
  `materialised_ref` is a STRING (plan id) (RO-backend src/ai/gateway/ai-approval.service.ts decide() returns `updated`;
  edit materialiser returns `ref: editedPlanId`; mobile main already types it `materialised_ref?: string | null`
  in src/api/types/coachAiExecution.ts:166). m#439 src/api/aiBuilderApi.ts:43-46 DecideSchema requires an object or null ->
  ZodError -> 'contract' copy "Your workout is unchanged" AFTER the server applied the change.
- P2 b#809 ValidatedChange.exercise is `| null` for remove_exercise / reorder / plan_meta (validator
  `exercise: exId ? {...} : null`), and the create prompt always asks for a plan_meta name. m#439 ChangeSchema
  (aiBuilderApi.ts:29) requires a non-null exercise -> whole proposal fails zod -> 'contract' copy for create on a blank
  workout, Shorten (removals), any reorder.
- P3 b#809 explain returns `draft_id: null` (resolveProposedAction returns null -> no draft). m#439 ProposalSchema
  draft_id `z.string().min(1)` -> Explain chip always shows the 'contract' copy.
- b#809 propose body is `.strict()`: mobile keys mode/plan_id/lock_token?/instruction/quick_action?/injury_area? all allowed;
  lock_token optional on the server (ok).
- b#808 status route path + shape match m#439 StatusSchema.

## Timeline
- 18:08 m#439 new head 63417260 pushed (B-AIB5P-126: paused/not_configured visible with paused copy, network -> retry, no lock token -> none sent).
- 18:15 B-AIB5P-126 READY @ 63417260 (CI green: Typecheck/lint/test, CodeQL). SAFE-AIB-PRE-126 posted 2 blockers at the same head.
- 18:21 Operator mail: do not approve 63417260; builder is fixing B1/B2; verify against agent126/b-aib2-126 at the next head.
  Decision: no verdict posted at 63417260 (superseded by the coming head). My independent pre-read (P1-P3 above, written
  18:05 before seeing the pre-pass) confirms both blockers are still present at 63417260:
  - P1 still present: aiBuilderApi.ts:40-41 RefSchema object; backend decide returns materialised_ref String? (schema.prisma
    AiActionDraft.materialised_ref String?; ai-approval.service.ts decide returns the row).
  - P2 still present: aiBuilderApi.ts:29 exercise non-null; P3 still present: aiBuilderApi.ts:34 draft_id min(1).
  Paused/not_configured/network/404 behaviour at 63417260 checked OK (useAiBuilder.ts loadStatus; AiBuilderSheet blocked + retry).
- 18:22 new head 030e5721 (B1/B2 fixes against the real b#809 shapes); b#809 moved to 8b82ead8; stacked agent126/b-aib2b-126 @ b83e0357.
- 18:27 B-AIB5P-126 READY @ 030e5721; CI green (Typecheck/lint/test, CodeQL); 798 lines.
- 18:30 POSTED verdict APPROVE (B=0, U=1, C=4): https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439#issuecomment-6028931507
  Full text: /home/user/workspace/ops/aud-126/LM-OPUS-126/mobile-439.md. Notify line written.

## Verdicts
| PR | head | verdict | B | U | C |
|---|---|---|---|---|---|
| m#439 | 030e5721 | APPROVE | 0 | 1 | 4 |
| m#443 | 502205bb | APPROVE (missed B-443-1, see correction) | 0 | 1 | 3 |
| m#439 r2 | 63076852 | APPROVE (delta: B-439-1 fixed) | 0 | 1 | 2 |
| m#443 r2 | 276bec2b | APPROVE (delta: B-443-1 + U-443-1 fixed) | 0 | 0 | 3 |

## Needs operator
1. FLIP gate: b#809 + stacked agent126/b-aib2b-126 must be deployed before FLIP. On main, PATCH /ai/gateway/drafts/:id ignores
   accepted_change_ids (inline body type, so ValidationPipe skips it), so unticked cards would be applied anyway, and a coach with
   an active sub-coach gets 403 on Apply. Default: hold FLIP until both deploy.
2. U-439-1 (optional follow-up, AIB-6 or a small m#439 follow-up): count a "Moved" card as kept only when every other card is kept
   (useAiBuilder.ts:103).

## HANDOFF
Queue next: (2) B-AIB6-126's mobile PR when READY; (3) agent126/ FU mobile PRs (m#440 FU-COPY READY 18:14, m#441/m#442?) only if the
LF pair has not reached them. Poll every 3 min, for up to 30 min.

## Lens disagreement on m#439 @ 030e5721 (read LM-SOL after posting mine, 18:33)
LM-SOL-126 REQUEST CHANGES B-439-1: on the string-ref fallback, runReplayRefetch bumps refetchSeq synchronously
(CoachWorkoutBuilderScreen.tsx:718-726), so the adoption effect (:904-1037) adopts the still-cached pre-Apply plan and then
ignores the fresh GET. Sol's probe log (ops/aud-126/LM-SOL-126/evidence/mobile-439-fallback-probe.log) fails as described.
My read: the code finding is valid. It is reached in normal use only when the approve reply has no lock_token. The stacked
agent126/b-aib2b-126 (b83e0357, ai-approval.service.ts:466-486) returns { plan_id, revision_index, lock_token }, which takes the
direct-adopt path. With the FLIP gate (stacked PR deployed first) it is therefore only reached when the refetch errors or the
autosave secret is missing. Operator decides (A2 item 5). Recommended default: take the small fix now, because the store binary
freezes 10-07. The fix: in aiOnApplied's fallback, adopt the awaited refetchPlan() result directly instead of runReplayRefetch.
Then a delta re-review.

## New finding after my verdict (18:40). FLIP blocker, backend. Needs operator, routed to b#809's builder or the LB lens.
Standalone workouts have no revision baseline, so Ask AI on them always ends at "changed on another screen".
- Story: a coach creates a workout in the builder (Save goes to POST /workout-plans), reopens it and taps Ask AI. Every request
  returns 409 REVISION_STALE: "This workout changed on another screen. Reload it and ask again." Reloading does not help.
- Evidence: backend main src/workout-builder/workout-builder.service.ts:362-375. createPlan writes no WorkoutPlanRevision and
  leaves head_revision_id null. Only program days (program-library.service.ts:815-840), copies (workout-builder.service.ts:1012),
  onboarding and AI-created plans get revision 0. b#809 @ 8b82ead8 workout-builder-ai.service.ts: `if (!plan.head_revision_id)
  throw stale()`. The autosave service gives the same 409 ("Plan has no revision baseline", workout-builder-autosave.service.ts:653-657).
- Program-day workouts (with baselines) work. Standalone library workouts do not. The plan names both as targets.
- Smallest fix (backend, T4 builder): in b#809 propose, when head_revision_id is null, write a revision-0 baseline from the current
  exercises in the same transaction (the copyProgramPlans pattern at workout-builder.service.ts:1010-1031) and continue.
  Alternative: createPlan writes revision 0, plus a one-off backfill for existing standalone plans. A mobile change cannot fix this.
  The app's copy is only misleading as a side effect.
- Default: hold the FLIP until this is fixed. m#439 can still merge, because the entry shows paused until the FLIP.
- 18:33 B-AIB6-126 READY m#443 @ 502205bb (stacked on m#439 030e5721; CI green; 690 lines).
- 18:36 POSTED m#443 APPROVE (B=0, U=1 RevisionHistorySheet ignores Reduce Motion, C=3):
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/443#issuecomment-6029000342 (text: ops/aud-126/LM-OPUS-126/mobile-443.md)
- 18:50 LENS MISS (my own, recorded plainly). My APPROVE of m#443 @ 502205bb missed B-443-1, which both Sol lenses found and which I
  confirmed after posting. WeekAiSheet keyed every day's keep choice by the bare change_id. b#809 restarts ids at c0 in each
  proposal (workout-diff.validator.ts:150 @ 8b82ead8), so Monday c0 and Tuesday c0 shared one switch. A coach could not reject one
  without rejecting the other, and turning one back on re-enabled a change the coach had rejected. My test fixture check missed it
  (the fixture used the disjoint ids a1/a2/b1). New head 276bec2b keys selection by `${plan_id}:${change_id}` and still sends bare ids,
  with a c0/c0 regression. It also fixes my U-443-1 (the History sheet now fades when Reduce Motion is on). Delta review is pending READY.
- 18:46 m#439 new head 63076852 (Sol's B-439-1 fix + merge of main). aiOnApplied now awaits refetchPlan() and always adopts the
  fresh copy. With a token it calls adoptServerHead. With no token it calls rebaselineTo(fresh) and resets the undo history. Only a failed read uses runReplayRefetch.
  Delta review is pending READY.
- 18:55 POSTED m#439 r2 APPROVE @ 63076852 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/439#issuecomment-6029222378
- 18:55 POSTED m#443 r2 APPROVE @ 276bec2b https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/443#issuecomment-6029222833
  (The verdict text includes a plain correction that my round-1 approval missed B-443-1.)
- m#448 (FU-WORKLOG2) has an LF-SOL-126 verdict, so the LF pair reached it and I skipped it. m#441 has dual LF verdicts. m#440, #442, #444, #445 and #446 are merged.
- Queue empty at 18:55. Polling every 3 min.

## HANDOFF (DRAIN, operator 18:56; written 19:02 PDT)
Stopped at the operator's DRAIN. No verdict was in progress, so nothing is half-posted. I made no probe worktree (wt/RO-* are the
operator's shared read-only checkouts), so there was nothing to remove. I opened no PRs and pushed nothing.

Verdicts posted (all REST comments on mobile; notify lines in ops/lanes126/notify/LM-OPUS-126.txt):
- m#439 @ 030e5721 APPROVE B=0 (U-439-1). m#439 r2 @ 63076852 APPROVE B=0 (Sol's B-439-1 fixed). m#439 is now MERGED at 63076852.
- m#443 @ 502205bb APPROVE B=0. This MISSED B-443-1, as recorded above. m#443 r2 @ 276bec2b APPROVE B=0 (B-443-1 + U-443-1 fixed).

PRs I did NOT get to (for the LX pair):
- m#443 @ 82d8b252 (agent126/b-aib6-126, still open). A new head was pushed after my r2 APPROVE at 276bec2b, probably a retarget or merge onto
  main after m#439 merged. It is not reviewed by me. Check that the delta from 276bec2b is only the base merge and that CI is green.
- m#441, m#448 and m#449 (FU builders): merged, with LF/LX lenses at their heads. I did not review them.

Still open for the operator:
1. FLIP gate: deploy b#809 + b#815 (stacked subset approve and lock_token materialised_ref) before turning Ask AI on. Without b#815,
   accepted_change_ids is ignored on main and unticked cards get applied.
2. FLIP blocker (backend): standalone workouts created through POST /workout-plans have no revision baseline
   (workout-builder.service.ts:362-375), so b#809 propose returns 409 "changed on another screen" for them. Fix: write revision 0
   in propose when the head is null, or in createPlan plus a backfill. Default: hold the FLIP until fixed. Program days work.
3. U-439-1 (not fixed, merged): with a "Moved" card kept and another card unticked, the Apply count is one too high. Small follow-up.
