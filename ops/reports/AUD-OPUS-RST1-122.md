# AUD-OPUS-RST1-122 — Opus lens, coach "Restart plan" growth-project-mobile#380 (first review, T4 money)

Agent 122 lens, Claude Opus 5.5. Started 17:21 PDT, verdict posted 17:26 PDT 2026-10-05 (times from `TZ=America/Los_Angeles date`).

## Verdict
AUDIT Claude Opus 5.5 — growth-project-mobile#380 @ b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 — VERDICT: APPROVE

A 0 / B 0 / C 6. Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380#issuecomment-6006450497
(body also at ops/aud-122/AUD-OPUS-RST1-122/comment_380.md). Head checked just before posting (unchanged).

## What was checked
- PR: 4 files, +549 / -0, base agent115/lockout-split-3-card-update-tests @ be5c74b1 (merge-base equal). CI "Typecheck, lint, test" success at head.
- Backend reference: b#687 pull/687/head @ 2f11f14bb8c361d72dc0f5db8e0725801a83b821 (b#690 restart route landed): dunning-restart.controller.ts,
  DunningV2Service.restartAfterDisputePause / restartCandidate / restartUnderLease, CoachPurchasesController.list (GET /v1/coach/purchases),
  CoachPaymentOpsController.getOwn (GET /v1/coach/payments/purchases/:id, returns `dunning` row via COACH_DUNNING_SELECT), coach-payments.select.ts.
- Button gating mirrors the backend not_paused pre-check (dunning active + charge_disputed + entered_at) plus recurring and not ended; reads are coach-scoped server side; clientId is the client user id.
- Confirm dialog present; success shows "Plan restarted" and hides the button; pull-to-refresh re-reads.
- Every backend refusal code (incl. flag_off -> PLAN_NOT_DISPUTE_PAUSED, billing_resume_failed -> BILLING_UNAVAILABLE) maps to the backend's own sentence; interceptor keeps error.response for 404/409/503.
- Tenant safety: backend 404s any purchase whose coach_user_id is not the caller before any Stripe call; client role gets 403.

## Cs (follow-ups)
- C-380-1 C (edge, deferred to 10k clients): "billing is paused" copy without the backend billing_paused flag (not in COACH_DUNNING_SELECT).
- C-380-2 C (edge, deferred to 10k clients): roster read capped at 5 x 100 purchases.
- C-380-3: whole-roster read per client-detail open; add a backend client filter.
- C-380-4: unmapped error shows the raw server message (5xx INTERNAL could be technical); map 5xx to UNKNOWN_REFUSAL.
- C-380-5: no coach push deep link to ClientDetail (comment claims "the screen the coach dispute alert opens"); coach email path "Clients, then name" matches.
- C-380-6 C (edge, deferred to 10k clients): plans not cleared when clientId changes on a mounted screen.

## Housekeeping
- Claim: ops/lanes122/claims/mobile-380-b49d7147-opus.
- No worktrees, no branches, no ci-lane runs, no pushes. Local refs only: growth-project-mobile refs/remotes/audit/pr380, growth-project-backend refs/remotes/audit/pr687 (fetch refs, harmless).
- Did not read Sol's RST1 work.

## HANDOFF
Done. Opus verdict APPROVE posted at b49d7147 (comment 6006450497). Nothing left for this lens. Operator: pair with the Sol RST1 verdict at the same head;
if both APPROVE and m#354 lands, m#380 is mergeable at b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 with green checks. If the head moves, a delta re-review is needed.
Cs above go to follow-up tickets (C-380-4 and C-380-5 are the useful ones).
