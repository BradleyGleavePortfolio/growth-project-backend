# M-RESTART-122 — mobile coach "Restart plan" for a dispute-paused client plan (agent 122)

Started 17:04 PDT 2026-10-05. Time box 17:49 PDT. Builder: Claude Opus.
Read: _COMMON_122 (all), JOBS122 entry M-RESTART-122, SoT A1, A2 overrides 1-11, A5 rules 11-12.

## Inputs verified on GitHub
- Lockout stack heads match the entry: m#352 da686cea, m#353 78ed4e07, m#354 be5c74b1 (branch agent115/lockout-split-3-card-update-tests). Mobile main f5c399a7.
- Backend b#690 5d41f767 `src/checkout/dunning-v2/dunning-restart.controller.ts`: POST /v1/coach/purchases/:id/dispute-restart, body on refusal
  `{ code, error: code, message }`; 404 PURCHASE_NOT_FOUND; 409 PLAN_NOT_DISPUTE_PAUSED (also flag_off), PLAN_ENDED, OTHER_LIVE_PLAN,
  NEW_DISPUTE, BILLING_BUSY; 503 BILLING_UNAVAILABLE (billing_unavailable + billing_resume_failed); fallback 409 RESTART_REFUSED.
- Dispute-paused signal the coach can read: GET /v1/coach/payments/purchases/:id returns `dunning` (COACH_DUNNING_SELECT:
  status, last_failure_reason, entered_at, locked_out_at). Backend restartCandidate: status 'active' + last_failure_reason
  'charge_disputed' + entered_at set; purchase not canceled/expired/incomplete_expired, recurring. The pause leaves purchase.status
  unchanged and sets entitlement_active false (so GET /v1/coach/payments/failed does NOT list it).

## Placement decision
- No coach-side purchase view existed in mobile main or the lockout stack (the lockout stack is client-side only). The backend's
  coach dunning alerts deep-link to `tgp://coach/clients/<client_user_id>` (dunning-v2.service.ts dunningDetailDeeplink), i.e. the
  coach ClientDetailScreen. So the card lives at the top of ClientDetailScreen (all tabs).
- Data path: GET /v1/coach/purchases (limit 100, follows next_cursor up to 5 pages) -> this client's recurring rows with
  entitlement_active false and not ended -> GET /v1/coach/payments/purchases/:id for each -> card only when the dunning row is
  dispute-paused. Read failure -> card hidden.

## Work
- PR m#380 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380
  head agent122/coach-dispute-restart b49d714777b6eaf2df12b200abbf2fc3eb78a1d5, base agent115/lockout-split-3-card-update-tests
  (m#354). Size 549 (+549/-0, 4 files; test 214).
- Files: src/entitlements/dunning/coachDisputeRestart.ts (API + detection + refusal copy), src/components/coach/DisputePausedPlansCard.tsx
  (card, confirm dialog, outcomes), src/screens/coach/ClientDetailScreen.tsx (+10: mount + pull-to-refresh reload key),
  src/entitlements/dunning/__tests__/coachDisputeRestart.test.tsx (20 tests).
- Local: that single jest file via heavy.sh, 20/20 pass.
- Lane ci/M-RESTART-122-1 run 37392952996 (tsc + new spec + quietLuxuryDoctrine, skeleton, coachSaasBlockers, clientWearablePromptsRoute):
  GREEN (tsc pass; 5 suites / 90 tests). Lane branch deleted.
- PR CI "Typecheck, lint, test" run 37392943563 at b49d7147: GREEN (17:19 PDT).
- Comment FIX ROUND 1 (OPENING) + READY FOR AUDIT 17:19 PDT:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/380#issuecomment-6006316073 (draft ops/aud-122/M-RESTART-122/c380.md).
- Notify: ops/lanes122/notify/m-restart.txt. Worktree wt/M-RESTART-122-1 removed (no unsaved work). No locks taken.

## Decisions (recommended defaults)
1. Placement on the coach client detail screen (dispute alert deep link target), not the package subscribers list. Default keep.
   (Subscribers list rows carry no dunning data, and that screen's camelCase type does not match the backend's snake_case rows.)
2. Refusal copy is mobile-owned per code (same wording as the backend messages); unknown codes show the server message, else a
   specific fallback. Default keep.

## Edge items
- C (edge, deferred to 10k clients): roster read stops after 5 pages (500 purchases) per coach.
- C (outside scope, noticed): CoachPackageSubscribersScreen expects a camelCase shape and 4 statuses; the backend returns
  COACH_PURCHASE_SELECT rows (snake_case, more statuses), so an unknown status would hit `copy.tone` on undefined. Not touched.

## HANDOFF
Done at 17:20 PDT. m#380 head b49d714777b6eaf2df12b200abbf2fc3eb78a1d5 (branch agent122/coach-dispute-restart), base m#354 branch,
READY FOR AUDIT for both lenses (T4). PR CI and lane green. Next: Opus + Sol lenses at that exact head; a fix round, if any, works in a
fresh worktree on agent122/coach-dispute-restart (one push, FIX ROUND 2 comment). If m#354's branch moves (lockout fix round or main
refresh), m#380 needs a clean merge of the new m#354 head and a RESTACK comment. Lands after m#352-#354 and after backend b#690 deploys.
