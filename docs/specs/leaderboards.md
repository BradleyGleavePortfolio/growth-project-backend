# Spec — Public/private leaderboards

**Roadmap row:** #31.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/31-leaderboards.md`](../architecture/handoff/31-leaderboards.md).
**Cross-references:** [`coach-challenges.md`](./coach-challenges.md)
(#30 — source of truth for submissions),
[`avatar-media.md`](./avatar-media.md) (#32 — display avatar on
entries), PR #121 spec
[`public-coach-profile.md`](./public-coach-profile.md) (#27 —
public-surface posture), PR #120 platform-readiness lanes 03
(RBAC) and 04 (data lifecycle).

---

## 1. Status

Net-new feature. The merged `CommunityWin` row
(`prisma/schema.prisma:711`) is a one-off testimonial primitive,
not a leaderboard projection. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #31."

## 2. WHY

A challenge (#30) without a leaderboard is a private journal.
The strategic value of leaderboards is twofold:

- **Within a coach's roster.** Visible standing creates
  accountability and a self-reinforcing engagement loop. The
  fitness coach who runs a 30-day step challenge needs the
  participants to see each other.
- **Across the platform.** A coach with a *public* leaderboard
  on their public profile (#27) signals proof — "these clients
  did this with me." This is a marketing surface, not just an
  engagement surface.

But a public surface adds responsibility:

- **Privacy.** A user's `email` must never become the
  user-visible handle. A separate `display_handle` is required.
- **Abuse.** Public surfaces invite vandalism (offensive
  handles), impersonation (lookalike handles), and bot
  participation (automated submissions). The spec defines
  takedown, freeze, and rate-limit primitives.
- **Performance.** A leaderboard read on every challenge tab
  view cannot recompute from raw submissions on demand. A
  snapshot projection is required.

## 3. WHEN

Trigger conditions:

1. Spec #30 (`coach-challenges.md`) is reviewed and the
   `CoachChallengeSubmission` schema is final. The leaderboard
   projection reads only from that table; if its shape moves,
   this spec moves with it.
2. Spec #32 (`avatar-media.md`) is reviewed so the leaderboard
   entry envelope can include an avatar URL with a stable
   contract (cache key, default fallback, scrub posture).
3. Spec #27 (`public-coach-profile.md`) is in `main` so the
   public-leaderboard widget has a host page.
4. Founder signs off on the abuse / moderation primitives in
   §11.

## 4. WHERE

- **New module:** `src/leaderboards/` —
  `leaderboards.module.ts`,
  `leaderboards.service.ts`,
  `leaderboards.controller.ts`,
  `snapshot.service.ts`,
  `moderation.service.ts`.
- **New tables:** `LeaderboardSnapshot`, `LeaderboardEntry`,
  `LeaderboardModerationAction`.
- **New routes (paths under `/api/`):**
  - `GET /challenges/:id/leaderboard` (auth-gated, scoped by
    challenge visibility)
  - `GET /coach/leaderboards/:challenge_id/full` (coach-only
    full view)
  - `POST /me/leaderboard/handle` (set / change display
    handle)
  - `POST /me/leaderboard/opt_out` (per-challenge opt-out)
  - OWNER moderation:
    - `POST /admin/leaderboards/:challenge_id/freeze`
    - `POST /admin/leaderboards/:challenge_id/snapshot/rebuild`
    - `POST /admin/leaderboards/entries/:id/takedown`
    - `POST /admin/leaderboards/handles/:user_id/block`
  - Public (no auth, only when challenge `visibility=public`):
    - `GET /public/coach/:slug/leaderboards/:challenge_id`
- **Reads (during snapshot rebuild):**
  `CoachChallenge`, `CoachChallengeMetric`,
  `CoachChallengeParticipation`, `CoachChallengeSubmission`,
  `User`, `UserAvatar` (#32).
- **Existing tables not touched:** none. Leaderboard family is
  fully additive.

## 5. WHO

- **Sign-off:** founder for the abuse/moderation primitives,
  the public visibility default (private until L2), and the
  display-handle policy; backend lead for the snapshot job
  contract and the takedown audit shape; product for the
  public widget UX.
- **On the hook:** backend platform.
- **Downstream consumers:** spec #27 (public coach profile
  embeds the public leaderboard widget), spec #30 (challenge
  read endpoint delegates leaderboard reads here), the
  OWNER admin console (moderation queue).

## 6. WHAT

**Already exists:**

- The merged `CommunityWin` row — *not* a leaderboard.
- The merged `audit` module and `AuditLog` row
  (`prisma/schema.prisma:857`) — used for moderation events.
- The merged `throttler` (PR #93) — used for the public read
  surface.
- Spec #27 — the host page for the public widget.

**New surface:**

- The leaderboard snapshot projection.
- The `display_handle` policy (validation, uniqueness scope,
  block list).
- The moderation surface (freeze, takedown, block).
- The public read endpoint with caching.

**Non-goals:**

- Real-time leaderboard streams. The spec is snapshot-based.
- Cross-challenge leaderboards (a "season" of multiple
  challenges) — parked for a later wave.
- Leaderboards over arbitrary metrics (weight, fasting hours,
  finance savings) outside a challenge — the projection is
  always scoped to a `CoachChallenge`.

## 7. HOW

Smallest first PR: the migration + the snapshot job (idempotent,
manual trigger only) + the coach-only full view endpoint. Public
read deferred to a later phase.

Rollout phases:

1. **Phase 1 — schema + manual rebuild.** Migration, snapshot
   table, manual rebuild via the OWNER admin route. No public
   read.
2. **Phase 2 — automatic rebuild.** A cron-driven (or
   submission-trigger) rebuild job. Coach-only read.
3. **Phase 3 — display handle.** `POST /me/leaderboard/handle`,
   uniqueness scope (per challenge), block list.
4. **Phase 4 — moderation.** OWNER freeze, takedown, block.
5. **Phase 5 — public surface.** `GET /public/coach/:slug/...`,
   challenge-`public` filter, caching.

Feature flag: `LEADERBOARDS_ENABLED` (`off` | `coach_only` |
`on`). Default `off` in every environment until Phase 5
completes.

## 8. Data model sketch

```prisma
enum LeaderboardSnapshotState {
  building
  ready
  failed
}

enum LeaderboardEntryState {
  visible
  hidden_by_user      // user opted out
  taken_down          // OWNER moderation
  scrubbed            // GDPR
}

model LeaderboardSnapshot {
  id                      String                       @id @default(uuid())
  challenge_id            String
  built_at                DateTime                     @default(now())
  state                   LeaderboardSnapshotState     @default(building)
  source_submission_count Int                          @default(0)
  build_duration_ms       Int?
  is_frozen               Boolean                      @default(false)
  frozen_reason           String?

  challenge               CoachChallenge               @relation(fields: [challenge_id], references: [id], onDelete: Cascade)
  entries                 LeaderboardEntry[]

  @@index([challenge_id, built_at])
  @@unique([challenge_id, built_at])
}

model LeaderboardEntry {
  id                  String                  @id @default(uuid())
  snapshot_id         String
  participation_id    String
  user_id             String
  display_handle      String
  avatar_storage_key  String?                  // copy of UserAvatar.derived_key, frozen at snapshot time
  rank                Int
  total_score         Float
  per_metric_scores   Json                     // [{metric_id, score, raw_value, normalized}]
  state               LeaderboardEntryState    @default(visible)
  taken_down_reason   String?

  snapshot            LeaderboardSnapshot      @relation(fields: [snapshot_id], references: [id], onDelete: Cascade)
  participation       CoachChallengeParticipation @relation(fields: [participation_id], references: [id])
  user                User                     @relation(fields: [user_id], references: [id])

  @@index([snapshot_id, rank])
  @@index([user_id])
}

model LeaderboardModerationAction {
  id              String     @id @default(uuid())
  actor_user_id   String
  target_kind     String     // 'snapshot' | 'entry' | 'handle'
  target_id       String
  action          String     // 'freeze' | 'unfreeze' | 'takedown' | 'restore' | 'block_handle' | 'unblock_handle'
  reason          String?    @db.Text
  created_at      DateTime   @default(now())

  @@index([target_kind, target_id, created_at])
}
```

The snapshot is **append-only** — a rebuild creates a new
snapshot row; old snapshots are retained for 90 days then
hard-deleted by a maintenance job. This keeps the leaderboard
**reproducible**: an operator can re-render any snapshot for an
audit / dispute.

## 9. API sketch

### Read

`GET /api/challenges/:id/leaderboard?snapshot=latest`

Response:
```json
{
  "snapshot": {
    "id": "...",
    "built_at": "2026-06-15T08:00:00Z",
    "is_frozen": false
  },
  "entries": [
    {
      "rank": 1,
      "display_handle": "alex_d",
      "avatar_url": "https://.../avatars/...",
      "total_score": 312540,
      "per_metric": [
        {"metric_id": "...", "label": "Steps", "score": 312540}
      ]
    }
  ],
  "you": { "rank": 14, "total_score": 184000 }
}
```

Visibility:
- `private` challenge → 404 unless caller is in
  `CoachChallengeParticipation` or is the coach.
- `invitation` challenge → 200 if caller has a participation
  *or* a valid invitation token; entries belonging to
  participants who have not joined are not listed.
- `public` challenge → 200 for any auth'd user; the public
  endpoint at `/api/public/...` is the unauthenticated mirror.

### Display handle

`POST /api/me/leaderboard/handle`

Request: `{"display_handle": "alex_d"}`

Validation:
- 3–30 chars, `[a-z0-9_-]+`
- not in the global block list
  (`LeaderboardModerationAction` with
  `target_kind='handle'` and `action='block_handle'`)
- unique within any challenge the user is currently
  participating in

The handle stored on `User` is the **default**; a per-challenge
override is allowed via `POST /api/challenges/:id/handle` (not
listed above for brevity; covered in §10 of the runtime PR).

### Snapshot rebuild

`POST /api/admin/leaderboards/:challenge_id/snapshot/rebuild`

Synchronous when `?wait=true`; otherwise returns 202 with a
job id. The job is idempotent on `(challenge_id, now()::date)`
to prevent thundering-herd from a misclick.

### Public

`GET /public/coach/:slug/leaderboards/:challenge_id`

- Requires the challenge to be `visibility=public` and not
  `taken_down`.
- Cached at the edge for 5 minutes.
- Returns the same envelope as the auth'd read, with `you`
  always omitted.
- Throttled at 60/min per IP via the existing throttler.

## 10. Rollout / feature flags

- **Env var:** `LEADERBOARDS_ENABLED` (`off` | `coach_only` |
  `on`). Default `off`.
- **Public visibility default.** Even with the flag `on`, public
  challenges remain hidden from `GET /public/...` until
  `LEADERBOARDS_PUBLIC_VISIBILITY=on`. Two flags so an
  incident on the public surface does not require disabling
  coach-side reads.
- **Tier gate.** Public visibility requires L2 or higher (#37).
- **Fan-out order.** Backend (snapshot) → BFF (coach console
  read) → mobile (read) → public web (#27 widget).

## 11. RBAC and privacy

- **Display handle.** `User.email` is **never** returned by any
  leaderboard endpoint.
- **Avatar.** Avatar URLs come from #32. The leaderboard freezes
  the *derived* key at snapshot time (so a later avatar change
  does not retroactively rewrite past leaderboards) but resolves
  to the *current* avatar at read time if the user has not been
  taken down.
- **Opt-out.** `POST /me/leaderboard/opt_out` sets
  `LeaderboardEntry.state='hidden_by_user'` for that user
  across all current and future snapshots of that challenge.
  The user's submissions remain in `CoachChallengeSubmission`
  (so the coach's roster-level adherence reads are unaffected).
- **Block list.** A blocked handle (impersonation, slur, etc.)
  is rejected on the next handle-change attempt; existing
  snapshots referencing the handle are *not* mutated, but the
  matching entry's `state` flips to `taken_down`.
- **GDPR.** A user-deletion event:
  - Sets `LeaderboardEntry.state='scrubbed'` for every entry
    referencing the user.
  - Replaces `display_handle` with `"deleted_user_<short_id>"`.
  - Does not delete the row (audit and dispute history).
- **Tenancy.** Every leaderboard row is scoped via
  `CoachChallenge.coach_user_id`; cross-coach reads are
  impossible.

## 12. Tests

- **Unit:**
  - Display-handle validator (length, charset, block list,
    per-challenge uniqueness).
  - Score-aggregation per metric (`sum`, `max`, `min`, `avg`,
    `streak_days`).
  - Snapshot determinism: two rebuilds of the same challenge
    on the same submissions produce byte-identical entries
    (modulo ids / timestamps).
- **Integration:**
  - Build a 200-participant snapshot in < 2 s on a real
    Postgres.
  - GDPR flow: user deletes account, snapshot rebuild scrubs
    handle, prior snapshots flip `state`.
  - Takedown: OWNER takes down a public challenge; the public
    endpoint returns 410.
- **Smoke:**
  - `GET /challenges/:id/leaderboard` returns 200 for a
    participant.
- **Manual eval:**
  - Founder reviews the public widget render against three
    real coaches' staging environments.

## 13. Risks

- **Display-handle squatting.** A user could grab "best_coach"
  to mock another coach. Mitigation: the handle block list is
  curated by OWNER admin; reserved-prefix list (`admin_`,
  `coach_`, `tgp_`) is enforced at validation.
- **Snapshot rebuild thundering herd.** A challenge with high
  submission rate could trigger frequent rebuilds. Mitigation:
  idempotency on `(challenge_id, now()::date)` plus a
  rate-limited rebuild job with a configurable interval (5
  minutes default).
- **Avatar leak via leaderboard.** A user opts out of the
  challenge but their avatar key was frozen in a prior
  snapshot. Mitigation: `state='hidden_by_user'` causes the
  read path to return a placeholder avatar URL instead of the
  frozen key.
- **Public-surface scraping.** Mitigation: 60/min/IP throttle,
  no email field returned, `Cache-Control: max-age=300`,
  optional `X-Robots-Tag: noindex` per challenge.

## 14. Dependencies

- **Roadmap rows.** #30 (submissions source), #32 (avatar
  resolver), #27 (public host), #37 (tier gate for public).
- **Existing modules.** `src/audit/` (moderation log),
  `src/common/throttling/`, `src/auth/`.
- **External services.** None new.

## 15. Acceptance criteria

1. Migration adds the three tables idempotently with all FKs
   concrete.
2. Coach-only leaderboard read returns the documented envelope.
3. Display-handle validation rejects every case in the
   block list and reserved-prefix list, in tests and
   end-to-end.
4. Snapshot determinism test passes.
5. GDPR scrub flow flips entry state and replaces handle.
6. OWNER takedown removes the challenge from the public
   endpoint within one snapshot rebuild cycle.
7. Public read is rate-limited at 60/min/IP and returns 410
   for taken-down challenges.
8. Handoff brief at
   [`../architecture/handoff/31-leaderboards.md`](../architecture/handoff/31-leaderboards.md)
   updated; roadmap row stage flips to "in flight."

## 16. Operator handoff

- **Runbook entry** in [`../deploy-runbook.md`](../deploy-runbook.md):
  how to rebuild a snapshot, how to freeze a leaderboard, how
  to block a handle, how to take down an entry.
- **Dashboard tiles:**
  - "Snapshot build duration" (p50, p95).
  - "Public leaderboard QPS" (per IP / per challenge).
  - "Takedown actions in last 30 days."
- **Alerts:**
  - Snapshot build duration > 30 s.
  - Public throttle 429 rate > 5%.
  - Any takedown event (one-shot to OWNER).
- **Kill switches:**
  - `LEADERBOARDS_ENABLED=off` — disables all routes.
  - `LEADERBOARDS_PUBLIC_VISIBILITY=off` — keeps coach-side
    reads alive while shutting down public surface.
