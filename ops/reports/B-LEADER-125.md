# B-LEADER-125 — leaderboard inside Community (agent 125, Claude Opus 5.5)

Start 15:06 PDT 10-06, hard stop 15:30. Mobile worktree /home/user/workspace/wt/B-LEADER-125-mobile from origin/main d16d5c15 (mobile main moved past a1904f2f).

## Verdict
GO for the entry point (no privacy B found). Merge only after owner confirms the leaderboard ships at launch (see "Needs operator/owner").

## Scope traced
- Backend (RO-backend 1ce430b9): src/leaderboard/leaderboard.controller.ts (GET /me/leaderboard, POST /me/leaderboard/opt-in; global JwtAuthGuard/RolesGuard), leaderboard.service.ts (score, roster scope, opt-in), leaderboard.dto.ts (displayName MaxLength 40), prisma schema User.show_on_leaderboard @default(false), signal writers: workout.service.ts:63, log.service.ts:56 (meal_logged per food entry), messaging.service.ts:967/973, check-ins.service.ts:160.
- Mobile: LeaderboardScreen, LeaderboardSettingsScreen, services/leaderboardApi.ts, CommunityTabScreen, CommunityNavigator, communityNavTypes, ClientNavigator MoreStack (~506).

## Audit answers
- Score: 30% check-ins (count of check-in submissions / 30), 25% workouts (/12), 20% meal_logged signals (/90, one per FOOD ENTRY not per meal), 15% messages to coach (/10), 10% current check-in streak (/30), all last 30 days, rounded 0-100. Truthful except the settings copy (U5, fixed).
- Privacy: opt-in default OFF (DB default false). Display name = user-set (max 40) or "First L." (never full name, fallback "Member"). No health numbers (weight, body fat, calories) in the response: only rank, userId, displayName, combinedScore, delta. Scope = same coach_id, deleted_at null, opted-in only; non-opted viewer is excluded from entries. No other coach's clients. b#747 already fixed the legacy /api/community/leaderboard opt-in + removed-member leak.
- Coachless: backend returns empty board, no error. Mobile showed an opt-in loop (U3, fixed).
- States: loading/error/empty existed; no Back, title under status bar (U2, fixed). Screen-reader rows fragmented (U6, fixed). Contrast: tokens textPrimary/textMuted/accent on bgPrimary, same as other screens; no change.

## B list
None.

## U list (all fixed in m#438)
- U1 No entry point: a client with a coach can never find the leaderboard. Added "Leaderboard" link in the Community tab header row (left of "Community safety"), routes registered on the Community stack (Back returns to the tab).
- U2 No Back control and title under the status bar on both leaderboard screens. Added Back + safe-area top inset.
- U3 Coachless client loops on an opt-in card that never takes effect. Link hidden without coach; screen shows a calm explanation, no API call.
- U4 No way to opt out after opting in (Settings unreachable). Settings link on the leaderboard; board refreshes on return.
- U5 Settings copy: "four habit signals" with five listed; "Meals ... 3-per-day target" while the server counts food entries. Corrected.
- U6 Screen reader reads rows as fragments. One accessibilityLabel per row.

## C one-liners
- C (edge, deferred to 10k clients): score cache is in-process per Fly machine; two machines can show slightly different scores/deltas for an hour.
- C (edge, deferred to 10k clients): weekDelta is "since last nightly recompute", not week-over-week; UI shows only "+n" (no "week" label), labelled "since the last update" for screen readers.
- C: GET scores opted-in roster members sequentially (5 count queries each, cached 1 h); fine at launch size.
- C: user-set display name is free text on a roster-only surface (no profanity filter); existing Community report/block covers Hall, not this board.
- C: opt-in failure shows the full-screen error and the typed display name is lost (retry works).
- C: Settings load failure leaves the switch showing "off" with an error banner (retry by leaving and reopening).

## Covered by open PRs
None touch leaderboard/community-tab files (checked m#411, #416, #427, #435, #436 file lists).

## PRs opened
- mobile m#438 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438 — branch agent125/b-leader-entry — head 27f773f330a05cdf843f6f8b6c36d1da8295f9c5 — 297 lines (260+/37-), 7 files. CI GREEN at head (Typecheck, lint, test SUCCESS; CodeQL + Analyze SUCCESS; merge state CLEAN). READY comment posted: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438#issuecomment-6026532208
- Backend: none needed.

## Needs operator/owner
1. Launch decision: SoT A7 lists LEADERBOARD_ENABLED under "Stay OFF for launch" and OR-113-13 kept no leaderboard entry for the clinic launch; owner 15:06 asks to flip it on. Backend is already ON by default in production. Recommended default: merge m#438 (owner asked; privacy audit clean). If the owner says no, leave m#438 unmerged; nothing is reachable without it.
2. Backend (optional, post-launch): count meals per (day, meal_type) instead of per food entry (leaderboard.service.ts computeScore mealCount, line 317) so the meal component means "meals". Copy now tells the truth either way.

## HANDOFF
- DONE. m#438 head 27f773f3 green, READY comment posted. Worktree removed (all work committed and pushed). No ci/* lane branches used.
- Remaining for operator: owner launch decision (item 1 above), then audit + merge of m#438 before the 10-07 build. Nothing else pending.
