# Channel and Thread Spec

Status: DRAFT spec, docs-only. Conditional on OWNER_DECISION 1.
Schema deltas below are written for **Option B** (the recommendation).
Where Option A or Option C would diverge, the divergence is called out
inline.

This file is the binding contract for channels, messages, threads,
reactions (under Option B), and memberships. It defines the channel
taxonomy, the permission matrix, the Prisma deltas (illustrative —
not applied), the API surface, the rate limits, the search behaviour,
and >= 6 failure modes with detection + recovery.

---

## 1. Channel taxonomy

Four channel types. Each has different semantics, different
permission rules, different rate limits, and different lifecycle
behaviour.

### 1.1 Announcements

Coach-broadcast channel. One per org by default; the coach may create
additional named announcement channels (e.g. "weekly recaps",
"program updates").

- Authors: `COACH`, `SUB_COACH` (sub-coach posting requires explicit
  per-channel permission, off by default).
- Readers: every member of the org with the `client` role and active
  membership in any program.
- Threads: **disabled** intentionally. Replying to an announcement
  must redirect the user to a related room channel (selected by the
  coach when posting; defaults to the org's general room).
- Reactions: acknowledgement tick only (Option B).
- Rate limit: post — 30/hour per author; ack — 60/min per recipient.
- Lifecycle: persistent. Survives cohort end. Searchable forever
  (subject to retention policy in `moderation-and-safety.md`).

Announcement channels have a banner color and pinned-message slot;
neither is doctrine-relevant.

### 1.2 Rooms

Topic-based, multi-author channels. Coach creates them. Examples:
"general", "wins", "form-checks", "Q&A".

- Authors: any active member with explicit Membership in the room.
- Readers: same as authors (rooms are not lurker-public).
- Threads: enabled. Max depth 2 (parent + child). Grandchildren
  collapse into the child, with a "view all replies" link that does
  not deepen the tree.
- Reactions: acknowledgement tick only (Option B).
- Rate limit: post — 60/min per author; ack — 60/min per recipient.
- Lifecycle: persistent until explicit archival by coach. Archived
  rooms are read-only and excluded from default channel-list ordering
  but searchable.

### 1.3 Cohort channels

Time-bound channels aligned to a Wave 2 `Cohort`. Created
automatically when a cohort starts; auto-archived on cohort end.

- Authors: the cohort's clients + the cohort's assigned coach +
  sub-coaches.
- Readers: same as authors.
- Threads: enabled, depth 2.
- Reactions: acknowledgement tick only (Option B).
- Rate limit: post — 60/min per author; ack — 60/min per recipient.
- Lifecycle: created with cohort start; auto-archived on cohort end.
  Auto-archive behaviour is **OWNER_DECISION_DEFERRED**: read-only
  archive (recommended) vs full freeze (no read after archive) vs
  purge (delete after 90 days). Recommendation: read-only archive.

### 1.4 DMs (1:1 only)

Direct messages between two specific users. **Group DM is not in v1**
(OWNER_DECISION 6).

Three permitted DM pairings:

- `coach` ↔ `client` (where the client has an active program with the
  coach).
- `sub_coach` ↔ `client` (where the client is on the sub-coach's
  assigned roster).
- `coach` ↔ `sub_coach` (operational coordination).

Forbidden DM pairings:

- `client` ↔ `client` (any pairing). Hard-blocked at the DM-create
  endpoint. The doctrine rationale: coach-mediated relationships only;
  DM is not a social-discovery surface.
- `client` ↔ unrelated coach/sub-coach (no shared program). Same
  block.
- Group DMs of any size > 2. v1 does not support group conversations
  outside rooms / cohorts.

Other DM properties:

- Threads: disabled. DMs are single-stream.
- Reactions: acknowledgement tick only.
- Rate limit: post — 120/min per author (higher because 1:1); ack —
  120/min per recipient.
- Lifecycle: persistent. DM history follows GDPR delete cascade; on
  client account deletion, the client's outbound messages are
  tombstoned (see `moderation-and-safety.md`), the coach's view shows
  redaction tombstones in place.

---

## 2. Persona + permission matrix

| Action | OWNER (TGP staff) | COACH | SUB_COACH | CLIENT | ADMIN (org admin role) |
| --- | --- | --- | --- | --- | --- |
| Create channel (room) | Yes (any org) | Yes (own org) | No | No | Yes (own org) |
| Archive channel | Yes | Yes (own org) | No | No | Yes (own org) |
| Post to announcement | Read-only | Yes | Conditional (per-channel flag) | No | No |
| Post to room | Read-only | Yes | Yes | Yes (if Member) | Yes |
| Post to cohort | Read-only | Yes (own cohort) | Yes (assigned) | Yes (cohort member) | No |
| Post DM (initiate) | No | Yes (own clients/sub-coaches) | Yes (assigned clients) | Yes (only to coach/sub-coach) | No |
| Read message | Yes (audit-scope) | Yes (own org) | Yes (own scope) | Yes (own memberships) | Yes (own org) |
| Edit own message | Yes | Yes | Yes | Yes | Yes |
| Delete own message | Yes | Yes | Yes | Yes | Yes |
| Delete other's message | Yes | Yes (own org, audit-logged) | No | No | Yes (own org) |
| Acknowledge tick | n/a | Yes | Yes | Yes | Yes |
| Pin message | Yes | Yes | No | No | Yes |
| Mute member (ban ladder) | Yes | Yes (own org) | No | No | Yes (own org) |
| Configure auto-flag rules | Yes | Yes (own org overrides) | No | No | Yes (own org) |
| View moderation queue | Yes | Yes (own org) | No | No | Yes (own org) |
| Resolve moderation flag | Yes | Yes (own org) | No | No | Yes (own org) |
| Member directory: opt-in | n/a | Yes (always-listed) | Yes (always-listed) | Yes (consent) | Yes |
| Member directory: search | Yes | Yes | Yes | Yes (consenting members only) | Yes |
| Voice-note record | n/a | Yes | Yes | Yes (consent) | Yes |
| Voice-note transcribe (admin override) | Yes | Yes (own org) | No | No | Yes |

Notation: "own org" = scope-stack restricted to the user's org, per
Wave 3. "own scope" = scope-stack restricted further to the user's
assigned roster (sub-coaches see only their assigned clients).

The permission matrix is enforced in the route layer (route guard +
scope-stack check) and reasserted at the service layer (defense in
depth). See section 5 (route surface) for the guard application.

---

## 3. Prisma schema deltas (illustrative)

These are not applied. They are docs-only inside fenced blocks.
`prisma/schema.prisma` in this repo is unchanged. When the owner
approves Option B, an implementation PR will translate these into a
real migration.

```prisma
// =====================================================================
// Wave 10 — Native community (Option B)
// All tables ship with: created_at, updated_at, deleted_at (soft delete),
// audit fields (audit_actor_id captured at write site), scope-stack keys
// (org_id, optional cohort_id), and GDPR delete cascade.
// =====================================================================

model Channel {
  id              String   @id @default(cuid())
  org_id          String   // FK Coach.org or Org table per Wave 2
  type            String   // 'announcement' | 'room' | 'cohort' | 'dm'
  name            String?  // null for DM (derived from participants)
  topic           String?  // optional channel description
  cohort_id       String?  // populated for type='cohort'
  archived_at     DateTime?
  created_by      String   // User.id
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt
  deleted_at      DateTime?

  memberships     Membership[]
  messages        Message[]

  @@index([org_id, type])
  @@index([cohort_id])
  @@index([archived_at])
}

model Membership {
  id              String   @id @default(cuid())
  channel_id      String
  user_id         String
  role_in_channel String   // 'author' | 'reader' | 'muted' | 'banned'
  consent_listed_in_directory Boolean @default(false)
  joined_at       DateTime @default(now())
  left_at         DateTime?
  muted_until     DateTime?

  channel         Channel  @relation(fields: [channel_id], references: [id], onDelete: Cascade)
  user            User     @relation(fields: [user_id], references: [id], onDelete: Cascade)

  @@unique([channel_id, user_id])
  @@index([user_id, joined_at])
  @@index([muted_until])
}

model Message {
  id              String   @id @default(cuid())
  channel_id      String
  parent_message_id String? // for thread replies (depth 1 = parent in
                            // root channel; depth 2 = reply to parent)
  author_id       String
  body            String   // text content; voice-note rendered separately
  voice_note_id   String?  // FK to VoiceNote
  attachment_ids  String[] // FK refs into Attachment table (separate)
  edited_at       DateTime?
  redacted_at     DateTime? // tombstone marker; body cleared, row preserved
  created_at      DateTime @default(now())
  deleted_at      DateTime?

  channel         Channel  @relation(fields: [channel_id], references: [id], onDelete: Cascade)
  author          User     @relation(fields: [author_id], references: [id], onDelete: Cascade)
  parent          Message? @relation("ThreadParent", fields: [parent_message_id], references: [id], onDelete: SetNull)
  replies         Message[] @relation("ThreadParent")
  reactions       Reaction[]

  @@index([channel_id, created_at])
  @@index([parent_message_id])
  @@index([author_id, created_at])
}

model Reaction {
  id              String   @id @default(cuid())
  message_id      String
  recipient_id    String   // who acknowledged
  created_at      DateTime @default(now())

  message         Message  @relation(fields: [message_id], references: [id], onDelete: Cascade)
  recipient       User     @relation(fields: [recipient_id], references: [id], onDelete: Cascade)

  @@unique([message_id, recipient_id])
  @@index([message_id])
}

model Thread {
  // Lightweight projection for thread metadata (cached). The source
  // of truth is Message.parent_message_id; Thread is a read-side cache
  // refreshed on message create/edit/delete.
  id                  String   @id @default(cuid())
  root_message_id     String   @unique
  channel_id          String
  reply_count         Int      @default(0)
  last_reply_at       DateTime?
  participant_user_ids String[]

  @@index([channel_id, last_reply_at])
}

model VoiceNote {
  // Detailed in voice-notes-spec.md. Pointer here for FK completeness.
  id              String   @id @default(cuid())
  message_id      String?  @unique // backref nullable during upload race
  audio_storage_key String
  duration_ms     Int
  transcript      String?
  transcript_status String // 'pending' | 'ready' | 'failed' | 'redacted'
  audio_purge_at  DateTime // 90 days from created_at (OWNER_DECISION 2)
  created_at      DateTime @default(now())
  deleted_at      DateTime?
}

model ChannelEvent {
  // Emitted into admin data-feed (Wave 3) for analytics + retention engine.
  id              String   @id @default(cuid())
  org_id          String
  channel_id      String
  event_type      String   // 'message.created' | 'message.edited' | etc
  actor_id        String
  payload_hash    String   // hash of payload for idempotency / dedup
  created_at      DateTime @default(now())

  @@index([org_id, created_at])
  @@index([channel_id, created_at])
}
```

### Schema notes

- **Soft delete (`deleted_at`)**: Messages are soft-deleted; hard
  delete is reserved for the GDPR purge job (90-day cycle, see
  `moderation-and-safety.md`).
- **Tombstones (`redacted_at`)**: a redacted message preserves the row
  for thread integrity but clears `body`, `voice_note_id`, and
  `attachment_ids`. UI renders "[message removed]".
- **Audit**: every mutation writes an `AuditLog` entry per the
  existing `AuditService.write` contract. See
  `docs/audit-and-gdpr.md`. Actions:
  `community.message.created`, `community.message.edited`,
  `community.message.deleted`, `community.message.redacted`,
  `community.channel.created`, `community.channel.archived`,
  `community.membership.added`, `community.membership.removed`,
  `community.membership.muted`, `community.reaction.added`,
  `community.reaction.removed`.
- **GDPR delete cascade**: when a `User` is hard-deleted, their
  Memberships cascade-delete, their Reactions cascade-delete, their
  Messages are redacted (tombstoned, not deleted) so thread integrity
  is preserved and other users' replies remain coherent. Their
  VoiceNote rows are hard-deleted (audio purged immediately, not on
  the standard 90-day timer).
- **Decimal money**: no money on these tables. Storage cost surfaces
  in the coach's bill via Wave 5; voice-note storage cost is sized in
  `voice-notes-spec.md` and read by the billing computation as a
  derived value, not stored on Message.

### Where Option A would diverge

Add `Reaction.emoji` (string), drop the `@@unique([message_id,
recipient_id])` constraint, replace with `@@unique([message_id,
recipient_id, emoji])`. Add `ReactionCountCache`. Add `Presence`
table. Add `MemberActivityScore` view.

### Where Option C would diverge

Drop `Reaction` table entirely. Drop `VoiceNote` table entirely.
Drop `voice_note_id` from `Message`.

---

## 4. State-transition tables

### 4.1 Message lifecycle

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| (start) | `POST /messages` | `created` | AuditLog write; ChannelEvent emit; push notification fan-out; auto-flag rules run |
| `created` | `PATCH /messages/:id` (within edit window) | `edited` | AuditLog write; original body preserved in audit metadata |
| `created` | `DELETE /messages/:id` (own) | `deleted` | AuditLog write; soft-delete; thread reply count decremented in `Thread` cache |
| `created` | Coach moderation | `redacted` | AuditLog write; body cleared; ModerationDecision row created; user notified per `moderation-and-safety.md` |
| `created` | Auto-flag triggers ban | `redacted` | Same as above + ban-ladder action on author |
| `edited` | `PATCH /messages/:id` (within edit window) | `edited` | New revision in audit metadata; edit-window timer not extended |
| `edited` | (edit window expires) | `created` (locked) | Edits no longer accepted; subsequent attempts return `MESSAGE_EDIT_WINDOW_EXPIRED` |
| `edited`, `created` | GDPR user purge of author | `redacted` (tombstone) | Body, voice, attachments cleared. Thread integrity preserved |
| `redacted` | (no further transitions) | - | Permanently locked |
| `deleted` | (90-day retention expiry) | `purged` | Hard delete; row removed; AuditLog retained |

Edit window: 15 minutes from `created_at`.

### 4.2 Channel lifecycle

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| (start) | Coach creates room | `active` | AuditLog; ChannelEvent emit |
| (start) | Cohort starts (Wave 2) | `active` (cohort) | Memberships auto-created from cohort roster |
| `active` | Coach archives | `archived` | Channel becomes read-only; excluded from default list ordering |
| `active` | Cohort ends (Wave 2) | `archived` (cohort) | Per OWNER_DECISION_DEFERRED — read-only archive recommended |
| `archived` | Coach unarchives (room only, not cohort) | `active` | AuditLog; channel re-listed |
| `archived` | (90-day retention from archive) | `purged` (optional) | Only if the coach chooses purge-on-archive; default is keep |
| any | Coach hard-delete channel (rare; admin escalation only) | `deleted` | AuditLog; channel + memberships + messages hard-deleted; user-visible warning required |

### 4.3 Membership lifecycle

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| (start) | Auto-create on cohort enrolment | `author` | Channel-scope visible |
| (start) | Coach adds to room | `author` | AuditLog |
| `author` | Coach mutes | `muted` (with `muted_until`) | Cannot post; can read |
| `author` | Coach bans | `banned` | Cannot post or read; channel disappears from member's UI |
| `muted` | `muted_until` expires | `author` | Cron job restores; AuditLog |
| `muted` | Coach unmutes manually | `author` | AuditLog |
| `banned` | Coach unbans | `author` | AuditLog (rare; required user-comm) |
| any | User leaves voluntarily | `left` | `left_at` set; row preserved for audit; messages remain |
| any | User account deletion (GDPR) | `purged` | Row hard-deleted; messages redacted |

### 4.4 Reaction lifecycle (Option B)

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| (start) | `POST /messages/:id/ack` | `created` | AuditLog; ChannelEvent emit |
| `created` | `DELETE /messages/:id/ack` (un-ack) | `deleted` | AuditLog; row hard-deleted (no tombstone — no public surface) |
| `created` | Message redacted | `cascade-deleted` | Reaction rows for redacted message hard-deleted |

---

## 5. Route surface

All routes are under `/api/community/`. All require auth (existing
session-cookie or bearer-token). All assert scope-stack per Wave 3.

Format: `VERB PATH | auth scope | rate-limit class | brief`

```
POST   /api/community/channels                         | COACH+        | rate-create   | create room
GET    /api/community/channels                         | any-auth      | rate-read     | list channels visible to caller
GET    /api/community/channels/:id                     | member        | rate-read     | channel detail
PATCH  /api/community/channels/:id                     | COACH+        | rate-write    | rename, retopic
POST   /api/community/channels/:id/archive             | COACH+        | rate-write    | archive
POST   /api/community/channels/:id/unarchive           | COACH+        | rate-write    | unarchive (rooms only)

POST   /api/community/channels/:id/messages            | author        | rate-message  | post message
GET    /api/community/channels/:id/messages            | reader        | rate-read     | paginate messages (cursor)
GET    /api/community/messages/:id                     | reader        | rate-read     | single message + thread root
PATCH  /api/community/messages/:id                     | author (own)  | rate-write    | edit (within window)
DELETE /api/community/messages/:id                     | author (own) or COACH+ | rate-write | soft-delete
POST   /api/community/messages/:id/redact              | COACH+        | rate-write    | moderation redaction
POST   /api/community/messages/:id/pin                 | COACH+        | rate-write    | pin message
DELETE /api/community/messages/:id/pin                 | COACH+        | rate-write    | unpin

POST   /api/community/messages/:id/ack                 | recipient     | rate-ack      | acknowledgement tick (Option B)
DELETE /api/community/messages/:id/ack                 | recipient     | rate-ack      | un-ack (Option B)

POST   /api/community/dm                               | coach/client/sub_coach | rate-create | initiate 1:1 DM (validates pairing)
GET    /api/community/dm                               | any-auth      | rate-read     | list DMs

POST   /api/community/threads/:rootMessageId/replies   | reader        | rate-message  | thread reply (depth 2 max)
GET    /api/community/threads/:rootMessageId           | reader        | rate-read     | thread tree

GET    /api/community/directory                        | any-auth      | rate-read     | member directory (consent-gated)
PATCH  /api/community/directory/me                     | self          | rate-write    | toggle directory consent

POST   /api/community/voice-notes                      | author        | rate-voice    | upload audio + create message (see voice-notes-spec.md)
GET    /api/community/voice-notes/:id                  | reader        | rate-read     | fetch transcript + signed audio URL
DELETE /api/community/voice-notes/:id                  | author or COACH+ | rate-write | delete (cascade redacts host message)

GET    /api/community/search                           | any-auth      | rate-search   | per-channel search (q, channel_id)
GET    /api/community/search/cross-channel             | any-auth      | rate-search   | cross-channel search (scope-gated)

GET    /api/community/moderation/queue                 | COACH+        | rate-read     | flagged items (see moderation-and-safety.md)
POST   /api/community/moderation/decisions             | COACH+        | rate-write    | resolve a flag

POST   /api/community/memberships/:id/mute             | COACH+        | rate-write    | mute (ban-ladder step)
POST   /api/community/memberships/:id/ban              | COACH+        | rate-write    | ban (ban-ladder step)
DELETE /api/community/memberships/:id/mute             | COACH+        | rate-write    | unmute
DELETE /api/community/memberships/:id/ban              | COACH+        | rate-write    | unban
```

### Rate-limit classes

| Class | Limit |
| --- | --- |
| `rate-read` | 600 / minute / user (read-heavy; cheap on read replica) |
| `rate-write` | 60 / minute / user |
| `rate-message` | 60 / minute / user (per channel; see channel-specific limits in section 1) |
| `rate-create` | 10 / minute / user (channel/DM creation) |
| `rate-ack` | 60 / minute / user |
| `rate-voice` | 6 / minute / user (uploads are heavy) |
| `rate-search` | 30 / minute / user |

Rate limits are enforced at the edge (existing rate-limit middleware)
and reasserted at the route handler. Burst tolerance: 1.5x for 10
seconds.

### Read replica vs primary

- All `GET` routes read from replica.
- All `POST` / `PATCH` / `DELETE` write to primary.
- Channel-list, message-list, thread-tree, member-directory all use
  the Wave 3 capability-hash cache key. TTL 30s for `GET
  /channels/:id/messages` (recent window), TTL 5m for older windows.
- `GET /api/community/messages/:id` is uncached (per-message latency
  matters for ack flow).

---

## 6. TypeScript-shaped API contracts

Format aligns with existing `docs/api-conventions.md`.

### 6.1 Error envelope

All routes use the existing platform error envelope:

```ts
type ErrorEnvelope = {
  error: {
    code: string;        // SCREAMING_SNAKE
    message: string;     // human-readable
    details?: Record<string, unknown>;
  };
  request_id: string;    // for support / log correlation
};
```

Community-specific error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `CHANNEL_NOT_FOUND` | 404 | Channel id does not exist or is out of caller's scope |
| `CHANNEL_ARCHIVED` | 423 | Channel is archived; writes rejected |
| `MESSAGE_EDIT_WINDOW_EXPIRED` | 409 | Edit beyond 15-minute window |
| `MESSAGE_REDACTED` | 410 | Message was redacted; cannot edit / ack / reply |
| `THREAD_DEPTH_EXCEEDED` | 400 | Reply target is itself a depth-2 reply |
| `DM_PAIRING_FORBIDDEN` | 403 | Forbidden DM pairing (e.g., client ↔ client) |
| `MEMBERSHIP_REQUIRED` | 403 | Caller has no Membership in target channel |
| `MEMBERSHIP_MUTED` | 403 | Caller is muted in target channel |
| `MEMBERSHIP_BANNED` | 403 | Caller is banned from target channel |
| `RATE_LIMITED` | 429 | Per the rate-limit class above |
| `VOICE_NOTE_TOO_LONG` | 400 | > 5min (OWNER_DECISION 3) |
| `VOICE_NOTE_TRANSCRIPT_PENDING` | 425 | Transcript not yet ready (see voice-notes-spec.md) |
| `MODERATION_FLAGGED` | 422 | Auto-flag rule rejected the post |
| `IDEMPOTENCY_CONFLICT` | 409 | Idempotency key was reused with different payload |

### 6.2 Idempotency

`POST /messages` accepts `Idempotency-Key` header. Server stores
`(idempotency_key, request_hash, response)` for 24 hours; reuse with
matching hash returns the cached response; reuse with non-matching
hash returns `IDEMPOTENCY_CONFLICT`.

Idempotency is mandatory on `POST /messages`,
`POST /messages/:id/ack`, `POST /voice-notes`. It is optional but
recommended on `POST /channels`, `POST /dm`.

### 6.3 Request / response shapes

```ts
// POST /api/community/channels/:id/messages
type CreateMessageRequest = {
  body: string;                         // 1..4000 chars; trim and validate
  parent_message_id?: string;           // for thread reply
  attachment_ids?: string[];            // pre-uploaded attachments
  voice_note_id?: string;               // pre-uploaded voice note
};

type CreateMessageResponse = {
  message: {
    id: string;
    channel_id: string;
    parent_message_id: string | null;
    author_id: string;
    body: string;
    voice_note_id: string | null;
    attachment_ids: string[];
    created_at: string;
    edited_at: string | null;
    redacted_at: string | null;
  };
};

// GET /api/community/channels/:id/messages
type ListMessagesRequest = {
  cursor?: string;                      // opaque cursor; created_at desc
  limit?: number;                       // default 50, max 200
  thread_root_id?: string;              // filter to a thread
};

type ListMessagesResponse = {
  messages: Array<CreateMessageResponse['message']>;
  next_cursor: string | null;
};

// POST /api/community/messages/:id/ack
type AckRequest = {};                   // body empty; recipient inferred
type AckResponse = {
  message_id: string;
  acknowledged_at: string;
};

// POST /api/community/dm
type CreateDmRequest = {
  recipient_user_id: string;
};
type CreateDmResponse = {
  channel_id: string;
  channel_type: 'dm';
  members: [string, string];            // [authorUserId, recipientUserId]
};

// GET /api/community/directory
type DirectoryRequest = {
  q?: string;                           // free-text search by display name
  cursor?: string;
  limit?: number;
};
type DirectoryResponse = {
  members: Array<{
    user_id: string;
    display_name: string;
    role: 'coach' | 'sub_coach' | 'client';
    joined_at: string;
  }>;
  next_cursor: string | null;
};

// PATCH /api/community/directory/me
type DirectoryConsentRequest = {
  listed: boolean;
};
type DirectoryConsentResponse = {
  listed: boolean;
};

// GET /api/community/search
type SearchRequest = {
  q: string;                            // 1..200 chars
  channel_id?: string;                  // null = cross-channel (separate route)
  cursor?: string;
  limit?: number;
};
type SearchResponse = {
  results: Array<{
    message_id: string;
    channel_id: string;
    channel_name: string | null;
    excerpt: string;                    // ~120 char window with highlight
    author_id: string;
    created_at: string;
    score: number;                      // recency * author_trust
  }>;
  next_cursor: string | null;
};
```

---

## 7. Search

### 7.1 Behaviour

Per-channel search and cross-channel search.

- Per-channel: `GET /api/community/search?channel_id=...&q=...`.
- Cross-channel: `GET /api/community/search/cross-channel?q=...`.
  Scope-gated to the caller's accessible channels per Wave 3
  scope-stack.

### 7.2 Ranking

`score = recency_factor * author_trust_factor`.

- `recency_factor`: exponential decay, half-life 7 days. Recent
  messages rank higher.
- `author_trust_factor`: 1.0 for coach, 0.9 for sub-coach, 0.7 for
  client. Adjusts naturally; no doctrine implication (this is not a
  social-proof surface visible to users).

Tokenisation: Postgres `tsvector` with English stemmer in v1. i18n
deferred (called out as follow-up; see Wave 11+).

### 7.3 Index

- `Message` table gets a `body_tsv` generated column (`tsvector`).
- GIN index on `body_tsv`.
- The index is rebuilt incrementally on insert/edit; redaction clears
  the tsvector.

Voice-note transcripts are searchable once `transcript_status='ready'`.
The transcript participates in the same `body_tsv` (concatenated to
the message body server-side at index time).

### 7.4 Privacy

- Cross-channel search results never include channels the caller
  cannot read. Scope-stack check is reasserted at result-render time.
- Redacted messages are excluded from search index.
- Members who have opted out of the directory still have their
  messages indexed (search is not a directory). This is intentional;
  the doctrine prevents *enumerating* members, not *finding their
  contributions when explicitly searching for them*.

---

## 8. Failure modes

>= 6 required by the platform standard. Listed with detection +
recovery.

### F-1. Spam burst

A user (or compromised account) posts dozens of identical messages to
a high-traffic room.

- **Detection**: per-user-per-channel post rate exceeds the rate limit
  + a duplicate-content heuristic (jaccard-similarity of last 5
  messages > 0.9) triggers a soft alarm to the moderation queue.
- **Recovery**: rate limiter blocks at 60/min hard cap; auto-flag
  pipeline (`moderation-and-safety.md`) escalates duplicate-content
  >= 3x in 60s to auto-mute (24h) per ban-ladder. Queue notified;
  coach can override.
- **User-facing**: spammer sees `RATE_LIMITED`; channel members see
  no extra surface beyond the existing messages until moderation
  action runs (typically <60s).

### F-2. Deleted user cascade

A coach hard-deletes their account. They authored messages,
acknowledgements, and own channels.

- **Detection**: GDPR delete job (existing platform contract,
  `docs/audit-and-gdpr.md`) is invoked.
- **Recovery**:
  - Coach's `Membership` rows cascade-delete.
  - Coach's `Reaction` rows cascade-delete.
  - Coach's `Message` rows are **redacted** (tombstoned), not deleted.
    Body, voice_note_id, attachment_ids cleared. UI renders "[message
    removed]".
  - Coach's `VoiceNote` rows are hard-deleted; audio storage purged
    immediately, not on the standard 90-day timer.
  - Channels owned by the coach (created_by) are reassigned to the
    org's primary admin; if no admin, channels are archived.
  - `AuditLog` entries reference the deleted user via
    `actor_email_snapshot` (per existing platform pattern); the FK
    `actor_id` becomes NULL.
