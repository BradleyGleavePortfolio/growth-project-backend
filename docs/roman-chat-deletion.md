# Roman chat history: list and delete (backend #635)

Owner decision 2026-10-01 20:32 and operator ruling OR-110-1: past Roman (AI)
chats are kept until the client deletes them or their account. There is no
time-based purge. The box-2 copy `client-ai-v4` and the privacy policy say
exactly this, so the client must be able to find and erase any chat, not only
today's.

All routes need a signed-in user (JwtAuthGuard + RolesGuard; roles `student`,
`coach`, `owner`). They are NOT behind `FEATURE_ROMAN_CHAT_ENABLED`, which is
the same rule as the AI consent ledger: switching Roman chat off never takes a
deletion right away. None of them calls Anthropic. Every response carries
`Cache-Control: no-store`. The chat routes (open, read, send) stay behind the
flag. `GET /roman/sessions/:id/messages` is now `no-store` too, so a deleted
transcript does not stay in a device HTTP cache.

## `GET /api/roman/sessions` -> 200

Lists the caller's own live chats, newest first (`started_at` desc, then `id`
desc). It returns metadata only, never message text.

Query (all optional): `limit` (integer 1..100, default 30), `cursor` (the `id`
of the last session already shown, at most 64 characters), `surface`
(`client` or `coach`; when absent, both surfaces are listed). Any other
parameter, or a value out of range, is a 400.

```json
{
  "sessions": [
    {
      "id": "c...",
      "surface": "client",
      "dayKey": "2026-10-02",
      "messageCount": 6,
      "startedAt": "2026-10-02T08:01:00.000Z",
      "lastActivityAt": "2026-10-02T08:09:00.000Z"
    }
  ],
  "nextCursor": "c..."
}
```

`nextCursor` is `null` on the last page. The cursor must be one of the
caller's own sessions. A chat that was deleted between two pages is still a
valid cursor. Any other cursor is a 400 `ROMAN_CURSOR_INVALID` ("This list of
conversations is out of date. Refresh it to load your conversations again.").
The server never looks up another user's row for it.

## `DELETE /api/roman/sessions/:id` -> 204

Erases one chat from any day. In one transaction the server:

1. hard-deletes the messages;
2. clears the subject context;
3. moves the row off its `(user, surface, day)` key, so a new chat can open
   the same day;
4. keeps only a content-free count of the user turns from the last 24 hours,
   so a delete never resets the daily Roman limit.

Repeating the delete returns 204 and writes nothing. A chat that a pre-#635
build only soft-deleted (its content is still kept) is erased now. A session
that is not the caller's, or does not exist, returns 404
`ROMAN_SESSION_NOT_FOUND` ("This conversation no longer exists. Open Roman
again to start a new one."). It is never a 403, so session ids cannot be
probed.

## `DELETE /api/roman/sessions` -> 204

Erases every chat of the caller, on both surfaces and for every day. This
includes the caller's own pre-#635 soft-deleted rows. Each chat is erased as
above, in its own transaction. The route returns 204 even when nothing is
left.

If the request cannot finish, it returns a 503 `ROMAN_ERASE_INCOMPLETE`
("Roman could not finish deleting your conversations. The ones already deleted
stay deleted. Try again in a moment to delete the rest."). That happens on a
database failure, or when more chats remain than one request erases (50
batches of 100). Chats that were already erased stay erased, the rest are
untouched, and a retry finishes the job.

## Verified erase (C-635-3)

After deleting the messages, the server checks that none of the session's
messages are left. Under a database role that row-level security stops from
deleting, a `DELETE` removes zero rows without an error. In that case the
request is a 503 `ROMAN_ERASE_INCOMPLETE` ("Roman could not finish deleting
this conversation, so it was not changed. Try deleting it again in a
moment."), and the transaction rolls back, so the client is never told a chat
is gone while it is not.

## Erasure sweep for pre-#635 tombstones

Before #635, a deleted chat was soft-deleted and kept its messages.
`RomanErasureSweep` erases those rows. It runs 60 s after boot, nightly at
04:00 UTC, and in follow-up runs until none are left:

- If a run makes progress but leaves rows behind, the next run starts 60 s
  later.
- If a run erases nothing while rows remain, it retries after 15 minutes, up
  to 4 times in a row. After that it raises a `RomanErasureStalled` alert and
  waits for the nightly run.

Each run logs one line:
`roman.erase_sweep trigger=<boot|nightly|follow-up> erased=<n> failed=<n> remaining=<n>`.
Any failed row raises a `RomanErasureIncomplete` Sentry event (counts plus the
sanitized first failure). Diagnostics go through `safeDiagnostic`, so no ORM
message reaches a log or Sentry.

Operator check after the deploy, once old machines are gone: wait for a log
line with `remaining=0`, or run this read-only count, which must be 0:

```sql
SELECT count(*) FROM "RomanSession"
WHERE deleted_at IS NOT NULL AND day_key NOT LIKE 'erased:%';
```

## Account deletion

Account deletion erases every Roman chat through the account-erasure manifest
(backend #608). "Kept until you delete them or your account" is true for
account deletion only once #608 is deployed.
