# Users Module — Me Routes

**Path:** `src/users/` and `src/first-win/`

All endpoints below are behind `JwtAuthGuard` and operate on the authenticated caller's own account. They are accessible to all roles (student, coach, owner) unless noted.

---

## Preferences

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users/me/preferences` | Returns current preferences with defaults. |
| `PATCH` | `/users/me/preferences` | Merges a partial preferences object. |

---

## Account & GDPR

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/users/me/data-export` | Requests a personal data export. |
| `GET` | `/users/me/data-export/:id` | Fetches a prior data-export by ID. |
| `DELETE` | `/users/me/account` | Schedules account deletion (30-day grace). Idempotent. |
| `POST` | `/users/me/account/cancel-deletion` | Cancels a pending deletion. |
| `GET` | `/users/me/account/deletion-status` | Returns deletion status. |
| `GET` | `/users/me/account/status` | Alias for deletion-status. |

---

## Identity

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/users/me/founding-number` | Returns 1-indexed join rank and founding-member status. |
| `GET` | `/users/me/circle-stats` | Returns how many users in the caller's coach group trained today. |

---

## Day 1 Win Sequence (Phase 7A)

**Module:** `src/first-win/`

Powers the retention screen shown to every new client on their first cold app open. Once completed the screen never appears again.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/me/first-win/complete` | `JwtAuthGuard` | Marks the Day 1 Win complete. Sets `first_win_completed_at = now()` if currently null. **Idempotent** — subsequent calls return the original timestamp. |
| `GET` | `/me/first-win/status` | `JwtAuthGuard` | Returns `{ completed: boolean, completedAt: string \| null }`. Mobile calls this on every student cold start. |

### POST /me/first-win/complete

**Request body:**

```json
{
  "winType": "logged_first_weight" | "set_first_goal" | "first_checkin" | "first_meal"
}
```

`winType` is informational — it does not change which DB field is set. It allows future analytics on which win-card type correlates with better retention.

**Response `200`:**

```json
{
  "completedAt": "2026-05-06T09:30:00.000Z"
}
```

### GET /me/first-win/status

**Response `200`:**

```json
{
  "completed": true,
  "completedAt": "2026-05-06T09:30:00.000Z"
}
```

or before completion:

```json
{
  "completed": false,
  "completedAt": null
}
```

### Migration

Migration `20260506050000_add_first_win` adds `first_win_completed_at TIMESTAMP(3)` (nullable) to the `User` table.

### Tests

`test/first-win.controller.spec.ts` — source guards (JwtAuthGuard, route names) + service unit tests (idempotency, getStatus before/after).

---

*Module files: `src/first-win/first-win.controller.ts`, `src/first-win/first-win.service.ts`, `src/first-win/first-win.dto.ts`, `src/first-win/first-win.module.ts`*