- **User-facing**: other users see tombstones; thread integrity is
  preserved. Replies still resolve to a parent (the tombstone).

### F-3. Broken thread (parent deleted before child)

Race condition: two clients, one deletes the parent message while
another is mid-flight posting a reply.

- **Detection**: reply insert sees `parent.deleted_at IS NOT NULL` or
  `parent.redacted_at IS NOT NULL`.
- **Recovery**:
  - If parent is **soft-deleted** (own user delete): reply insert is
    rejected with `MESSAGE_REDACTED` (HTTP 410). The client is told to
    refresh; their drafted text is preserved client-side.
  - If parent is **redacted** (moderation): same.
  - If parent is **hard-deleted** (post-purge): same; FK constraint
    `ON DELETE SET NULL` keeps the reply but UI renders the reply with
    no parent context, marked "in reply to a removed message".
- **Test**: integration test creates parent, starts reply transaction,
  deletes parent, commits reply transaction; expects `MESSAGE_REDACTED`.

### F-4. Stale read receipts (acknowledgement tick out of sync)

Recipient acks a message; sender's UI does not refresh because of a
WebSocket gap.

- **Detection**: client-side: ack POST returned 200 but local UI
  state did not update due to race; server-side: SSE / WS event was
  emitted but not delivered.
- **Recovery**:
  - Client reconciles on next channel-list / channel-detail fetch
    (uses cache-key invalidation per Wave 3).
  - Server emits a follow-up SSE event on next connection
    (the ack table is the source of truth; SSE is best-effort).
  - Client polls fallback every 30s if SSE stream is broken (existing
    Wave 3 fallback contract).

