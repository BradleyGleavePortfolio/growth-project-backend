# Changelog — The Growth Project Backend

All notable changes to the `growth-project-backend` are documented here.

---

## Phase 8 — Coach Command Center backend (2026-06)

### Added

**Module:** `src/coach-command-center/`

A new read-aggregation module that gives coaches a unified command dashboard.
No new database tables or migrations — every endpoint reads from existing columns.

**Endpoints:**

| Method | Path | Returns |
|--------|------|--------|
| `GET` | `/coach/command-center/overview` | Single payload: roster size, unread counts, risk distribution, action queue size, top 5 threads, top 5 win-streak leaders |
| `GET` | `/coach/command-center/at-risk` | Cursor-paginated at-risk list (delegates to existing `AdminPtmService.getRiskBoardForCoach` — zero duplicated risk math) |
| `GET` | `/coach/command-center/win-streaks` | Cursor-paginated leaderboard: 30-day check-in count per client, `first_win_completed_at` |
| `GET` | `/coach/command-center/inbox` | Cursor-paginated message thread list with unread counts, newest first |
| `GET` | `/coach/command-center/action-queue` | Paginated list of clients needing attention, classified by reason code (`unread_message`, `at_risk`, `missed_checkin`, `no_first_win`) |

**Privacy:** every endpoint scopes to `req.user.id` only.

**Tests added:** `test/coach-command-center.spec.ts` — 14 assertions.

---
