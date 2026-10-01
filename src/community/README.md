# Community module

Coach-run community spaces: workspace (the "Hall"), cohorts, posts and
comments, cohort messages, DMs, challenges and challenge comments, voice notes,
reactions, events and search. Every route sits behind `JwtAuthGuard ->
RolesGuard -> CommunityFeatureFlagGuard` (`FEATURE_COMMUNITY_API`); write
routes additionally carry the community write kill switches.

## Safety (Apple App Review 1.2, user-generated content)

Apple requires, for apps with UGC: a filter for objectionable material before
it is posted, a way to report content with timely action, a way to block
abusive users, and published contact information. This section is the map of
where each lives. Code: `src/community/safety/` and
`src/community/moderation/`.

### 1. Content filter (pre-publication)

- `safety/community-content-filter.ts` — deterministic, dependency-free word
  list (slurs, sexually explicit terms, threats, self-harm encouragement).
  Normalises case, accents, common character substitutions (`0->o`, `@->a`,
  ...), repeated letters and separators between single letters, and matches on
  word boundaries so ordinary words containing a term are not blocked. Terms
  are stored ROT13-encoded so the source does not carry slurs in plain text.
- `CommunitySafetyService.assertAllowed(...)` is called BEFORE the write on:
  post create + edit (title and body), post comments, cohort messages (send +
  edit), DMs, challenge comments.
- Rejection: HTTP **422** `{ error: 'content_rejected', code:
'community.content.rejected', message }`. Nothing is written. The app shows
  the message and keeps the draft.
- Limits: a word list is not a classifier. Misses are handled by Report ->
  queue -> hide/warn/ban below. **Voice notes are not filtered** (audio; no
  transcription) — they are covered by block + report only.

### 2. Report -> review -> action

- `POST /community/moderation/reports` `{ target_type, target_id, reason,
notes? }` — any member; reasons are the codes in `COMMUNITY_REPORT_REASONS`
  (harassment, hate, sexual, violence, self_harm, spam, misinformation, other).
  Throttled (`COMMUNITY_REPORTS_PER_5MIN`).
- `GET /community/moderation/flagged` — coach/owner review queue across every
  workspace the coach owns (platform owner: all), open items only, oldest
  first, enriched with content, author and cohort. Removed targets show
  "Removed".
- `GET /community/workspaces/:id/moderation/items` — per-workspace queue
  (existing).
- `PATCH /community/moderation/items/:id` `{ action, notes? }` — coach of that
  workspace or platform owner only:
  - `hide` — soft-deletes the target; it disappears for everyone.
  - `warn` — records the action and sends the author a community notification;
    access is kept.
  - `ban` — removes the author's access to the workspace (every membership ->
    `removed`, so the access service no longer admits them to the Hall,
    cohorts, DMs, voice or challenges) AND hides the target. The workspace
    coach and platform owners can never be banned
    (`403 community.moderation.cannot_ban_coach`); the check runs before any
    write.
  - `dismiss` — closes the item with no enforcement.
- Moderation and block routes deliberately do NOT carry the write kill
  switches: members must be able to report and block during a content freeze.

### 3. Blocking

- Reuses the existing `UserBlock` table (one block list per user, the same
  list coach-client messaging already honours).
- `GET /community/blocks`, `POST /community/blocks { user_id }` (idempotent),
  `DELETE /community/blocks/:userId`.
- A block hides the blocked user's posts, comments, cohort messages, challenge
  comments, voice notes and search results from the blocker, and closes DMs in
  **both** directions (`403 community.dm.blocked` on open/read/send; the
  thread disappears from the blocker's DM list). The blocked user is not told.
- Guard rails: no self-block; only users who share a community workspace can
  be blocked (others get 404, so the endpoint does not reveal accounts); a
  member cannot block their own workspace coach
  (`403 community.block.workspace_coach`) — they report the coach to the
  platform contact instead.
- List pagination cursors are computed from the unfiltered page, so a page may
  hold fewer rows than `limit` when blocked authors are dropped.

### 4. Published contact

- `GET /community/safety` — `contact_email`
  (`COMMUNITY_SAFETY_CONTACT_EMAIL`, default the public support address),
  community guidelines, the report reasons and the response commitment. The
  app's community safety screen renders this.

### Operational requirement (not code)

Reports land in the coach queue and must be actioned promptly (the launch
target is within 24 hours). A named primary and backup moderator, seven-day
cover and an escalation path are an operator responsibility; nothing in this
module enforces a timer.

### Tests

- `test/community/safety/community-content-filter.spec.ts` — filter terms,
  normalisation and false-positive guards.
- `test/community/safety/community-safety-flow.spec.ts` — end-to-end against
  an in-memory Prisma: filter on every write surface, report -> flagged queue,
  hide / warn / ban, coach cannot be banned (and nothing is written), only the
  owning coach can act, block on every read surface and DMs both ways, block
  guard rails, safety info, route metadata + feature-flag guard.