### F-5. Message edit race

Two clients (e.g., a user on web and the same user on mobile) attempt
to edit the same message within the edit window.

- **Detection**: `Message.edited_at` is checked against an
  `if-unmodified-since` precondition that the client passes.
- **Recovery**:
  - If precondition fails: return `412 PRECONDITION_FAILED`. Client
    refreshes, applies edit on top of new server state, retries.
  - Server retains both edits in `AuditLog` metadata (each edit is a
    separate audit entry; full revision chain reconstructable).

### F-6. Voice-note transcription failure

Audio uploaded; transcription pipeline (sonar-pro) returns an error
(rate limit, content-too-long, etc).

- **Detection**: `VoiceNote.transcript_status='failed'`. Detail in
  `voice-notes-spec.md`.
- **Recovery**:
  - Background job retries up to 3x with exponential backoff.
  - On 3rd failure, message is preserved, audio is preserved, but
    transcript is marked `failed`. UI shows a "transcript unavailable"
    notice; users may listen to the audio anyway. The audio-only
    fallback is the only case where audio without transcript is
    permitted.
  - Coach can manually request a re-transcribe via admin tool (POST
    `/voice-notes/:id/retry-transcribe`, COACH+ only).

### F-7. Cohort end → channel archive race

Cohort end-date passes while a member is mid-flight posting.

