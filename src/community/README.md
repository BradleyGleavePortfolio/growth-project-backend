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
- Also on member wins (`POST /community/wins`, title and description).
- Limits: a word list is not a classifier. Misses are handled by Report ->
  queue -> hide/warn/ban below. **Voice notes cannot be content-filtered**:
  they are audio and TGP does not transcribe them, so no automated check runs
  on what is said. Their safety controls are report (every voice note has
  Report in the app), the moderation queue (the coach and the TGP team listen
  to the reported note through a short-lived link and Hide / Warn / Ban /
  Dismiss it, within the same 24-hour commitment), two-way block, and author
  delete. Voice notes are offered in community spaces only: a DM voice note
  is refused with `400 community.voice.dm_not_supported` (DM threads are keyed
  by the member pair, so a DM voice note could never reach its recipient).

### 2. Report -> review -> action

- `POST /community/moderation/reports` `{ target_type, target_id, reason,
notes? }` — `target_type` is `post | comment | message | voice_note | win`;
  any member who can see the target (DM rows: only the two participants;
  voice notes: members of the note's cohort or space; wins: the author's
  teammates in the same coach's circle); reasons are the codes in `COMMUNITY_REPORT_REASONS`
  (harassment, hate, sexual, violence, self_harm, spam, misinformation, other).
  Throttled (`COMMUNITY_REPORTS_PER_5MIN`).
- `GET /community/moderation/flagged` — coach/owner review queue across every
  workspace the coach owns (platform owner: all), open items only, oldest
  first, enriched with content, author and cohort, plus `respond_by`
  (`created_at` + 24 hours, the published commitment) and `overdue`. Voice
  notes carry `media: { kind: 'voice_note', url, duration_ms, mime_type }`
  with a 15-minute signed playback link and `content` "Voice note, m:ss".
  Removed targets show "Removed" with `removed: true` and no media.
- `GET /community/workspaces/:id/moderation/items` — per-workspace queue
  (existing).
- `PATCH /community/moderation/items/:id` `{ action, notes? }` — coach of that
  workspace or platform owner only:
  - `hide` — soft-deletes the target; it disappears for everyone (posts and
    messages: `deleted_at`; voice notes: `soft_deleted_at`, and no playback
    link is signed again; wins: `hidden_at`).
  - `warn` — records the action and sends the author a community notification;
    access is kept.
  - `ban` — removes the author's access to the workspace (every membership ->
    `removed`, so the access service no longer admits them to the Hall,
    cohorts, DMs, voice or challenges) AND hides the target. The workspace
    coach and platform owners can never be banned
    (`403 community.moderation.cannot_ban_coach` with a message); the check
    runs before any write. Members whose membership role is coach or
    assistant are members, not the space owner, and can be banned by the
    workspace coach. A win author with no membership row gets a `removed`
    membership in the default cohort, so the first-touch bootstrap cannot
    admit them and their wins leave the feed.
  - `dismiss` — closes the item with no enforcement.
- Moderation and block routes deliberately do NOT carry the write kill
  switches: members must be able to report and block during a content freeze.

### 3. Blocking

- Reuses the existing `UserBlock` table (one block list per user, the same
  list coach-client messaging already honours).
- `GET /community/blocks`, `POST /community/blocks { user_id }` (idempotent),
  `DELETE /community/blocks/:userId`.
