# messaging

Coach ↔ client one-on-one messaging. Persistent thread storage in
Postgres, realtime ping over Supabase Realtime, paginated reads, and
read markers.

## Purpose

- Persist every coach ↔ client message in `CoachMessage` so the
  thread survives across devices and logouts.
- Serve the thread paginated newest-first to both sides over REST.
- Push a realtime "new message" ping to the recipient so the mobile
  app can refetch without polling.
- Track per-message `read_at` so each side can badge unread counts
  without a separate read-state table.
- Enforce coach → client tenancy on every read and write — a coach
  cannot reach into another coach's threads.

## Key files

| File | What it owns |
|---|---|
| `coach-messaging.controller.ts` | Coach surface: `/coach/clients/:client_id/messages*`, `/coach/messages/unread-count` |
| `client-messaging.controller.ts` | Client surface: `/messages*` — no client-id path param, the coach is resolved from `User.coach_id` |
| `messaging.service.ts` | Thread reads/writes, read markers, unread counts, tenancy assertions |
| `messaging.dto.ts` | `CreateMessageDto`, `ListThreadQueryDto` |
| `messaging.module.ts` | Wires controllers + service; pulls in `SupabaseService` for realtime |

## Endpoints

### Coach

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/coach/clients/:client_id/messages?before=&limit=` | Paginated thread, newest-first |
| `POST` | `/coach/clients/:client_id/messages` | Send a message (30/min) |
| `POST` | `/coach/clients/:client_id/messages/read` | Mark all client → coach messages read |
| `GET` | `/coach/messages/unread-count` | `{ total, by_client }` over the coach's roster |

### Client

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/messages?before=&limit=` | Thread with the assigned coach |
| `POST` | `/messages` | Send a message (30/min) |
| `POST` | `/messages/read` | Mark all coach → client messages read |
| `GET` | `/messages/unread-count` | `{ total }` |

## Pagination

`?before=<ISO timestamp>` is a strict `<` on `created_at`. Paging is
"hand the oldest timestamp you have seen back to the server". A
composite index on `(coach_id, client_id, created_at)` makes this a
single seek per page. `limit` is clamped to 1..100, default 50.

## Realtime

Sends fire `SupabaseService.broadcastNewMessage(recipientId)` after the
DB write. The broadcast carries no body — just a refresh signal. The
mobile client refetches via the authenticated REST endpoint when the
ping arrives. The broadcast is fire-and-forget so a Realtime hiccup
never delays the API response.

## Tenancy and security rules

- `assertClientOfCoach(coachId, clientId)` runs before every coach
  read/write. A foreign client returns 404 — never a "this exists but
  isn't yours" leak.
- `requireClientCoachId(clientId)` runs before every client write;
  unassigned clients get 409 `NO_COACH_ASSIGNED`. The exception is
  `/messages/unread-count`, which returns `{ total: 0 }` so the mobile
  app's polling does not spam logs.
- `markRead*` only updates rows where `read_at IS NULL`, so repeated
  calls are idempotent and the original read timestamp survives.
- OWNER can read any thread by passing the
  `assertClientOfCoach(..., { ownerBypass: true })` path; the OWNER
  surface is mounted in the v1 BFF (see `../v1/README.md`).
- The 30/min throttle on POSTs is enforced globally via
  `ThrottlerGuard`. A coach who hits the ceiling gets 429 with the
  same retry-after handling as the rest of the API.

## DTOs

| DTO | Constraints |
|---|---|
| `CreateMessageDto.body` | non-empty string, `MaxLength(4000)` |
| `ListThreadQueryDto.before` | optional ISO date string |
| `ListThreadQueryDto.limit` | optional int 1..100 |

The global validation pipe runs in `whitelist + forbidNonWhitelisted`
mode, so unknown fields fail closed.

## Environment variables

| Var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Used by `SupabaseService.broadcastNewMessage` |

No messaging-specific env vars beyond Supabase.

## Failure modes

- Foreign client id (coach side) → 404 `Client not found`.
- Client with no `coach_id` (client side) → 409 `NO_COACH_ASSIGNED` on
  reads/writes; `{ total: 0 }` on unread-count.
- Realtime broadcast error → swallowed (logged), the REST response
  still returns the persisted message. The receiving client picks up
  the new message on its next focus poll.

