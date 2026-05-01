# Discord Federation

Status: DRAFT spec, docs-only. Conditional on OWNER_DECISION 4
(read-only v1, bidirectional v2 recommended).

Many TGP coaches already run a Discord community. Forcing them to
migrate to native chat (Wave 10 Option B) on day one is hostile.
Federating with Discord lets TGP **read** Discord chat events, surface
them in the admin data-feed (Wave 3), and feed the retention engine
(Wave 2) without forcing migration. Bidirectional sync (TGP ↔ Discord)
is the v2 stretch.

This file specifies the federation contract: OAuth, rate-limit
handling, Discord ToS compliance, identity reconciliation, audit, and
failure modes.

---

## 1. Bridge depth options

### Option D-RO — Read-only (RECOMMENDED v1)

TGP polls / receives Discord events from connected guilds and
mirrors them as **read-only** records. The mirror appears in:

- Admin data-feed (Wave 3) as new event types.
- A read-only "Discord activity" panel in the admin console (no
  write surface).
- The retention engine consumes the events as a behavioural signal.

TGP does **not** post into Discord, edit Discord messages, or
moderate Discord content. The Discord guild remains 100% Discord-
managed.

### Option D-BI — Bidirectional (v2)

TGP and Discord stay in sync. A native message in TGP is mirrored
to Discord; a Discord message is mirrored to TGP. Edits and deletes
propagate. Reactions (under Option B, the acknowledgement tick;
under Option A, the full palette) propagate where mappable.

This is meaningfully more complex (rate-limit budget on Discord side
during burst, identity reconciliation strictness, conflict resolution
on simultaneous edit, ToS edge cases) and is **not in v1**.

### Recommendation

**v1 = D-RO.** v2 = D-BI behind a separate `discord.bidirectional`
flag, gated by ToS legal review and rate-limit headroom.

---

## 2. Discord ToS compliance

The bridge uses **only the public Bot API**. No scraping, no
unauthorised account access, no token harvesting.

Constraints:

- The bot must be invited to the guild by a Discord guild admin.
  TGP does not auto-join.
- The bot's intents are scoped to: `GUILD_MESSAGES`,
  `GUILD_MESSAGE_REACTIONS`, `GUILDS`, `GUILD_MEMBERS` (the last is a
  privileged intent and requires Discord verification once usage > 100
  guilds).
