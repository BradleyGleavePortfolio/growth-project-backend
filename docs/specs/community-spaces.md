# Spec: Coach-Owned Community Spaces

> **Status:** Draft (engineer-facing). **Roadmap row:** #40
> (engagement & retention wave). **Owner:** backend lead.
> **Companion brief:** [`docs/architecture/handoff/40-community-spaces.md`](../architecture/handoff/40-community-spaces.md).
> **No runtime in this PR.** No schema change, no migration, no
> module wiring. The runtime PRs descend from this spec, one
> small slice at a time, each behind `COMMUNITY_SPACES_ENABLED`.

This is the engineer-facing specification for **Coach-Owned
Community Spaces** — the always-on member-only home a coach gets
on the platform. It is the asynchronous cousin of the live-call
spec ([`events-live-calls.md`](./events-live-calls.md)) and the
distribution surface that the replay/content library spec
([`replays-content-library.md`](./replays-content-library.md))
publishes into. Together those three specs make the platform a
"one-stop-shop" for a coach's audience, the way Whop is for a
creator's audience — but tied to the coaching relationship that
already exists in this app, not bolted onto a stranger's feed.

The 16-section template follows
[`docs/specs/README.md`](./README.md) (PR #121 / PR #123 shape).
Every section closes with a short list of decisions that must be
settled before the first runtime PR.

---

## 1. Status banner and cross-references

- **Stage:** discovery → spec.
- **Depends on (drafts):** PR #117 (AI Program Builder RFC; reuses
  Supabase Storage prefix + mime allow-list), PR #118 (Team Mode
  ADR; reserves `acted_by_member_user_id` forward-compat hook),
  PR #119 (expansion roadmap row shape), PR #120 (platform
  readiness lanes #01 flags / #03 RBAC / #04 data lifecycle / #06
  observability / #08 AI governance / #10 analytics), PR #121
  (specs #21 outcome check-ins, #22 at-risk, #23 weekly recap),
  PR #122 (mastermind cohort spaces — Phase 4 cohort surface
  reuses this primitive), PR #123 (#33 content-boards, #36
  messaging+progress).
- **Reuses (merged):** `User`, `CoachProfile`, `CoachSubscription`,
  `CoachMessage` (`src/messaging/`), `CommunityWin`,
  `ClientCoachConsent`, `AuditLog`, `ActivityEvent`, the
  Supabase-Realtime ping pattern, the OpenAPI publication
  convention, the entitlements read model
  (`docs/entitlements.md`), and the typed `ClientAIContext`
  (`src/ai/`) that the at-risk and weekly-recap specs already
  build on.
