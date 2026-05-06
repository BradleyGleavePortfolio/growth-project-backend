# Timeline — Phase 7B

The Transformation Timeline is the canonical, honest record of a client's
entire journey on The Growth Project. It surfaces milestones, coaching
touchpoints, and friction moments in a single chronological feed.

## 4-lane architecture

| Lane | What it shows | Data sources |
|------|---------------|--------------|
| **Body** | Weight logs, body composition entries, progress photos | `WeightLog` (all), `BodyComposition` (if model exists), `ProgressPhoto` (if model exists) |
| **Win** | Milestone hits: first 7-day streak, 30-day streak, goal weight reached, Build Week Day 7 completion, finance milestones via federation | `ClientSignal` where `signal_type IN ('checkin_streak', 'finance_milestone')` AND value crosses 7 / 14 / 30 / 60 / 90; `BuildWeekEnrollment.status = 'completed'` |
| **Coach** | Every coach note received (text), every voice note received, key 1-on-1 messages | `CoachMessage` where `from_user_id != client_id` (coach-to-client direction) |
| **Friction** | Missed check-in days, recovered streaks | `ClientSignal` where `signal_type = 'checkin_miss'` |

### Explicitly excluded (noise suppression)
- Raw daily check-ins (only streak threshold crossings land in Win)
- Every meal log
- Every workout log unless it broke a PR (no PR tracking in current schema)

## Endpoint

```
GET /me/timeline
```

### Authentication
JWT required (enforced globally by `JwtAuthGuard`). The `userId` is taken
exclusively from the verified token — no query parameter can override it.

### Query parameters

| Parameter | Type | Default | Constraints | Description |
|-----------|------|---------|-------------|-------------|
| `since_days` | integer | 180 | 1..730 | How far back to include events |
| `lanes` | string | all | comma-separated: `body,win,coach,friction` | Filter to specific lanes |
| `cursor` | string | — | opaque | Pagination cursor from a previous response |
| `limit` | integer | 20 | 1..50 | Events per page |

### Response shape

```json
{
  "events": [
    {
      "id": "<opaque base64url>",
      "lane": "body",
      "eventType": "weight_logged",
      "at": "2025-11-03T08:14:00.000Z",
      "title": "Weight logged — 182.5 lbs",
      "body": "-1.5 lbs from previous entry",
      "metadata": {
        "weightLbs": 182.5,
        "deltaLbs": -1.5,
        "streakDays": 14
      }
    }
  ],
  "nextCursor": "<opaque base64url | null>",
  "total": 47
}
```

### Pagination

Events are returned reverse-chronological (newest first). Pass
`nextCursor` from any response as the `cursor` parameter on the next
request. When `nextCursor` is `null`, the feed is exhausted within the
requested window and lanes.

Cursors encode `{ at, id }` as URL-safe base64. They are opaque to the
client and should never be constructed manually.

## Privacy guarantees

1. **No cross-user access.** The endpoint returns ONLY the requesting
   user's own data. There is no path or query parameter that accepts
   another user's ID.

2. **PTM risk_score is never exposed.** The raw numerical risk score is
   model-internal and advisory. It does not appear anywhere in timeline
   responses. If risk context is ever needed in future, a bucketed label
   (`low / medium / high`) may be added, not the raw float.

3. **PII in metadata is limited.** The `metadata` bag carries no email
   addresses, full names beyond coach display name, or message bodies
   beyond a 280-character truncation of coach notes.

4. **No new database tables.** All events are derived at query time from
   existing tables. The module adds no migrations.

## Key files

| File | What it owns |
|------|--------------|
| `timeline.controller.ts` | `GET /me/timeline` — query parsing, auth, lane validation |
| `timeline.service.ts` | Event composition from WeightLog, ClientSignal, CoachMessage, BuildWeekEnrollment |
| `timeline.types.ts` | `TimelineEvent` discriminated-union type and supporting types |
| `timeline.module.ts` | Module wiring |
| `README.md` | This file |

## Tests

| File | Coverage |
|------|----------|
| `test/timeline.service.spec.ts` | Event composition from synthetic fixtures; ordering; lane filtering; pagination cursor; PTM score exclusion |
| `test/timeline.controller.spec.ts` | Auth gating (no JWT → 401); lane filter validation; since_days clamping; correct userId taken from JWT |

## No environment variables

This module introduces no new environment variables. All data comes from
Postgres tables already in use.