- The bot does not store Discord user passwords (it cannot — the API
  doesn't expose them).
- The bot complies with Discord's Developer Terms of Service and
  Privacy Policy (linked in the in-app connect flow).
- Discord users' content stored on TGP is mirrored only for users who
  have a TGP account linked to their Discord identity (see section 4
  on identity reconciliation). Unlinked-user content is not stored
  beyond a transient processing window — see section 9 on retention.

If Discord changes its ToS in a way that conflicts with this spec,
the bridge is **paused** and the platform notifies coaches. The
bridge does not silently degrade or operate in a grey zone.

---

## 3. OAuth flow

### 3.1 Coach connects Discord

```
[Coach in TGP]                  [TGP backend]               [Discord OAuth]
   |                                 |                            |
   |--Click "Connect Discord" ------>|                            |
   |                                 |--Build OAuth URL ---------->|
   |                                 |  (scopes: guilds, applications.commands)|
   |<-- Redirect to Discord OAuth --|                            |
   |--Authorize on Discord -------------------------------------->|
   |<-- Redirect to TGP w/ code ----------------------------------|
   |                                 |                            |
   |--Provide auth code ------------>|                            |
   |                                 |--Exchange code for token-->|
   |                                 |<-- access + refresh token--|
   |                                 |--Persist DiscordIntegration |
   |                                 |  row (encrypted at rest)    |
   |<-- "Connected; choose guild" --|                            |
```

### 3.2 Coach selects a guild and invites the bot

Once connected, the coach sees a list of guilds they admin. They
choose one and click "Invite TGP bot". Discord opens its standard
bot-invite flow with TGP's bot client ID and the required intents.

### 3.3 Bot lands in the guild

TGP receives a Discord `GUILD_CREATE` event for the new guild. TGP:

1. Verifies the inviter's Discord user ID matches the connected
   coach's Discord ID.
2. Creates a `DiscordGuildBinding` row linking the guild to the
   coach's TGP org.
3. Enqueues a backfill job (last 30 days of Discord messages, scoped
   to the channels the coach selects; default = none until coach
   picks).
4. Starts the live event subscription via Discord's gateway
   (websocket).

---

## 4. Identity reconciliation (TGP user ↔ Discord user)

A Discord message authored by Discord-user-X needs to be attributed
to TGP-user-Y for the bridge to be useful. Three reconciliation
strategies:

### 4.1 Strict (RECOMMENDED, sub-decision deferred under OWNER_DECISION_DEFERRED in README)

Each TGP user explicitly links their Discord account via OAuth. Until
linked, Discord messages from that user are stored as
"unlinked-discord-user" records and **do not** flow to the retention
engine or admin data-feed.

- Pro: zero false attributions; clean GDPR posture.
- Con: low coverage initially; coaches see "unlinked" markers.

### 4.2 Heuristic — email match

TGP attempts to link Discord users by email. Requires Discord's
`email` scope (granted by user in OAuth).

- Pro: higher initial coverage.
- Con: emails may not match (work email vs Discord email); risk of
  silent mis-attribution.

### 4.3 Heuristic — display-name + per-guild membership

TGP guesses a link based on display name overlap and the user's
membership in both the TGP org and the Discord guild.

- Pro: highest initial coverage.
- Con: lowest accuracy; doctrine prefers strict.

**Recommended v1: strict (4.1).** A heuristic option may be added
later behind a coach toggle.

### 4.4 Storage

```prisma
model DiscordIntegration {
  id              String   @id @default(cuid())
  coach_id        String   // FK Coach
  org_id          String
  discord_user_id String   // the connecting coach's Discord ID
  access_token    String   // encrypted at rest
  refresh_token   String   // encrypted at rest
  token_expires_at DateTime
  scopes          String[]
  created_at      DateTime @default(now())
  revoked_at      DateTime?

  @@unique([coach_id])
  @@index([discord_user_id])
}

model DiscordGuildBinding {
  id              String   @id @default(cuid())
  org_id          String
  discord_guild_id String   @unique
  installed_by_user_id String
  watched_channel_ids String[]  // coach-curated subset of guild channels
  bidirectional   Boolean  @default(false) // v2 only
  installed_at    DateTime @default(now())
  uninstalled_at  DateTime?

  @@index([org_id])
}

model DiscordUserLink {
  id              String   @id @default(cuid())
  user_id         String   // FK to TGP User
  discord_user_id String
  linked_at       DateTime @default(now())
  unlinked_at     DateTime?

  @@unique([discord_user_id])
  @@unique([user_id])
}

model DiscordMessageMirror {
  id              String   @id @default(cuid())
  discord_guild_id String
  discord_channel_id String
  discord_message_id String  @unique
  discord_author_id String
  tgp_user_id     String?  // null if unlinked
  body            String?  // null if unlinked + retention window expired
  body_hash       String?  // hash for dedup / search-without-PII
  created_at      DateTime
  edited_at       DateTime?
  deleted_at      DateTime?
  ingested_at     DateTime @default(now())

  @@index([discord_guild_id, created_at])
  @@index([tgp_user_id, created_at])
}
```

---

## 5. Event ingestion

Two pipelines:

### 5.1 Live (gateway websocket)

The Discord bot maintains a gateway connection. Inbound events:

- `MESSAGE_CREATE` → write `DiscordMessageMirror` + emit
  `community.discord.message_mirrored` ChannelEvent.
- `MESSAGE_UPDATE` → update mirror + emit
  `community.discord.message_edited`.
- `MESSAGE_DELETE` → soft-delete mirror + emit
  `community.discord.message_deleted`.
- `MESSAGE_REACTION_ADD` (v2 only).
- `MESSAGE_REACTION_REMOVE` (v2 only).

Per Discord's recommendation, the gateway connection is sharded if
the bot lives in > 1000 guilds. v1 ships unsharded; sharding is added
when usage warrants.

### 5.2 Backfill (REST polling)

On guild connect, a one-time backfill of the last 30 days runs via
Discord's REST API, paginated. Backfill respects rate limits (see
section 6) and processes channels serially to avoid burst.

---

## 6. Rate-limit handling

Discord's rate limits are bucket-based, headers expose remaining
quota.

- The bot reads `X-RateLimit-Remaining` and
  `X-RateLimit-Reset-After` on every REST call.
- On `429`, the bot honours `Retry-After` exactly. Repeated 429s
  trigger a circuit breaker (15-minute pause).
- For backfill, the bot caps requests at 80% of bucket capacity to
  leave headroom for live operations.
- For live (gateway), there is no per-request rate limit but a global
  120 events / 60s gateway limit; enforced at the bot.

If TGP's bot crosses Discord's "Cloudflare ban" threshold (sustained
abuse), Discord may revoke the bot. The platform pauses ingestion,
notifies coaches, contacts Discord developer support.