## PTM signals

Every send fires fire-and-forget signals into `PtmService` (see
[`src/ptm/README.md`](../ptm/README.md)). Signals are scored by `userId`
on the **client** side of the thread — never the coach.

| Signal | Path | `value` |
|---|---|---|
| `message_sent` | `sendAsClient` | `body.length` |
| `message_received` | `sendAsCoach` | `body.length` |
| `coach_note_received` | `sendAsCoach`, alongside `message_received` | `1` |
| `message_sent` (voice) | `sendAsClient` (voice payload) | `duration_sec * 10` |
| `message_received` (voice) | `sendAsCoach` (voice payload) | `duration_sec * 10` |
| `coach_note_received` (voice) | `sendAsCoach` (voice payload) | `1` |

Bodies are NEVER passed to PTM — only the length. PTM doctrine forbids
PII in `metadata`, and the `body` would qualify. Voice signals carry
`metadata: { voice: true, duration_sec }` so the recompute service can
distinguish text vs. voice contributions without reading the audio
itself.

## Voice notes

Phase 6C adds optional voice attachments to coach <-> client messages.
A message can be text-only (existing behavior), voice-only, or both;
the `body` column was loosened to nullable, but at least one of
`body` or `voice_url` MUST be present (server enforces).

### Validation rules (server-side, never trusted from client)

| Rule | Default | Env override | Hard cap |
|---|---|---|---|
| Max duration | 300 s | `VOICE_NOTE_MAX_DURATION_SEC` | clamp `[10, 600]` |
| Max size | 5 MB | `VOICE_NOTE_MAX_SIZE_MB` | clamp `[1, 25]` |
| Content type | — | (allowlist below) | — |
| Storage bucket | `voice-notes` | `SUPABASE_VOICE_BUCKET` | — |

Allowed `content_type` values: `audio/mp4`, `audio/m4a`, `audio/aac`,
`audio/webm`, `audio/ogg`. Anything else returns `400 VOICE_CONTENT_TYPE_REJECTED`.

### Signed-upload flow

1. Client `POST /messages/voice-upload` (or
   `POST /coach/clients/:client_id/messages/voice-upload`) with
   `{ duration_sec, size_bytes, content_type }`. Server validates
   against the same limits enforced at message-send time, then issues
   a Supabase Storage signed-upload URL scoped to the caller's user id.
2. Client uploads the audio to `upload_url` (PUT). The URL is good for
   `expires_at` (default 10 min).
3. Client `POST /messages` (or coach-side equivalent) with
   `{ voice: { url: <public_url>, duration_sec, size_bytes, content_type } }`.
   Server re-validates and persists the message + voice columns.

If the Supabase JS SDK in the deployment does not expose
`createSignedUploadUrl()`, the upload endpoint returns
`501 VOICE_STORAGE_UNAVAILABLE` so the operator knows to upgrade the
SDK; the rest of the messaging surface stays functional.

### Error codes

| Code | When |
|---|---|
| `MESSAGE_EMPTY` | Both `body` and `voice` absent / empty. |
| `VOICE_CONTENT_TYPE_REJECTED` | `content_type` not in allowlist. |
| `VOICE_DURATION_OUT_OF_RANGE` | `duration_sec` ≤ 0 or > configured max. |
| `VOICE_SIZE_OUT_OF_RANGE` | `size_bytes` ≤ 0 or > configured max. |
| `VOICE_STORAGE_UNAVAILABLE` | Signed-URL issuance failed (SDK / config). |

## Tests

| File | Covers |
|---|---|
| `test/messaging.service.spec.ts` | Tenancy, pagination, send, read markers, unread counts |
| `test/messaging.dto.spec.ts` | DTO validation matrix |

## Operational notes

- The mobile client polls `/messages/unread-count` aggressively (every
  screen focus). The endpoint is single-query and indexed — keep it
  cheap.
- The composite index `(coach_id, client_id, created_at)` was added in
  `prisma/migrations/20260424120000_add_coach_messages`. If a future
  feature pages on a different field, add a covering index rather than
  relaxing the order.
- This module deliberately does not implement edits or deletions. The
  `read_at` column is the only mutation after insert.