- **Detection**: cron job archives cohort channels at cohort end. If
  a message POST arrives after the archive transaction commits, the
  channel is `archived_at IS NOT NULL`.
- **Recovery**:
  - Message POST returns `CHANNEL_ARCHIVED` (HTTP 423).
  - Client UX: "this cohort has ended; would you like to message your
    coach in DM?" (deep-link to DM with the coach).
  - Cron runs at cohort_end + 5m grace period to reduce race window.

### F-8. DM pairing validation drift

A client and a coach were paired via an active program. The program
ends. The DM channel persists. New messages should still be allowed
(history, follow-up support) but new DM **initiations** should be
denied if no active program exists.

- **Detection**: `POST /api/community/dm` checks for an active
  program between the requested pair. If none, rejects with
  `DM_PAIRING_FORBIDDEN`.
- **Recovery**:
  - Existing DM channels are not affected; messages within them flow.
  - If the coach wants to message a former client outside an active
    program, they must re-enrol the client in a program (or send a
    one-shot announcement via a different channel, not DM).
  - This protects against the doctrine's "no parasocial replacement"
    clause in the DM surface.

---

## 9. Performance budgets

Targets at three coach-scale tiers. Source-of-truth on the
methodology: `docs/metrics.md` (existing).

| Endpoint | Scale | p50 | p95 |
| --- | --- | --- | --- |
| `GET /channels/:id/messages` (recent window, cached) | 100 coaches | < 50ms | < 150ms |
| `GET /channels/:id/messages` | 1k coaches | < 80ms | < 250ms |
| `GET /channels/:id/messages` | 10k coaches | < 150ms | < 400ms |
| `POST /channels/:id/messages` | 100 coaches | < 80ms | < 200ms |
| `POST /channels/:id/messages` | 1k coaches | < 120ms | < 300ms |
| `POST /channels/:id/messages` | 10k coaches | < 200ms | < 500ms |
| `POST /messages/:id/ack` | any | < 30ms | < 100ms |
| `GET /search` (per-channel) | any | < 200ms | < 500ms |
| `GET /search/cross-channel` | any | < 400ms | < 1000ms |
| `POST /voice-notes` (excl. transcription) | any | < 500ms | < 2000ms |
| Voice-note transcription end-to-end | any | < 30s | < 60s |