- **Out of scope:** coach-to-coach communities (parking lot row
  #06 in PR #119); public discovery feeds across coaches (out of
  scope for the platform — this is **not** a marketplace);
  custom-domain DNS provisioning for branded community URLs
  (covered separately under tiering, PR #123 row #37).

---

## 2. WHY — problem in user/business terms

**Coach problem.** Coaches today bounce their audience between
five tools: Discord/Slack for chat, Skool/Circle for the feed,
Zoom for live calls, Teachable/Thinkific for content, and a
mailing list for retention. The product they actually charge for
(coaching) lives in this app, but the audience that pays for it
lives elsewhere. Every renewal becomes a fresh acquisition
because the relationship is fragmented across platforms the
coach does not control.

**Client problem.** The client signs up for a coach, downloads
this app, gets a tracker — and then is told to also join a
Discord, also bookmark a Notion page, also click a Calendly link
for the live call. Most never make it past the first hop.
Engagement is the silent killer of retention, and engagement is
exactly what fragmentation kills.

**Business problem.** This app already has the coach ↔ client
relationship, the per-coach roster, the entitlement gate, the
billing hook, the GDPR posture, and the audit log. Re-rendering
those facts as a member-only home for the coach's audience is
the single highest-leverage retention move the platform can make.

The spec frames the surface as **Coach-Owned**, not "a community
feature", because the unit of access is the coach's subscription
seat (already enforced by `SubscriptionGuard`), not a stand-alone
community SKU. A community that lapses when the coach lapses is
a strictly safer business posture than a community that keeps
running on goodwill — every pre-existing tenancy, billing, and
audit rule is preserved.

**Why now.** PR #117 adds the asset-ingest path the community
posts piggyback on. PR #118 reserves the `acted_by_member` hook
so a future "head coach posts as the brand" works without a
schema break. PR #121 adds the at-risk detector and weekly
recap, both of which feed into a "is this client engaged enough
to be retained" signal that needs a place to land. The community
surface is the place that signal lands.

---

## 3. WHEN — gating conditions for the first runtime PR

The first runtime PR (PR-1: schema + read-only `GET` of an empty
space; flag default off) cannot start until **all** of the
following are true. Each is a one-line check, not a process gate.

1. **Flag system unified.** PR #120 lane #01 has accepted the
   single `can(actor, action, target)` resolver shape. The
   community surface depends on a single decision point for
   "this coach is on a tier that includes communities" + "this
   client is currently entitled to read this coach's space".
2. **Storage prefix reserved.** PR #117 §8 has confirmed the
   Supabase Storage prefix scheme. The community surface
   reserves `coach/{coach_id}/community/post/{post_id}/...` and
   `coach/{coach_id}/community/comment/{comment_id}/...` under
   the same prefix tree.
3. **Tenancy axis confirmed.** PR #118 has accepted the
   `acted_by_member_user_id` forward-compat hook. Posts and
   comments include the column from day one (nullable).
4. **Per-coach budget shape confirmed.** PR #120 lane #05 has
   accepted the per-coach monthly budget pattern. Communities
   reuse it for moderation-AI calls (toxicity classifier),
   nothing free-tier.
5. **GDPR scrub coverage.** PR #120 lane #04 has accepted the
   per-table retention matrix. Community-post / community-
   comment / community-reaction rows are listed with a
   "scrub-on-account-deletion" rule; orphan posts (author
   deleted) are tombstoned, not hard-deleted, and rendered as
   "(deleted member)".
6. **Moderation off by default.** Until per-coach moderator role
   is added (PR #118 wave), only the coach themselves can
   moderate. The first PR ships with "post" and "comment"
   actions gated to `coach.id == post.coach_id`.
7. **Entitlement bundle decision.** PR #120 lane #05 has
   recorded which tier(s) include communities. The first PR
   ships with the surface gated to the highest currently-shipping
   tier and a feature flag; clients on lower tiers read a
   `feature_locked` envelope, not a 403.

---

## 4. WHERE — modules, tables, routes touched

### 4.1 New module

`src/community/` (peer to `src/messaging/`).

| File | Owns |
|---|---|
| `community.module.ts` | Wires controller + services. Imported by `app.module.ts` only behind `COMMUNITY_SPACES_ENABLED`. |
| `community.controller.ts` | `GET /api/community/coach/:coach_id`, `GET /api/community/posts/:id`, `POST /api/community/posts`, `POST /api/community/posts/:id/comments`, `POST /api/community/posts/:id/reactions`, `DELETE /api/community/posts/:id` (coach + OWNER), `POST /api/community/reports` (member abuse-report intake). |
| `community.service.ts` | All Prisma reads/writes. The `SubscriptionGuard` and `ClientCoachConsent` checks are applied here, not in the controller, so OWNER-only admin reads can bypass cleanly. |
| `community-feed.service.ts` | The "what does this client see right now" composer. Pure function over `(coach_id, viewer_user_id, cursor)`, no I/O beyond Prisma. Returns a typed envelope identical between mobile and console. |
| `community-moderation.service.ts` | Toxicity classifier wrapper, abuse-report ingest, soft-hide / unhide, tombstone-on-delete, audit-log emit. |
| `community-realtime.service.ts` | Supabase Realtime ping. Reuses the pattern from `src/messaging/`. |
| `dto/*.ts` | Request/response DTOs. Each maps to a Swagger model so the OpenAPI export (`feat: openapi-spec`, PR #94) renders the surface. |
| `README.md` | Module-level orientation in the same shape as `src/messaging/README.md`. |

### 4.2 New tables (additive, not migrated in this PR)

See §8 for the data-model sketch. The new tables are
`CommunitySpace`, `CommunityPost`, `CommunityComment`,
`CommunityReaction`, `CommunityReport`, `CommunityRole`. Every
new row carries `coach_id` (the tenancy axis) and a nullable
`acted_by_member_user_id` (PR #118 forward-compat).

### 4.3 New env vars (described, not added)

- `COMMUNITY_SPACES_ENABLED` — global kill-switch. Default off.
- `COMMUNITY_MODERATION_AI_ENABLED` — gate the toxicity
  classifier. Default off.
- `COMMUNITY_MAX_POST_BYTES`, `COMMUNITY_MAX_COMMENT_BYTES` —
  request validation; defaults documented in §9.
- `COMMUNITY_PER_COACH_DAILY_POST_CAP`, `COMMUNITY_PER_USER_DAILY_COMMENT_CAP`
  — rate limiter floors above the platform throttler.

### 4.4 Mobile + console contract

Mobile reads `GET /api/community/coach/:coach_id` and writes
posts/comments/reactions. Coach console reads the same surface
(no separate BFF, the OWNER-bypass posture from
`docs/admin-reports.md` is reused). No mobile-app schema break:
the surface is additive and render-only when the flag is off.

### 4.5 Files explicitly NOT touched

- `prisma/schema.prisma` — no edit in this PR.
- `prisma/migrations/` — no migration in this PR.
- `src/common/env-validation.ts` — env vars are *named* here,
  not registered.
- `app.module.ts` — no module wiring in this PR.
- `new-website` — out of scope. The public coach profile (PR
  #121 row #27) is rendered by **this** backend, not by the
  marketing site; community surfaces are member-only and never
  exposed to the marketing site.

---

## 5. WHO — sign-off, on-the-hook, downstream, hard boundaries

| Role | Person / artefact | What they decide |
|---|---|---|
| Founder | Bradley | Whether communities are bundled into the existing tier or carved into an add-on; final naming ("space" vs "community" vs "circle"); whether public **read** previews exist or every post is members-only. |
| Backend lead | (TBD) | Schema sign-off; whether the toxicity classifier is provider-pluggable from day one; whether feed composition is precomputed (write-fan-out) or recomputed on read (read-fan-in). Spec defaults to read-fan-in; runtime PR may revisit. |
| Mobile | (TBD) | Whether posts render as a feed or as threads; whether reactions are emoji-rich or thumbs-up only (spec defaults to thumbs-up + one heart, expandable later). |
| Coach console | (TBD) | Whether the coach console gets a parallel "manage community" surface or whether all moderation flows happen in mobile (spec defaults to console for moderation, mobile for posting). |
| Pager | OWNER | First 30 days post-rollout. Toxicity classifier failure must not fail the post; the classifier is best-effort. |
| Hard boundaries | — | (a) Communities never expose member email/full name unless the member opts into a public display. (b) The surface is **not** a marketplace — no cross-coach discovery, no follow-coach button, no public leaderboard across coaches. (c) `new-website` repo stays untouched. (d) No third-party embed on the post (no Twitter/IG/YouTube oEmbed in v1; spec links only). (e) No DM-on-post on the community surface — DMs flow through `src/messaging/`. |

---

## 6. WHAT — already exists, net-new, non-goals

### Already exists (reused)

- Supabase JWKS auth, `SubscriptionGuard`, `ClientCoachConsent`
  (`src/auth/`, `src/billing/`, `prisma/schema.prisma`).
- Coach ↔ client messaging (`src/messaging/`), with Supabase
  Realtime ping pattern.
- `CommunityWin` model (a per-client win surface; the new
  `CommunityPost` is a strict superset of the same idea but
  member-visible across the coach's roster).
- AuditLog write (`src/audit/`).
- Supabase Storage upload prefix (PR #117 §8).
- The typed `ClientAIContext` and the GP guardrails (`src/ai/`) —
  the AI Business Copilot spec
  ([`ai-business-copilot.md`](./ai-business-copilot.md)) drafts
  community posts using the same context bundle.

### Net-new

- `CommunitySpace` row (one per coach; lazily created on first
  post or first explicit "open my community").
- `CommunityPost`, `CommunityComment`, `CommunityReaction`.
- `CommunityReport` (abuse intake; OWNER + coach inboxes).
- `CommunityRole` (placeholder, off by default; PR #118 Team
  Mode wires it).
- The community-feed composer + the moderation service.

### Non-goals (deliberate)

- Cross-coach discovery / public marketplace.
- Voice/video rooms (covered by
  [`events-live-calls.md`](./events-live-calls.md)).
- Threaded multi-level comments (one level only in v1).
- Polls, events embedded in the feed, live-typing indicators.
- Rich-text editor with media upload inline (v1 = plaintext +
  one optional media attachment per post).
- Notifications fan-out to email / push for community posts in
  v1 — that lands in a separate PR after the messaging
  notification refactor (PR #119 parking-lot row #07).

---

## 7. HOW — rollout plan + smallest first PR + feature flag

### 7.1 Rollout phases

| Phase | What lands | Flag state |
|---|---|---|
| PR-1 | Schema (additive); empty `GET /api/community/coach/:id` returns `{ space: null }`; module wired but unreachable. | `COMMUNITY_SPACES_ENABLED=false` everywhere. |
| PR-2 | Coach can create a `CommunitySpace` row; coach can post text-only `CommunityPost`; reads visible only to the authoring coach. | Flag on for staging; off for prod. |
| PR-3 | Roster (the coach's clients) can read the space; clients can comment and react. | Flag on for one beta coach in prod. |
| PR-4 | One optional media attachment per post (Supabase Storage prefix from PR #117 §8). Mime allow-list reused. | Flag on for ≤5 beta coaches. |
| PR-5 | Toxicity classifier wired (best-effort, pluggable; deterministic fallback returns "no-op"); abuse-report intake; soft-hide; tombstone-on-delete. | Flag on for ≤5 beta coaches. |
| PR-6 | Console moderation surface (delete post, hide post, ban member from this coach's space — not a global ban). Audit-log every action. | Flag on for the entire fitness-only tier. |
| PR-7 | Read-receipt-style "has this client visited the space in the last 7 days" → feeds the at-risk detector (PR #121 spec #22). | Flag on for the entire tier. |
| PR-8 | Removed: kill-switch dry run + entitlement gate cleanup. | GA. |

Each PR is independently revertable. A revert at any phase is a
flag flip; tables stay (no destructive migration ever runs in
the rollback path).

### 7.2 Smallest first PR

**PR-1** ships:

- The Prisma schema additions in §8 (additive only).
- `community.module.ts` registered behind the flag, returning
  `{ space: null, posts: [] }` when the flag is off.
- One smoke assertion: `GET /api/community/coach/:coach_id`
  returns 200 + the empty envelope when the flag is off.
- An OpenAPI export update (no surface change to existing
  routes).

PR-1 contains no UI work, no provider code, no realtime, no
storage, no moderation. It is the seam.

### 7.3 Feature flags

- `COMMUNITY_SPACES_ENABLED` is the only required flag for PR-1.
  It gates the controller + the migration application order
  (the schema migration ships in PR-1, but the read returns the
  empty envelope until the flag flips).
- `COMMUNITY_MODERATION_AI_ENABLED` lands in PR-5.
- All other flags listed in §4.3 land alongside the PR that
  needs them, never earlier.

---

## 8. Data model sketch (additive Prisma; **not** migrated here)

Every new table follows the existing schema conventions: snake_case
columns; `id String @id @default(uuid())`; per-row `coach_id`
tenancy; nullable `acted_by_member_user_id` for PR #118 forward
compat; `created_at`/`updated_at` audit columns; explicit
indexes; no implicit cascades that cross the tenancy axis.

```prisma
model CommunitySpace {
  id           String   @id @default(uuid())
  coach_id     String   @unique
  coach        User     @relation("CommunitySpaceCoach", fields: [coach_id], references: [id])
  display_name String?            // "Bradley's Inner Circle" — defaults to CoachProfile.display_name
  description  String?            // member-facing; ≤ 1KB
  banner_url   String?            // Supabase Storage path
  visibility   String   @default("members_only") // "members_only" | "public_preview"
  is_archived  Boolean  @default(false)
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt

  posts        CommunityPost[]

  @@index([coach_id])
}

model CommunityPost {
  id                       String   @id @default(uuid())
  coach_id                 String
  coach                    User     @relation("CommunityPostCoach", fields: [coach_id], references: [id])
  space_id                 String
  space                    CommunitySpace @relation(fields: [space_id], references: [id], onDelete: Cascade)
  author_user_id           String
  author                   User     @relation("CommunityPostAuthor", fields: [author_user_id], references: [id])
  acted_by_member_user_id  String?  // PR #118 forward-compat for staff-posted-as-coach
  body                     String              // plaintext, ≤ COMMUNITY_MAX_POST_BYTES
  media_url                String?             // optional single attachment
  media_kind               String?             // "image" | "video" | "audio" | "pdf"
  visibility               String   @default("space")  // "space" | "tombstoned" | "hidden"
  toxicity_score           Float?              // 0..1; nullable while classifier off
  pinned                   Boolean  @default(false)
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  comments                 CommunityComment[]
  reactions                CommunityReaction[]

  @@index([space_id, created_at])
  @@index([coach_id, author_user_id, created_at])
}

model CommunityComment {
  id                       String   @id @default(uuid())
  post_id                  String
  post                     CommunityPost @relation(fields: [post_id], references: [id], onDelete: Cascade)
  coach_id                 String
  coach                    User     @relation("CommunityCommentCoach", fields: [coach_id], references: [id])
  author_user_id           String
  author                   User     @relation("CommunityCommentAuthor", fields: [author_user_id], references: [id])
  acted_by_member_user_id  String?
  body                     String              // ≤ COMMUNITY_MAX_COMMENT_BYTES
  visibility               String   @default("post") // "post" | "tombstoned" | "hidden"
  toxicity_score           Float?
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  @@index([post_id, created_at])
  @@index([coach_id, author_user_id, created_at])
}

model CommunityReaction {
  id              String   @id @default(uuid())
  post_id         String
  post            CommunityPost @relation(fields: [post_id], references: [id], onDelete: Cascade)
  user_id         String
  user            User     @relation("CommunityReactionUser", fields: [user_id], references: [id])
  kind            String              // "thumbs_up" | "heart"; closed vocabulary
  created_at      DateTime @default(now())

  @@unique([post_id, user_id, kind])
  @@index([post_id])
}

model CommunityReport {
  id                   String   @id @default(uuid())
  coach_id             String
  coach                User     @relation("CommunityReportCoach", fields: [coach_id], references: [id])
  reporter_user_id     String
  reporter             User     @relation("CommunityReportReporter", fields: [reporter_user_id], references: [id])
  target_kind          String              // "post" | "comment"
  target_id            String              // the offending row id
  reason               String              // closed vocab; "spam" | "harassment" | "self_harm" | "ip" | "other"
  detail               String?             // optional ≤ 2KB
  status               String   @default("open") // "open" | "actioned" | "dismissed"
  resolved_by_user_id  String?
  resolved_at          DateTime?
  created_at           DateTime @default(now())

  @@index([coach_id, status, created_at])
}

model CommunityRole {
  id              String   @id @default(uuid())
  coach_id        String
  member_user_id  String
  role            String   // "member" (default) | "moderator" | "banned"
  set_by_user_id  String
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@unique([coach_id, member_user_id])
  @@index([coach_id, role])
}
```

### 8.1 Schema notes

- `CommunitySpace.coach_id` is unique — exactly one space per
  coach. Multiple spaces (e.g. one for L2, one for L3) is not in
  v1; the tiering spec ([`tiering-l2-l3`](./tiering-l2-l3.md),
  PR #123) layers visibility filters on top of the single
  space.
- `CommunityPost.author_user_id` is the literal poster.
  `acted_by_member_user_id` is reserved for PR #118 Team Mode.
  When Team Mode lands, a staff member posting on the coach's
  behalf sets `author_user_id = coach.id` (the brand) and
  `acted_by_member_user_id = staff.id` (the actor).
- `CommunityComment` deliberately has no `parent_comment_id`.
  v1 is one level of comments; threading lands in a later PR
  with a non-destructive add of the column + a derived
  `thread_root_id` index.
- `CommunityReaction.kind` is a closed vocabulary string column,
  not an enum, so adding a new emoji ships as a one-line
  service-side allow-list change with zero migration.
- `CommunityRole` is the moderator/ban layer. v1 only writes
  `"banned"` rows. PR #118 wires `"moderator"`.
- Soft-delete via `visibility` columns. No `deleted_at`. A
  hard-delete is GDPR-only and runs through the existing scrub
  job (PR #120 lane #04).

---

## 9. API sketch (routes + envelope + throttling)

All routes are under `/api/community/*`. Every request runs
through the existing `JwksAuthGuard` and (where applicable) the
`SubscriptionGuard`. OWNER bypasses the subscription gate per
the existing convention in `src/billing/`.

### 9.1 Read

```
GET /api/community/coach/:coach_id
  → 200 { space: CommunitySpace | null,
          posts: CommunityPostEnvelope[],
          next_cursor: string | null }
  → 403 { error: "not_member" }
  → 404 { error: "coach_not_found" }
  → 423 { error: "feature_locked", reason: "tier_below_communities" }
```

The viewer must satisfy one of: `viewer.role === 'owner'`,
`viewer.id === coach.id`, `viewer.coach_id === coach.id`. The
"feature_locked" envelope is returned when the coach's tier
does not include communities (the client app renders an upsell
sheet instead of a 403; UI parity with the existing entitlements
gate posture).

```
GET /api/community/posts/:id
  → 200 { post: CommunityPostEnvelope, comments: CommunityCommentEnvelope[] }
  → 403 / 404 same as above
```

### 9.2 Write

```
POST /api/community/posts
  body: { body: string, media_url?: string, media_kind?: string }
  → 201 { post: CommunityPostEnvelope }
  → 422 { error: "validation_failed", fields: { body: "max_length_exceeded" } }
  → 429 { error: "rate_limited", retry_after_seconds: number }
```

Throttle: `POST /api/community/posts` is `5/hour/coach` for the
posting coach; `1/hour/member` for non-coach members; per-coach
daily cap from `COMMUNITY_PER_COACH_DAILY_POST_CAP` (default
40). Throttle keys piggyback on the existing Redis-backed
throttler (PR #93).

```
POST /api/community/posts/:id/comments
  body: { body: string }
  → 201 { comment: CommunityCommentEnvelope }
  → 429 { error: "rate_limited" }
```

Throttle: `30/hour/user`, daily cap from
`COMMUNITY_PER_USER_DAILY_COMMENT_CAP` (default 200).

```
POST /api/community/posts/:id/reactions
  body: { kind: "thumbs_up" | "heart" }
  → 201 { reaction: { ... } }       // first time
  → 200 { reaction: { ... } }       // idempotent re-react
```

Reactions are idempotent on the unique `(post_id, user_id,
kind)`.

```
DELETE /api/community/posts/:id
  → 204 No Content
```

Allowed only for `viewer.id === post.author_user_id` or
`viewer.id === coach.id` or `viewer.role === 'owner'`. A
`DELETE` sets `visibility = 'tombstoned'` and emits an audit-log
entry; it does **not** remove the row (GDPR scrub does, on
account deletion only).

### 9.3 Moderation + reports

```
POST /api/community/reports
  body: { target_kind: "post"|"comment", target_id: string,
          reason: "spam"|"harassment"|"self_harm"|"ip"|"other",
          detail?: string }
  → 201 { report: { id, status: "open" } }
  → 429 { error: "rate_limited" }
```

Throttle: `5/hour/user` (anti-grief). The OWNER inbox is
`/api/admin/reports/community/*`; the coach inbox is
`/api/community/reports?coach_id=:id` (coach-scoped read; the
existing `OWNER bypasses` posture applies).

### 9.4 Envelope

```ts
type CommunityPostEnvelope = {
  id: string;
  coach_id: string;
  author: { user_id: string; display_name: string; avatar_url: string | null };
  body: string;
  media: { url: string; kind: "image"|"video"|"audio"|"pdf" } | null;
  reactions: { thumbs_up: number; heart: number; me: { thumbs_up: boolean; heart: boolean } };
  comment_count: number;
  pinned: boolean;
  visibility: "space"|"tombstoned"|"hidden";
  created_at: string;
  updated_at: string;
};
```

The envelope deliberately does not leak the author's email or
phone number. `display_name` is the only identity surface
exposed, mirroring the public coach profile spec (PR #121
spec #27).

---

## 10. Media / replay storage

This spec defers all video/audio replay storage to the
[`replays-content-library.md`](./replays-content-library.md)
spec. Communities only carry **lightweight** media: a single
optional attachment per post, ≤ 50 MB, mime-allow-listed (image,
audio, video, pdf), stored under
`coach/{coach_id}/community/post/{post_id}/...` (Supabase
Storage prefix from PR #117 §8). For longer-form video, the
post links to a content-library entry whose URL is rendered
inline by the mobile client. This keeps the Storage cost model
predictable: communities are messaging-shaped, replays are
broadcast-shaped.

---

## 11. Moderation, member-only access, abuse posture

Member-only access is enforced in the service layer, not the
controller, so OWNER admin reads bypass cleanly. The exact
predicate for "this user can read this coach's space" is a
single function:

```ts
canReadSpace(viewer: User, coach: User): boolean {
  if (viewer.role === 'owner') return true;
  if (viewer.id === coach.id) return true;
  if (viewer.coach_id === coach.id) {
    // also requires entitlement bundle to include communities
    // — see PR #120 lane #05; resolves through can(...).
    return true;
  }
  return false;
}
```

Toxicity classification is **best-effort**. The classifier runs
asynchronously after the post is written (BullMQ on the existing
`REDIS_URL`, mirroring PR #117 §6 jobs). A non-zero
`toxicity_score` does **not** auto-hide; only the coach (or
OWNER) hides via the moderation surface. The classifier is
provider-pluggable from day one with a deterministic fallback
that returns `null` when the provider is unset; this preserves
the same posture as `src/ai/` and is required for the
deterministic-fallback rule in PR #120 lane #08.

Abuse reports flow into `CommunityReport`. The OWNER inbox is
listed in `docs/admin-reports.md` (the runtime PR adds a row to
that table, not this spec). Reports are **not** federated
across coaches — a member reporting a coach's post does not
escalate to the platform unless the OWNER has the report in
their inbox already.

Tombstoning preserves the row so the comment thread renders as
"(deleted)" without breaking the context for the remaining
replies. Hard-delete only on GDPR scrub (account deletion or
explicit erasure request).

---

## 12. Member-only access + RBAC + privacy

| Concern | Posture |
|---|---|
| Authentication | Reuses `JwksAuthGuard`. Anonymous access never reaches the controller. |
| Tenancy axis | `coach_id` on every row. Service-layer predicate (§11). No raw SQL bypass. |
| Entitlement gate | Per-coach via `SubscriptionGuard` (the coach's seat must be `active`/`trialing` for the space to read/write). Per-member via the entitlement bundle: a member whose tier does not include communities reads `feature_locked`, never a 403. |
| GDPR | `CommunityPost`, `CommunityComment`, `CommunityReaction` all listed in the per-table retention matrix (PR #120 lane #04). Account-deletion scrub tombstones the post and hard-deletes the row 30 days later, mirroring the existing 30-day grace window for finance data. Export includes the user's own posts, not the surrounding thread. |
| PII | The envelope exposes `display_name` only. No email, no phone, no full-name. |
| Audit-log | Every `POST /community/posts`, `DELETE /community/posts/:id`, and any moderation action writes one row through `AuditService.write` with the existing `AuditAction` constants (a small, additive add). |
| Cross-coach | A member is enrolled with at most one coach (`User.coach_id`); the surface always reads exactly one coach's space, never federated. |

---

## 13. AI governance (toxicity classifier + AI-drafted posts)

Two AI surfaces touch communities:

1. **Toxicity classifier** (this spec). Provider-pluggable.
   Deterministic fallback returns `null`. Per-coach monthly
   budget cap (PR #120 lane #05). Best-effort, never fails the
   write, never auto-hides.
2. **AI-drafted post composer** (the AI Business Copilot spec
   ([`ai-business-copilot.md`](./ai-business-copilot.md))). The
   coach asks the copilot to draft a post; the copilot returns a
   `body` field; the coach reviews and posts manually. The
   community surface never accepts an AI-generated post without
   a human in the loop.

For the prompt-versioning rule, the toxicity classifier's
threshold and the AI-drafted-post system prompt both live in
`BuilderPromptTemplate` (PR #117 §3). New thresholds /
prompts ship as a new template version; the old version stays
queryable for evals. Eval baselines are recorded under the
existing `docs/specs/at-risk-detector.md`-style eval CI (PR
#121 spec #22) — communities-specific evals are added in PR-5,
not earlier.

---

## 14. Feature flags + entitlements

| Flag | Default | What it gates |
|---|---|---|
| `COMMUNITY_SPACES_ENABLED` | off | Whole module; PR-1 ships gated. |
| `COMMUNITY_MODERATION_AI_ENABLED` | off | Toxicity classifier; PR-5. |
| `COMMUNITY_PUBLIC_PREVIEW_ENABLED` | off | (Optional) renders the post **title** to non-members for SEO. v1 ships off; founder decision to keep public previews entirely off. |
| Entitlement bundle | tier-gated | Communities are bundled with the highest-tier subscription on day one (PR #120 lane #05). Lower tiers see `feature_locked`. |

Kill-switch: set `COMMUNITY_SPACES_ENABLED=false` in Fly secrets;
the surface returns the empty envelope on the next request.
No data loss; no migration to revert.

---

## 15. Analytics + telemetry

PostHog events (added to `src/analytics/events.ts`; one row per
event):

| Event | Properties |
|---|---|
| `community_post_created` | `coach_id`, `author_role` ("coach" or "member"), `media_kind` |
| `community_post_viewed` | `coach_id`, `viewer_role`, `viewer_in_session_count` |
| `community_comment_created` | `coach_id`, `post_id`, `author_role` |
| `community_reaction_created` | `coach_id`, `post_id`, `kind` |
| `community_report_created` | `coach_id`, `target_kind`, `reason` |
| `community_moderation_action` | `coach_id`, `action` ("hide"/"unhide"/"ban"/"delete"), `actor_role` |

OWNER metrics counter (`/api/admin/metrics`) gains:

- `community_active_spaces_30d` — distinct `coach_id` with a
  post in the last 30 days.
- `community_dau_per_coach_p50_p90` — distinct `viewer_user_id`
  per `coach_id` per day.
- `community_open_reports` — `CommunityReport.status='open'`.

The at-risk detector (PR #121 spec #22) reads
`community_post_viewed` (last viewed timestamp per member) as a
positive engagement signal; the weekly recap (PR #121 spec #23)
reads `community_post_created` and `community_comment_created`
to surface "what your coach posted this week".

---

## 16. Tests, risks, dependencies, acceptance, operator handoff

### 16.1 Tests

| Layer | Coverage |
|---|---|
| Unit | `community-feed.service.ts` is a pure function; one suite covers the full predicate matrix in §11. `community-moderation.service.ts` toxicity-fallback path and the tombstone path are unit-tested. |
| Integration | One Jest e2e per route in §9: 200, 401 (no token), 403 (not member), 404 (no coach), 422 (validation), 429 (rate limit), 423 (`feature_locked`). Reuses the existing `test/setup-supertest.ts` shape. |
| Smoke | `scripts/smoke.ts` adds **boot-shape only**: the route is mounted, returns 200 + `{ space: null, posts: [] }` when the flag is off. No real coach context is exercised — the manual sweep handles end-to-end (`docs/e2e-qa-runbook.md`). |
| Eval | PR-5 adds a 200-fixture corpus for the toxicity classifier, with the deterministic fallback baseline locked in. The eval runner is shared with the AI Program Builder eval CI (PR #117 §13). |
| Load | PR-3 adds one synthetic test: 100 members fanning into one coach's space, posting + reacting + reading concurrently; latency budget per PR #120 lane #06 (p95 < 300 ms for `GET`). |

### 16.2 Risks

- **Engagement death spiral.** A coach posts twice, no one
  comments, the coach stops posting. Mitigation: the AI
  Business Copilot spec drafts post ideas + the at-risk detector
  surfaces "your community is dormant"; both ship before
  community goes GA.
- **Moderation overload.** A coach with 1,000 members and no
  moderator is a moderation bottleneck. Mitigation: PR-6 ships
  the per-coach moderator role; PR #118 Team Mode wires it
  fully.
- **Toxicity false-positives.** Classifier flags a coach's
  legitimate post. Mitigation: classifier never auto-hides; the
  coach decides.
- **GDPR thread coherence.** A scrubbed member's deleted post
  breaks the comment thread. Mitigation: tombstone-only render
  ("(deleted member)"), no hard-delete of the row except 30 days
  after account deletion.
- **Storage cost runaway.** Communities accept media; a power
  user fills the bucket. Mitigation: 50 MB cap per attachment,
  per-coach daily post cap, per-coach monthly Supabase Storage
  quota (PR #120 lane #06 dashboards monitor; alert at 80%).
- **Cross-coach data leak.** A naive query returns posts across
  coaches. Mitigation: §11 predicate is service-layer; integration
  test asserts a foreign-coach token cannot read a different
  coach's space.

### 16.3 Dependencies

- Internal: PR #117 (storage prefix, mime allow-list, eval CI),
  PR #118 (`acted_by_member_user_id` forward-compat), PR #120
  (lanes #01, #03, #04, #05, #06, #08, #10), PR #121 (specs
  #22, #23 read community signals), PR #123 (#33 content
  boards uses the same Storage prefix).
- External: Supabase Storage (already in use), Supabase Realtime
  (already in use, same pattern as `src/messaging/`), Redis
  (already in use for throttler + future BullMQ), the toxicity
  classifier provider (Anthropic or OpenAI; pluggable; default
  off).

### 16.4 Acceptance criteria

- A coach on the highest tier can create a post, attach an
  image, see it render in their own space, see their roster
  comment + react, and see the OWNER moderation surface flag a
  reported post in under 60 seconds end-to-end.
- A client whose tier does not include communities sees a
  `feature_locked` envelope, not a 403.
- A client whose coach's subscription is `past_due` sees the
  space in read-only mode (consistent with the existing
  `SubscriptionGuard` posture for coaches).
- The OWNER metrics counter exposes `community_active_spaces_30d`
  + `community_dau_per_coach_p50_p90` + `community_open_reports`.
- `scripts/smoke.ts` returns boot-shape 200 with the flag off.
- A revert is a single Fly secret flip; no migration runs in the
  rollback path.

### 16.5 Operator handoff

- **Runbook entry:** `docs/deploy-runbook.md` gains a one-line
  pointer to `docs/operations/community-spaces.md` (a future
  doc, not in this PR), in the same shape as the existing
  Stripe + audit pointers.
- **Dashboard tiles:** PR #120 lane #06 dashboard receives three
  tiles (DAU per coach, open reports, storage usage per coach).
- **Kill-switch:** `fly secrets set COMMUNITY_SPACES_ENABLED=false
  -a tgp-backend-prod`.
- **First 30 days:** OWNER reads `community_open_reports` daily;
  any report aged > 24 h is the on-call signal.

---

## Decisions that must close before PR-1

1. Is the surface bundled into the existing tier or carved into
   a paid add-on? (Founder; PR #120 lane #05.)
2. Public-preview on or off? Spec defaults to off. (Founder.)
3. Single space per coach or one per tier (L1 / L2 / L3)? Spec
   defaults to single space; tiering layers visibility on top.
   (Founder + tiering spec, PR #123 #37.)
4. Is the toxicity classifier required-by-default or
   opt-in-by-coach? Spec defaults to off until PR-5. (Backend
   lead.)
5. Reactions vocabulary: `thumbs_up + heart` (spec default) or
   richer? (Mobile.)
6. Notification fan-out (push/email) for community posts: in v1
   or after the messaging notification refactor? Spec defers to
   after. (Mobile + backend lead.)

Once these six decisions close, PR-1 is unblocked. Until then,
this spec is the single source of truth and is edited in place
as decisions land.
