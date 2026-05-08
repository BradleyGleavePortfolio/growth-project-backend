# Leaderboard — Phase 7C

Peer leaderboard scoped to a coach's client roster. Opt-in by default — clients
appear only after explicitly enabling the feature. Raw health, weight, and
finance numbers are never surfaced.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/me/leaderboard` | JWT | Returns the ranked leaderboard for the requesting user's coach roster. |
| `POST` | `/me/leaderboard/opt-in` | JWT | Opts the requesting user in or out. |

### `GET /me/leaderboard`

Returns the leaderboard scoped to the requesting user's coach roster.

**Response**

```json
{
  "entries": [
    {
      "rank": 1,
      "userId": "cuid...",
      "displayName": "Amara O.",
      "combinedScore": 87,
      "weekDelta": 4,
      "isRequester": false
    }
  ],
  "selfRank": 3
}
```

- `combinedScore` — integer in `[0, 100]`. Never raw weight, body fat, or finance data.
- `weekDelta` — change since the previous nightly computation. `null` on first computation.
- `selfRank` — the requesting user's current rank, even if they are not opted in.
- Only opted-in users appear in `entries`. The requester's row is always present.

### `POST /me/leaderboard/opt-in`

**Body**

```json
{
  "enabled": true,
  "displayName": "Alex T."
}
```

- `enabled` — required. `true` = appear on the leaderboard; `false` = hide.
- `displayName` — optional. Max 40 characters. If omitted, the service derives
  `"{firstName} {lastInitial}."` from the user's profile. Cleared on opt-out.

---

## Combined Score Formula

A weighted sum of recent (last 30 days) habit completion rates:

| Component | Weight | Calculation |
|-----------|--------|-------------|
| Check-in completion | 30% | `actual_checkins / 30` |
| Workout logged | 25% | `workouts_in_30d / 12`, capped at 1.0 |
| Meal logged | 20% | `meals_in_30d / 90`, capped at 1.0 |
| Coach engagement | 15% | `messages_to_coach_in_30d / 10`, capped at 1.0 |
| Streak bonus | 10% | `current_checkin_streak / 30`, capped at 1.0 |

`finalScore = round(sum * 100)` — range `[0, 100]`.

Each component is independently capped at 1.0 so exceptional performance in one
area cannot compensate for total absence in another.

---

## Caching

- Per-user scores are cached in memory for **1 hour** (`SCORE_TTL_MS`).
- The nightly scheduler (`LeaderboardScheduler`) warm-recomputes all opted-in
  users at 06:00 UTC, so daytime reads nearly always hit the cache.
- Cache entries are evicted immediately on opt-out.

---

## Privacy

- Display names are either user-configured (max 40 chars) or derived as
  `"{firstName} {lastInitial}."`.
- Raw weight, body fat, income, and finance data are **never** returned.
- Scope is restricted to the requesting user's coach roster — never platform-wide.
- Default is **opt-out**. Users must explicitly set `enabled: true`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LEADERBOARD_RECOMPUTE_CRON` | `0 6 * * *` | Cron expression (UTC) for the nightly recompute. |
| `LEADERBOARD_ENABLED` | `on` | Kill switch. Set to `off` to disable all leaderboard reads and writes. |

---

## Module Registration

Add `LeaderboardModule` to `AppModule.imports` in `src/app.module.ts`:

```typescript
import { LeaderboardModule } from './leaderboard/leaderboard.module';

@Module({
  imports: [
    // … existing modules …
    LeaderboardModule,
  ],
})
export class AppModule {}
```

---

## Tests

| File | What it pins |
|------|-------------|
| `test/leaderboard.service.spec.ts` | Formula correctness, opt-out exclusion, coach-roster scoping, display name derivation, score clamping, kill switch. |
| `test/leaderboard.controller.spec.ts` | Auth identity forwarding, opt-in flow, response shapes. |