Cache TTLs:

| Cache | TTL | Invalidation |
| --- | --- | --- |
| Channel list (per scope) | 30s | On channel create/archive, membership add/remove |
| Channel messages (recent window) | 30s | On message create/edit/delete in channel |
| Channel messages (older windows) | 5m | On redaction in window |
| Member directory (per org) | 5m | On directory consent toggle |
| Search (per query) | 60s | None (TTL only) |

---

## 10. Audit log entries

Every mutation writes an `AuditLog` entry per `docs/audit-and-gdpr.md`.

| Action | actor | target | metadata |
| --- | --- | --- | --- |
| `community.channel.created` | actor user | channel.id | `{type, name, cohort_id?}` |
| `community.channel.archived` | actor user | channel.id | `{reason: 'manual'|'cohort_end'}` |
| `community.message.created` | author | message.id | `{channel_id, has_voice, has_attachments}` |
| `community.message.edited` | author | message.id | `{old_body_hash, new_body_hash}` (no PII; hash only) |
| `community.message.deleted` | actor user | message.id | `{soft: true, reason}` |
| `community.message.redacted` | moderator | message.id | `{moderation_flag_id, reason}` |
| `community.message.pinned` | actor | message.id | `{}` |
| `community.message.unpinned` | actor | message.id | `{}` |
| `community.reaction.added` | recipient | message.id | `{}` |
| `community.reaction.removed` | recipient | message.id | `{}` |
| `community.membership.added` | actor | membership.id | `{channel_id, user_id, role}` |
| `community.membership.removed` | actor | membership.id | `{reason}` |
| `community.membership.muted` | actor | membership.id | `{muted_until}` |
| `community.membership.banned` | actor | membership.id | `{reason}` |
| `community.directory.consent_changed` | self | user.id | `{listed}` |
| `community.dm.created` | initiator | channel.id | `{recipient_id}` |