---

## 7. Permissions inside TGP

| Action | OWNER | COACH | SUB_COACH | CLIENT | ADMIN |
| --- | --- | --- | --- | --- | --- |
| Connect Discord (OAuth) | n/a | Yes (own org) | No | No | Yes (own org) |
| Add a guild binding | n/a | Yes | No | No | Yes |
| Choose watched channels | n/a | Yes | No | No | Yes |
| View Discord activity panel | Yes | Yes (own org) | Yes (own scope) | No (v1) | Yes |
| Disconnect Discord | n/a | Yes | No | No | Yes |
| Link own Discord identity | n/a | Yes | Yes | Yes | Yes |
| Unlink own Discord identity | n/a | Yes | Yes | Yes | Yes |

Clients **do not** see Discord-mirrored content from other clients in
v1. The mirror feeds the admin data-feed and retention engine; the
client-facing community surface is native chat (Option B).

---

## 8. Audit log

| Action | actor | target | metadata |
| --- | --- | --- | --- |
| `community.discord.connected` | coach | discord_integration.id | `{discord_user_id_hash}` |
| `community.discord.disconnected` | coach | discord_integration.id | `{}` |
| `community.discord.guild_bound` | coach | discord_guild_binding.id | `{discord_guild_id}` |
| `community.discord.guild_unbound` | coach | discord_guild_binding.id | `{}` |
| `community.discord.identity_linked` | user | discord_user_link.id | `{}` |
| `community.discord.identity_unlinked` | user | discord_user_link.id | `{}` |
| `community.discord.message_mirrored` | system | discord_message_mirror.id | `{guild_id, channel_id}` |
| `community.discord.bridge_paused` | system | discord_integration.id | `{reason}` |

---

## 9. Retention

- **Mirrored messages with linked TGP user**: retained per the standard
  message retention window (see `channel-and-thread-spec.md`).
- **Mirrored messages with unlinked Discord user**: stored only as
  metadata (`body_hash`, no `body`) for at most 30 days; raw body
  purged earlier.
- **Discord OAuth tokens**: encrypted at rest. Refresh on schedule.
  Revoked tokens are tombstoned (`revoked_at` set, encrypted blobs
  cleared).
- **Backfill**: bounded to last 30 days. Older content is not
  ingested.

GDPR cascade:

- TGP user deletes account → their `DiscordUserLink` row is
  hard-deleted; their `DiscordMessageMirror` rows have `tgp_user_id`
  set NULL but body retention is shortened to the unlinked path
  (30-day metadata window).
- Coach disconnects Discord → all bindings + mirrors for that org
  are soft-deleted; hard-deleted after 30 days.
- Discord user requests via Discord (TGP receives via the bot's
  webhook): TGP processes per the same cascade.

---

## 10. Failure modes

### F-1. OAuth token revocation

Coach revokes the OAuth grant on Discord's side without telling TGP.

- **Detection**: next API call returns 401.
- **Recovery**:
  - Mark `DiscordIntegration.revoked_at`.
  - Stop the gateway connection for guilds owned by this coach.
  - Notify coach in-app: "Discord connection lost — reconnect to
    resume mirroring."
  - AuditLog `community.discord.bridge_paused` with reason `oauth_revoked`.

### F-2. Rate-limit breach

The bot hits a 429 storm during a busy guild's burst.

- **Detection**: 429s exceed 50 in 60s.
- **Recovery**:
  - Circuit breaker opens; ingestion pauses 15min.
  - Backfill jobs back off further.
  - If sustained for > 1h: bridge paused; coach notified.

### F-3. Discord outage

Discord status page reports an incident; gateway disconnects.

- **Detection**: gateway reconnect failures > 3 in 10min.
- **Recovery**:
  - Fall back to REST polling at 5min intervals (very low rate).
  - On Discord recovery, gateway resumes; missed events are
    backfilled via REST for the gap window.

### F-4. Identity mismatch (Discord user appears to be linked but isn't)

A Discord message arrives whose author was previously linked but
unlinked while the message was in flight.

- **Detection**: ingestion looks up `DiscordUserLink.unlinked_at`.
- **Recovery**: store as unlinked (`tgp_user_id=NULL`); the 30-day
  metadata-only window applies.

### F-5. Bidirectional conflict (v2 only)

A message edited simultaneously in TGP and in Discord.

- **Detection**: timestamp comparison; the later-write-wins, but if
  within 5s, the conflict is logged.
