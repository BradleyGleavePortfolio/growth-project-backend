# Coach Command Center — `src/coach-command-center/`

## Purpose

The Coach Command Center is the unified read-aggregation layer for the coach dashboard (Phase 8). It surfaces the data that the client-side features (Phase 7A first-win, Phase 7B/7C timeline + leaderboard, Phase 1B/1E PTM risk board) already produce — without duplicating any business logic. A coach can see:

- An overview snapshot (roster size, unread messages, risk distribution, action queue size, and their top 5 threads and win-streak leaders) in a single HTTP round-trip.
- A paginated at-risk client list (delegates to the existing `AdminPtmService.getRiskBoardForCoach` — zero duplicated risk math).
- A win-streak leaderboard (30-day check-in count per client, plus `first_win_completed_at`).
- A paginated message inbox (one thread per client, newest first, with unread counts).
- A prioritised action queue (clients needing coach response, classified by reason code).

Every endpoint is scoped to the calling coach's own roster via `req.user.id`. Cross-coach isolation is enforced at the service layer and verified in the integration tests.

---

## Endpoint Table

| Method | Path | Auth / Role | Request | Response shape |
|--------|------|-------------|---------|----------------|
| `GET` | `/coach/command-center/overview` | JWT + `coach` or `owner` | — | `OverviewResponse` |
| `GET` | `/coach/command-center/at-risk` | JWT + `coach` or `owner` | `?bucket=green\|amber\|red&cursor=ISO&limit=N` | `CoachRiskBoardResponse` |
| `GET` | `/coach/command-center/win-streaks` | JWT + `coach` or `owner` | `?cursor=ISO&limit=N` | `WinStreakResponse` |
| `GET` | `/coach/command-center/inbox` | JWT + `coach` or `owner` | `?cursor=ISO&limit=N` | `InboxResponse` |
| `GET` | `/coach/command-center/action-queue` | JWT + `coach` or `owner` | `?reason_code=unread_message\|at_risk\|missed_checkin\|no_first_win&cursor=ISO&limit=N` | `ActionQueueResponse` |

### `OverviewResponse` shape

```json
{
  "total_clients": 12,
  "clients_with_unread_messages": 3,
  "risk_counts": { "red": 2, "amber": 4, "green": 5, "no_data": 1 },
  "action_queue_size": 6,
  "top_inbox_threads": [ /* up to 5 InboxThread objects */ ],
  "top_win_streaks": [ /* up to 5 WinStreakRow objects */ ],
  "generated_at": "2026-06-01T10:00:00.000Z"
}
```

### `InboxThread` shape

```json
{
  "client_id": "uuid",
  "client_name": "Alice",
  "client_email": "alice@example.com",
  "last_message_at": "ISO-8601",
  "last_message_preview": "First 120 chars of last message body, or null if voice-only",
  "last_message_is_voice": false,
  "unread_count": 2
}
```

### `WinStreakRow` shape

```json
{
  "client_id": "uuid",
  "client_name": "Bob",
  "first_win_at": "ISO-8601 or null",
  "checkins_last_30_days": 24,
  "last_checkin_at": "ISO-8601 or null"
}
```

### `ActionQueueItem` shape

```json
{
  "client_id": "uuid",
  "client_name": "Carol",
  "client_email": "carol@example.com",
  "reason_code": "unread_message",
  "reason_detail": "3 unread messages from this client.",
  "signal_at": "ISO-8601"
}
```

Reason code priority (each client appears at most once):
1. `unread_message` — client sent an unread message.
2. `at_risk` — PTM `risk_score >= 0.6` (red bucket).
3. `missed_checkin` — no check-in in the last 3 days.
4. `no_first_win` — `first_win_completed_at` is null.

---

## Prisma Models Touched

| Model | Fields read | Purpose |
|-------|-------------|---------|
| `User` | `id`, `name`, `email`, `coach_id`, `role`, `archived_at`, `deleted_at`, `first_win_completed_at`, `created_at` | Roster lookup, win-streak data |
| `PtmPrediction` | `user_id`, `risk_score`, `computed_at` | Risk bucket for overview + action queue |
| `CheckIn` | `user_id`, `date`, `logged_at` | 30-day check-in count for leaderboard + missed-checkin detection |
| `CoachMessage` | `coach_id`, `client_id`, `sender_id`, `body`, `voice_url`, `created_at`, `read_at` | Inbox threads + unread counts |

**No new columns, no migrations.** This phase is read-only aggregation.

---

## Env Vars

This module introduces no new env vars. Page size defaults (`DEFAULT_PAGE_SIZE=20`, `MAX_PAGE_SIZE=100`) are compile-time constants inside `coach-command-center.service.ts`. They can be made configurable if needed in a future iteration.

---

## Tests

| File | What it asserts |
|------|----------------|
| `test/coach-command-center.spec.ts` | Role-guard rejection for non-coach (student gets 403); cross-coach isolation (coachA cannot see coachB's clients); happy-path overview with seeded fixtures; empty-roster scenario; inbox pagination cursor; action-queue reason-code filter; win-streak leaderboard ordering |

---

## Future Work / Known Limits

- **Read mark on inbox**: the inbox endpoint returns unread counts but does not provide a `POST /coach/command-center/inbox/:clientId/read` endpoint to mark a thread read. This can be added as a Phase 8 follow-up; the `read_at` column already exists on `CoachMessage`.
- **Action queue cursor stability**: the cursor is based on `created_at` of the last User row fetched. If a client is added between pages, the next page may skip one client. This is acceptable for a dashboard view; a stable keyset cursor (by `id`) can replace it if exact completeness is required.
- **Caching**: the `overview` endpoint queries live Postgres on every request. At high roster sizes (200+ clients per coach) a 60-second Redis cache keyed by `coachId` would reduce load without meaningfully hurting freshness.