Audit fields use the existing pattern: `actor_id` (FK with ON DELETE
SET NULL), `actor_email_snapshot` (survives PII scrub), `tenant_coach_id`
(scope), `created_at`.

---

## 11. Admin data-feed events

Per Wave 3 SSE envelope. Events emitted from `ChannelEvent`:

| Event type | Payload |
| --- | --- |
| `community.message.created` | `{channel_id, message_id, author_id, has_voice}` |
| `community.message.edited` | `{channel_id, message_id, author_id}` |
| `community.message.deleted` | `{channel_id, message_id}` |
| `community.message.redacted` | `{channel_id, message_id, reason_class}` |
| `community.reaction.added` | `{channel_id, message_id, recipient_id}` |
| `community.channel.created` | `{channel_id, type}` |
| `community.channel.archived` | `{channel_id, reason}` |
| `community.membership.added` | `{channel_id, user_id, role}` |
| `community.membership.muted` | `{channel_id, user_id, muted_until}` |
| `community.membership.banned` | `{channel_id, user_id}` |

Events use the existing capability-hash cache key; consumers (admin
console, retention engine) subscribe via the Wave 3 SSE / polling
fallback envelope.

---

## 12. Day-1 implementation order

Senior-engineer onboarding order. A single engineer can ship Step 1
in a day; the full set is ~6 weeks of work.

