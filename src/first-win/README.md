# first-win — Day 1 Win Sequence (Phase 7A)

The first-win module powers the retention screen shown to every new client on their first app open after onboarding is complete. The mobile app calls `GET /me/first-win/status` on every student cold start and shows the Day1WinScreen until the client completes one quick-win action. Once completed the screen is permanently skipped.

The win is idempotent: calling `POST /me/first-win/complete` a second time returns the original timestamp without writing to the database again. This allows the mobile app to safely retry on poor connections without corrupting the data.

The `winType` field is informational only. It does not change which database field is set — it exists so future analytics can show which win-card action correlates with better 30-day retention.

---

## Endpoints

| Method | Path | Auth / Role | Request body | Response shape |
|--------|------|-------------|--------------|----------------|
| `POST` | `/me/first-win/complete` | `JwtAuthGuard` (any role) | `{ winType: WinType }` | `{ completedAt: string, aiMessage: string }` |
| `GET` | `/me/first-win/status` | `JwtAuthGuard` (any role) | — | `{ completed: boolean, completedAt: string \| null }` |

### POST /me/first-win/complete

Sets `first_win_completed_at = now()` on the first call. Subsequent calls return the original timestamp with no DB write (idempotent). Returns a 2-sentence AI-generated message explaining what the first data point means for the client.

**Request:**

```json
{ "winType": "logged_first_weight" }
```

`winType` values: `logged_first_weight` | `set_first_goal` | `first_checkin` | `first_meal`

**Response `200`:**

```json
{
  "completedAt": "2026-05-06T09:30:00.000Z",
  "aiMessage": "Logging your first weight sets a baseline — every measurement from here is progress data, not a judgement. Consistency in tracking, not the number itself, is what drives results over 90 days."
}
```

### GET /me/first-win/status

**Response `200`:**

```json
{ "completed": true, "completedAt": "2026-05-06T09:30:00.000Z" }
```

or before any win:

```json
{ "completed": false, "completedAt": null }
```

---

## Prisma models touched

| Model | Fields read | Fields written |
|-------|-------------|----------------|
| `User` | `id`, `first_win_completed_at` | `first_win_completed_at` |

---

## Migration

`prisma/migrations/20260506050000_add_first_win/migration.sql` — adds `first_win_completed_at TIMESTAMP(3)` (nullable) to `User`. Additive only; existing rows stay valid with `null` (meaning never completed). An index on the column supports the lookup query.

---

## Env vars

| Var | Default | Required | Meaning |
|-----|---------|----------|---------|
| `PERPLEXITY_API_KEY` | `""` | No | If set, the first-win complete endpoint calls Perplexity `sonar-pro` to generate the 2-sentence AI message. If unset or empty, a deterministic fallback message is returned. The client experience is identical either way. |

---

## Tests

`test/first-win.controller.spec.ts` asserts:
- `FirstWinController` is annotated with `@UseGuards(JwtAuthGuard)` (source guard)
- `@Controller('me/first-win')` prefix is present (source guard)
- `@Post('complete')` and `@Get('status')` handlers are declared (source guards)
- `FirstWinService.complete()` sets `first_win_completed_at` on first call and returns the timestamp
- `FirstWinService.complete()` is idempotent — returns the original timestamp with zero DB writes on subsequent calls
- `FirstWinService.complete()` accepts all four valid `winType` values
- `FirstWinService.getStatus()` returns `{ completed: false, completedAt: null }` before any win
- `FirstWinService.getStatus()` returns `{ completed: true, completedAt: ISO }` after a win

---

## Future work / known limits

- The `winType` is not yet stored in a separate analytics table. When retention analysis is needed, add a `ClientSignal` record of type `first_win` with the `winType` in the `metadata` JSON — this hooks directly into the Phase 1A PTM signal pipeline.
- The AI message is generated synchronously inside `POST /me/first-win/complete`. If the Perplexity API is slow (> 5s), this delays the first-win response. A future improvement would queue the AI call and let the mobile poll for it asynchronously (following the same pattern as `GET /diagnostic/:id/result`).
