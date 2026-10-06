FIX ROUND 1 (OPENING) (B-AIB1-125, agent 125) — growth-project-backend#807 @ 0cdafb37c685a092d5c64e5b8694238fed0f5303 — READY FOR AUDIT

CI at this head: 15 checks SUCCESS (build-and-test incl. Lint, Type-check, full Test; CodeQL; danger; R75 banned casts; rls-live-tests; schema parity), deploy-readiness-gate SKIPPED (by design on PRs). First push, no fix rounds.

Scope (332 lines, 306+/26-): AiApprovalService.decide tenant + roster check moved before the requester rule (null-tenant drafts refused for coaches; subject.coach_id must be the deciding coach); requester rule relaxed only for a tenant coach on a model-authored payload or in a tenant with no active sub-coach; owners still bound. SendNotificationMaterializer roster check + materialised_at/ref write. Tests: coach approves/rejects own AI draft, coach cannot decide another coach's client's draft (own tenant and foreign tenant), null tenant refused, owner still bound, materialiser roster (foreign client, subject mismatch, no tenant) and materialised_ref write.

Lens focus: the `isModelAuthoredPayload` signal (gateway default `{reply}` matched against the stored rationale; no schema change) and the single-coach-tenant exemption for human-written drafts (from the JOBS125 entry; operator may narrow it to AI-authored only by deleting the subCoach count branch).