1. Schema migration (Channel, Membership, Message, Reaction, Thread,
   VoiceNote, ChannelEvent). Apply in dev. Verify GDPR cascade.
2. Route surface scaffolding (handlers return 501 until services
   land). Auth guards + scope-stack check + rate-limit middleware
   wired.
3. Channel + Membership service. CRUD + archive + the four channel
   types' permission rules.
4. Message service: create, list, edit, delete, redact. Idempotency
   key handling. Audit-log writes.
5. Thread support: parent_message_id resolution, depth check, Thread
   cache projection.
6. Reaction (Option B): create / delete ack. AuditLog. ChannelEvent
   emit.
7. Search: tsvector column + GIN index + per-channel route.
8. Cross-channel search: scope-gated route.
9. Member directory + directory consent.
10. DM creation with pairing validation.
11. Voice-note pipeline (see `voice-notes-spec.md`).
12. Moderation queue + auto-flag (see `moderation-and-safety.md`).
13. Discord federation read-only (see `integration-with-discord.md`).
14. Mobile mirror handoff.

Each step ships with: unit tests on the service, integration tests
on the route, an e2e test on the principal flow, and a load test
sized to the 1k-coach budget. Detail in section 14 (test plan).

---

## 13. Migration / backfill plan

No backfill required. This is greenfield community surface; there is
no prior schema to migrate from.