- **Recovery**:
  - Last write wins by `edited_at`.
  - The losing edit is retained in audit metadata for review.

### F-6. Discord ToS change

Discord adjusts the bot policy in a way that conflicts with TGP's
ingestion.

- **Detection**: monitored externally (Discord developer changelog
  +legal team review).
- **Recovery**: bridge paused; coaches notified; spec updated; bridge
  resumed only after compliance is restored.

### F-7. Bot account deauthorised

Discord removes the bot from a guild (kicked by a guild admin or
banned).

- **Detection**: `GUILD_DELETE` gateway event.
- **Recovery**: mark `DiscordGuildBinding.uninstalled_at`; coach
  notified; mirror data follows the disconnect retention path.

### F-8. Unlinked user data accumulation

A guild has 1000 active Discord users but only 50 are linked to TGP
accounts. The 950 unlinked users' content accumulates as metadata.

- **Detection**: routine retention-cleanup cron.
- **Recovery**: 30-day cron purges body for unlinked users; metadata
  remains for the bounded window. A coach can also bulk-purge unlinked
  data on demand.

---

## 11. Performance budgets

| Operation | p50 | p95 |
| --- | --- | --- |
| Live event mirror (single message) | < 100ms (ingestion) | < 300ms |
| Backfill (30 days, 100k messages) | n/a | < 30 minutes |
| OAuth token refresh | < 200ms | < 500ms |

---

## 12. Test plan

