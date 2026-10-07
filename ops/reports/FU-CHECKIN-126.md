# FU-CHECKIN-126 — coach check-in review + Coach Home leftovers (Claude Opus 5.5, agent 126)

Start 18:03 PDT 10-06. Hard stop 19:25 (JOBS) / 19:30 (task). Baseline mobile main 950689af, backend main f71bb9a4.
Worktree /home/user/workspace/wt/FU-CHECKIN-126-mobile, branch agent126/fu-checkin-126.

## Status
- 18:24 DONE. m#442 CI green at 4ecb5e4b (Typecheck, lint, test SUCCESS; CodeQL SUCCESS x3). READY comment posted 18:23. Worktree removed (all work pushed). No ci/* branches created.
- 18:18 m#442 opened @ 4ecb5e4b (+437/-142 = 579 lines); local targeted jest green; waiting for PR CI.
- 18:07 findings confirmed on main; worktree created; building.

## Scope traced (screens + routes)
- Coach ClientDetailScreen > Timeline tab (TimelineTab, useClientDetailData.loadTimeline) -> GET /coach/clients/:id/timeline (coach.service getClientTimeline returns full CheckIn rows incl. id, coach_id, reviewed_by_coach).
- POST /coach/clients/:client_id/check-ins/:check_in_id/reviewed (coach-check-ins.controller -> check-ins.service.markReviewedByCoach; authorises by CheckIn.coach_id = caller; 404 otherwise). No mobile caller on main.
- Clients list "N to review" badge (m#408, merged; utils/coach/clientRoster.ts) counts reviewed_by_coach=false by user_id (backend coach.service.ts:236).
- Overview tab (OverviewScreen) -> GET /coach/command-center/overview: pending_actions = unreviewed CheckIns ever (command-center.service.ts:313); open_alerts = unacknowledged CoachAlerts = Action Queue total_pending (same where clause).
- CoachLtvDashboard -> /coach/command-center/ltv-metrics: nrr_is_stub is always true (ltv-metrics.service.ts:439); no CAC setting exists anywhere.
- ClientInsightScreen "Schedule call": toast only; no coach-side "book a session for this client" screen exists in CoachNavigator.
- AtRiskScreen empty state; PTM recompute is nightly (ptm.scheduler.ts 'ptm-recompute-nightly'), factors = missed check-ins, no app open, no weight/workout/meal logged, streak drop.

## B list
- none.

## U list (all confirmed on main 950689af)
- U4 (AUDIT-06): a coach opens a client's Timeline, sees the check-in, and has no way to mark it reviewed, so the Clients list "N to review" badge never goes down.
- U-A13-5: a coach sees "Pending actions 14" on Overview, taps it, and lands on an Action Queue with a different number (alerts, not check-ins); the tile only ever grows.
- U-A13-6: a coach reads "LTV:CAC ratio — Add your CAC in Settings to unlock this" and "Add CAC in Settings", but no CAC setting exists; NRR hint says "connect billing" (nothing to connect); a coach with no clients sees NRR 100% (est.) and churn 0%.
- U-A13-7: a coach taps "Schedule call" on a weekly insight and gets a toast "Booking integration pending"; dead button.
- U-A13-8: a coach with no at-risk clients reads "All 0.3+ risk-score clients ... nightly PTM score run" (internal jargon).

## C one-liners
- C (edge, deferred to 10k clients): check-ins logged before the client joined a coach have coach_id null, and sub-coach callers do not match CheckIn.coach_id; markReviewedByCoach 404s for both, so the badge (counted by user_id) cannot clear for those rows. Mobile hides the button for rows it cannot review.

## Covered by open PRs
- none (open mobile PRs: m#439 AI builder files only; no overlap).

## PRs opened
- mobile m#442 `agent126/fu-checkin-126` @ 4ecb5e4b368afc1401dc5847a0334e2b19f4a116: 10 files, +437/-142 (579). Fixes U4, U-A13-5, -6, -7, -8. CI green (Typecheck, lint, test; CodeQL; Analyze x2). READY comment 18:23: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/442#issuecomment-6028855078

## Not fixed (needs operator)
- C/T4 (optional, post-launch): backend src/check-ins/check-ins.service.ts:379 assertCheckInOfCoach matches CheckIn.coach_id only, so pre-coach check-ins (coach_id null) and sub-coaches cannot mark reviewed, yet coach.service.ts:236 / command-center.service.ts:315 count by user_id. Smallest fix: controller passes client_id; service authorises with assertClientOfCoach(coachId, clientId) (or SubCoachScope) plus `where: { id, user_id: clientId }`. T4 (auth) -> Claude Opus builder; recommended default: after launch.

## HANDOFF
- m#442 (branch agent126/fu-checkin-126) @ 4ecb5e4b is pushed, green and READY. The worktree was removed after the push; nothing is unsaved. PR body: ops/reports/FU-CHECKIN-126-pr-body.md.
- Next: LF lens pair review at 4ecb5e4b, then the operator merges. If a lens asks for changes, recreate the worktree from origin/agent126/fu-checkin-126 and keep the total under 600 lines (currently 579).
- Optional backend follow-up (T4, post-launch): see "Not fixed (needs operator)".