Rollout:

1. Apply schema migration in staging.
2. Smoke-test create + post + ack + thread.
3. Apply in production behind a feature flag (`community.enabled`,
   default off, per-org).
4. Enable for one pilot coach. Monitor metrics (error rate, p95,
   moderation flags).
5. Gradual rollout to 10%, 50%, 100% over 4 weeks.
6. Remove feature flag after 100% rollout for 30 days with no
   incident.

If rollback is required:

- Schema is additive only. Rollback = disable feature flag; no DROP
  required.
- If a hot-fix migration is needed, it follows the existing
  `prisma/schema.prisma` migration cadence (see existing repo).

---

## 14. Test plan

### 14.1 Unit

- Channel-type permission rules (announcement post denies client;
  cohort post denies non-cohort-member; DM rejects forbidden
  pairings).
- Thread depth resolution (depth 2 max).
- Idempotency key handling (matched returns cached, mismatch returns
  conflict).
- Edit window expiry.
- Rate-limit class assignment.
- AuditLog metadata correctness per action.

### 14.2 Integration

- Create channel → post → ack → list → archive flow.
- DM forbidden pairings (client ↔ client) hard-blocked.
- Membership mute prevents post.
- Membership ban hides channel.
- Redaction clears body but preserves thread structure.
- GDPR delete cascade: user delete → memberships gone, reactions
  gone, messages tombstoned, voice notes hard-deleted.

### 14.3 E2E

- Browser test: coach creates room, invites client, both post,
  ack, edit, delete, search.
- Mobile mirror test: deferred to Wave 4 follow-up.
- Voice-note end-to-end: record → upload → transcribe → display →
  search-by-transcript.

### 14.4 Load

- 1k concurrent users posting to 100 channels at the rate-limit
  ceiling. p95 must hold within budget.
- 10k coaches × 100 messages/day baseline. Search index growth
  measured; reindex job runs nightly.

---

## 15. Rollback plan

The schema is additive; rollback path is disabling the feature flag
on the route surface. The schema rows persist (do not DROP). If
ownership changes its mind on Option B and needs to rebuild as A or
C, the migration is forward-only:

- B → A: add columns / tables. Existing rows unaffected.
- B → C: drop the `Reaction` table (after audit-log archive) and the
  `VoiceNote` table (after audio purge). Rows are intentionally lost.

---

## 16. Senior-engineer onboarding checklist

Before claiming "done" on Wave 10 implementation:

- [ ] Schema migration applied in staging without error.
- [ ] All 28+ routes return 200 on a happy-path integration smoke.
- [ ] 4xx error envelope codes match section 6.1 exactly.
- [ ] Rate limits enforced at edge + handler.
- [ ] AuditLog entries match section 10.
- [ ] ChannelEvent events match section 11.
- [ ] Cache keys use Wave 3 capability-hash scheme.
- [ ] Idempotency key handling tested for all required routes.
- [ ] DM pairing validation tested for forbidden pairings.
- [ ] Thread depth enforced.
- [ ] Voice-note pipeline ships per `voice-notes-spec.md`.
- [ ] Moderation pipeline ships per `moderation-and-safety.md`.
- [ ] Search per-channel + cross-channel return scope-gated results.
- [ ] Performance budgets met at 1k-coach load.
- [ ] Mobile mirror handoff issued.

---

## 17. i18n / accessibility follow-ups (deferred)

- Tokeniser for non-English search (deferred to a future wave; the
  English `tsvector` is sufficient for v1 because pilot coaches are
  English-speaking).
- Right-to-left UI in chat: deferred.
- Screen-reader pass on the chat surface: required pre-launch but is
  a frontend concern (mobile + web) tracked in Wave 4 follow-up.
- Voice-note transcript-default-visible is itself an accessibility
  feature; see `voice-notes-spec.md`.

---

## 18. Cross-repo dep map

| Repo | What it consumes from this spec |
| --- | --- |
| `growth-project-mobile` | All routes; voice-note recording native bridge; push notifications for new messages and acks. |
| `tgp-finance-app` | Storage cost line item for voice notes in the per-org bill (read from a derived per-org metric, not from `Message` directly). |
| Admin console (in `growth-project-backend`) | The 14 audit-log actions; the 10 admin-data-feed events; moderation queue UI shipping in `moderation-and-safety.md`. |

---

## 19. Notes for the next agent / reviewer

If you are reading this PR draft to decide whether it is approveable:

- The single decision the owner must make is OWNER_DECISION 1 (A vs
  B vs C). See `doctrine-decision-rfc.md`.
- Everything in this file assumes Option B. If A is selected, this
  file expands (presence service, reactor lists, ranking pipeline).
  If C is selected, this file shrinks (drop Reaction, drop voice).
- Voice notes (`voice-notes-spec.md`), moderation
  (`moderation-and-safety.md`), and Discord federation
  (`integration-with-discord.md`) are independent enough to ship in
  any order *after* the channel + thread spec lands. The moderation
  spec's auto-flag rules reference message body, so it has a soft
  dependency on this file's `Message` shape.