- A block is **two-way** (owner-approved copy: "If you block someone, they can
  no longer see your posts or message you, and they are not told"). The
  blocker no longer sees anything the blocked user authored, and the blocked
  user no longer sees anything the blocker authored, on every member-facing
  read surface: Hall posts, post comments and replies, cohort messages (list
  and by id), DMs, challenge comments and leaderboard rows, voice notes (list
  and by id), the cohort roster, the workout leaderboard, wins, search, the
  Today card (pinned post, event, challenge), reaction counts, and
  coach-authored lessons, events and challenges (a coach can block a member,
  and coach messaging blocks share the `UserBlock` row in either direction).
  Single reads by id answer 404 with the same body as "does not exist".
- Interactions that target the other side are refused the same way (404):
  comment on their post, react to their content, RSVP to their event, join or
  comment on their challenge. DMs are closed in **both** directions on
  open/read/send and the thread disappears from both DM lists. The blocker
  gets `403 community.dm.blocked_by_you` ("You blocked this member. To message
  them again, unblock them in Community safety."); the blocked person gets the
  same `404 community.dm.not_found` body as a member who is not there, so the
  block is not disclosed. No community push can cross a block (reply
  pushes need a visible post; event reminders skip blocked recipients).
- Coach/owner moderation surfaces stay complete so reports can be actioned:
  moderation queue, flagged list, coach inbox, AI triage, the coach roster
  view. Unblocking restores both directions at once (one row).
- Realtime pings carry ids only (never bodies); the app always refetches
  content through the filtered REST routes above.
- DM rows are addressable only by their two participants on the reaction and
  report routes (a third member gets 404).
- Guard rails: no self-block; only users who share a community workspace can
  be blocked (others get 404, so the endpoint does not reveal accounts); a
  member cannot block their own workspace coach
  (`403 community.block.workspace_coach`) — they report the coach to the
  platform contact instead. Every refusal carries a stable `code` and a human
  `message` with the next step (`community.block.self`,
  `community.block.not_found`, `community.block.workspace_coach`,
  `community.dm.blocked_by_you`).
- Client privacy: other members only ever see first names (roster, block
  list, workout leaderboard, wins). Full names and emails stay on coach/owner
  surfaces.
- List pagination cursors are computed from the unfiltered page, so a page may
  hold fewer rows than `limit` when blocked authors are dropped.

### 4. Published contact

- `GET /community/safety` — `contact_email` (the repo's one `SUPPORT_EMAIL`
  constant from `src/public-pages/trust-pages.html.ts`, OR-109-1; no env
  override),
  community guidelines (`COMMUNITY_GUIDELINES`), the report reasons and the
  response commitment (`COMMUNITY_RESPONSE_COMMITMENT`). The app's community
  safety screen renders this.
- The guidelines and the commitment are owner-approved copy (2026-10-01 09:07
  PDT); change them only with a new owner approval. Served text:

  Community guidelines:

  1. Be respectful. No harassment, bullying, hate speech or threats.
  2. No sexual or explicit content.
  3. No spam, advertising or scams.
  4. Share training experience, not medical advice. This is a personal-training community.
  5. Keep private things private. Do not share anyone else's personal or health information.
  6. Report anything that breaks these rules. Reports go to your coach and to the team.
  7. This space is not for emergencies. If you are in danger, call 911. If you are struggling emotionally, call or text 988.

  Response commitment: Reports are reviewed within 24 hours, every day, by your coach and The Growth Project team. Content that breaks these guidelines is removed, and people who break them repeatedly lose access. If you block someone, they can no longer see your posts or message you, and they are not told.

### 5. Member wins (More > Community)

`GET /community/feed`, `POST /community/wins`, `DELETE /community/wins/:id`
(`community-wins.policy.ts`). A win is shown to the author's teammates only
inside a moderated space: the coach's circle, when the coach runs a community
workspace (whose queue receives reports on the win). With no coach or no
workspace, a member sees only their own wins; there is no cross-tenant public
feed (`visibility: 'public'` is stored as `circle`). Content filter before the
write; Report (`target_type: 'win'`), Block (two-way) and author delete in the
app; Hide sets `hidden_at`; members removed from the workspace cannot post
(`403 community.win.removed_member`) and their wins leave the feed. Other
members appear by first name only.

### Operational requirement (not code)

Reports land in the coach queue and are reviewed within 24 hours, every day
(the published commitment above). The moderation queue (Coach > Community >
Reports) is checked at least once every 24 hours, weekends included, from
clinic go-live; content that breaks the guidelines is removed and repeat
offenders are removed from the community; a "Self-harm or suicide" report gets
same-day contact pointing the member to 911 or 988; if the moderator will be
unreachable for more than 24 hours, new community posts are paused or a backup
moderator is named first. This is an operator responsibility; nothing in this
module enforces a timer.

### Tests

- `test/community/safety/community-content-filter.spec.ts` — filter terms,
  normalisation and false-positive guards.
- `test/community/safety/community-safety-flow.spec.ts` — end-to-end against
  an in-memory Prisma: filter on every write surface, report -> flagged queue,
  hide / warn / ban, coach cannot be banned (and nothing is written), only the
  owning coach can act, block on every read surface and DMs both ways, block
  guard rails and refusal messages, DM report participants only, safety info,
  route metadata + feature-flag guard.
- `test/community/safety/community-block-two-way.spec.ts` — two-way block on
  every surface (both directions, bystanders unaffected, unblock restores),
  first-name privacy, reactions, Today, and a regression guard that
  enumerates every community GET route from Nest metadata and fails when one
  is neither block-filtered nor exempt with a written reason.
- `test/community/safety/community-safety-copy.spec.ts` — pins the
  owner-approved guidelines, the 24-hour commitment, the report reasons and
  the default safety contact byte for byte.
