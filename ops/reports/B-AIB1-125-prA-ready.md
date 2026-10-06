FIX ROUND 1 (OPENING) (B-AIB1-125, agent 125) — growth-project-backend#805 @ 41493e417143c74140fdd5c7cf6957b35513d1a3 — READY FOR AUDIT

CI at this head: 15 checks SUCCESS (build-and-test incl. Lint, Type-check, full Test; CodeQL; danger; R75 banned casts; rls/community/mwb-3 live tests; schema parity), deploy-readiness-gate SKIPPED (by design on PRs).
Pushed three times: 4bbb4a7a (opening), 3ded9ea1 (specific pool-exhausted copy with no purchase wording, since CoachAiSection shows `message` verbatim on iOS), 41493e41 (CI at 3ded9ea1 was red from this change: test/privacy/no-pii-in-logs.spec.ts flagged the new debit-failure log interpolating exception text; it now logs the error name only).

Scope (272 lines, 270+/2-): COACH_AI_METERED_CAPABILITIES + insight, draft.create_workout_plan, draft.edit_workout_plan; CoachAIService.generate* (workout program, meal plan, client insight) run the gateway's pre-call pool gate (402 COACH_AI_BUDGET_EXHAUSTED, before any provider call or draft) and debit AnthropicAdapter.computeCostCents after the call (head coach's pool for a sub-coach; failed debit logged, not thrown). test/ai/coach-ai-metering.spec.ts 17 tests, fail on main.
Overlap: B-AIASSIGN-125 edits CoachAIService.approveDraft in the same file (different methods).