### Unit
- Rate-limit header parsing.
- Token encryption / decryption.
- Identity reconciliation (strict mode rejects unlinked).
- Discord webhook signature verification (per Discord's standard).

### Integration
- OAuth happy path (mock Discord).
- Bot invited to guild → backfill enqueued.
- Live message → mirror row created.
- 429 → circuit breaker opens.
- Coach disconnect → mirrors retention shortened.

### E2E
- Coach connects Discord → bot lands in guild → message in Discord
  appears in admin data-feed.
- Client links own Discord identity → their Discord messages
  attribute correctly.
- Client unlinks → subsequent messages mirror as unlinked.
- Coach disconnects → 30-day countdown begins; verified via
  synthetic time-jump.

### Load
- 10k mirrored messages / day across 100 guilds. Gateway holds; rate
  limits not breached.

---

## 13. Day-1 implementation order

1. `DiscordIntegration` + `DiscordGuildBinding` schema.
2. OAuth connect endpoint.
3. Bot creation in the Discord developer portal; required intents
   requested.
4. Gateway connection + `MESSAGE_CREATE` handler.
5. `DiscordMessageMirror` table + ingestion service.
6. Identity link / unlink endpoints.
7. Admin console "Discord activity" panel.
8. Backfill REST polling job.
9. Disconnect / cleanup flow.
10. (v2) Bidirectional sync — separate spec when v1 lands.

---

## 14. Senior-engineer onboarding checklist

- [ ] Discord developer application created; client ID and secret
      stored in secrets manager.
- [ ] Bot token rotated after creation (per Discord recommendation).
- [ ] OAuth redirect URL whitelisted in Discord application settings.
- [ ] Gateway websocket library chosen and integrated.
- [ ] Rate-limit middleware with header parsing in place.
- [ ] `DiscordIntegration` token encryption verified.
- [ ] CSAM detection on Discord-mirrored attachments wired into the
      moderation pipeline (`moderation-and-safety.md`).
- [ ] Backfill job tested with a synthetic 30-day Discord guild.
- [ ] Identity reconciliation (strict mode) verified across linked and
      unlinked users.
- [ ] GDPR cascade tested for both TGP-side and Discord-side delete
      requests.

---

## 15. Out of scope (v1)

- Bidirectional sync (deferred to v2 behind OWNER_DECISION 4).
- Discord voice channels (no audio ingestion).
- Discord stage events.
- Discord forum channels (text-channel ingestion only).
- Slack integration. The same shape would apply if Slack ever
  becomes a federation target, but Slack is not in this spec.
- Telegram. Same.

---

## 16. Bidirectional sync (v2 sketch)

This section is a sketch, not a binding spec, for what bidirectional
sync would entail. The owner can defer this entirely until v2.

### 16.1 Direction of sync

- **TGP → Discord**: when a coach posts in a TGP channel mapped to a
  Discord channel, the message appears in Discord. The Discord-side
  author handle is the bot, with a webhook avatar override matching
  the TGP author.
- **Discord → TGP**: when a Discord-linked user posts in a watched
  Discord channel, the message appears in TGP via the
  DiscordMessageMirror, with the linked TGP user as the attributed
  author.

### 16.2 Edit / delete propagation

- Edit on either side propagates to the other within 5 seconds.
- Delete on either side soft-deletes the mirror on the other.
- A deleted message that has already been bridged: the bridge writes
  a tombstone update to the other side ("[message removed by author]").

### 16.3 Conflict resolution

- Last-write-wins by `edited_at`.
- Within 5s: both edits are preserved in audit metadata; the more
  recent edit is the visible state.
- If TGP redacts a message under moderation but Discord still shows
  the original: TGP propagates a delete to Discord, with the bot's
  delete privileges (bot must have `MANAGE_MESSAGES` on the channel,
  which means the bot must have permission scope; coach must elect
  to grant).

### 16.4 Reaction propagation

Under Option B chat, the only TGP reaction is the acknowledgement
tick. This does not map to Discord's reaction palette. Decision: do
not propagate ticks to Discord; do not propagate Discord reactions
to TGP. Reactions in v2 stay one-directional in spirit.

Under Option A chat (if owner picks A), reactions could map. But
mapping the full emoji palette requires care because Discord allows
custom guild emoji that have no TGP equivalent. v2 would store the
Discord emoji as a free-form string and render it as plain text in
TGP if no mapping exists.

### 16.5 Identity at bridge time

For TGP → Discord: the TGP user must have a linked Discord identity;
otherwise the bridge writes the message under the bot's own identity
with a "[posted via TGP]" annotation. This is to prevent
attribution-fraud (a TGP user without a Discord account writing as
themselves into Discord).

For Discord → TGP: the Discord user must have a linked TGP identity
under the strict reconciliation mode. Unlinked-user messages do not
propagate (they remain mirror-only).

### 16.6 Rate-limit budget

Bidirectional doubles the load. v2 spec must include sharding
strategy, rate-limit headroom of >= 50% (vs the 80% under read-only),
and a cap on bridge volume per channel per hour.

### 16.7 v2 owner decisions

- v2-1: Identity strictness for TGP → Discord (strict only?).
- v2-2: Reaction propagation (off by default; opt-in?).
- v2-3: Coach-only or full-community? (recommend coach-only initially).
- v2-4: Failover when bridge has been down (catch-up on reconnect vs
  drop the gap?).

These are placeholders for v2; not for v1 owner attention.

---

## 17. Coach-facing setup checklist

What a coach goes through to enable Discord federation in v1:

1. Visit Settings → Integrations → Discord.
2. Click "Connect Discord". OAuth flow runs; coach authorizes.
3. Choose a guild from the list of guilds the coach administers.
4. Click "Invite TGP bot to guild". Discord's bot-invite flow runs.
5. Coach grants required intents (GUILD_MESSAGES,
   GUILD_MESSAGE_REACTIONS, GUILDS, GUILD_MEMBERS).
6. Coach selects which channels to mirror (default: none; coach must
   explicitly opt each channel in).
7. (Optional) Coach asks their members to link their Discord accounts
   to TGP via Settings → Integrations → Discord → "Link my account".
8. The federation is live. Discord activity panel in the admin
   console populates within minutes.

Disconnect path: Settings → Integrations → Discord → Disconnect. The
bridge stops within 60s. Mirrored data follows the 30-day cleanup
path.

---

## 18. Notes on hosting

The Discord gateway connection is a long-lived websocket. It must run
in a process that can hold a connection for hours/days. Options:

- A dedicated worker container (recommended). Scales horizontally as
  guild count grows; sharded per Discord's recommendation at >= 1000
  guilds.
- The main API container (not recommended). Couples gateway lifetime
  to API redeploys, which would break federation on every release.

The recommended deployment for v1: a single worker dyno per region
(Fly.io aligns with the rest of the platform). At >= 1000 guilds, add
shards.

---

## 19. Compliance checklist

| Item | Status under v1 (read-only) | Notes |
| --- | --- | --- |
| Discord Developer ToS | Compliant | Bot API only; no scraping |
| Discord Privacy Policy | Compliant | Linked in connect flow |
| GDPR (EU) | Compliant | Cascade documented in section 9 |
| CCPA (California) | Compliant | Same cascade |
| Section 230 (US) | Applies | Read-only mirror; no platform-edit liability change |
| DSA (EU Digital Services Act) | Applies | Mirror is read-only; moderation done on TGP side per platform pipeline |
| CSAM detection | Required | Mirrored attachments routed through Cloudflare Images CSAM detection per `moderation-and-safety.md` |
| Data Processing Agreement | Required | TGP signs DPA with Discord developer program if usage > threshold |
