# Spec: Events and Live Calls

> **Status:** Draft (engineer-facing). **Roadmap row:** #41
> (engagement & retention wave). **Owner:** backend lead.
> **Companion brief:** [`docs/architecture/handoff/41-events-live-calls.md`](../architecture/handoff/41-events-live-calls.md).
> **No runtime in this PR.** No schema change, no migration, no
> module wiring. Runtime PRs descend from this spec, one slice
> at a time, behind `LIVE_CALLS_ENABLED`.

This is the engineer-facing specification for **Events and Live
Calls** — the scheduled, synchronous surface that turns the
coach's community into a live experience without the coach
leaving the platform for Zoom or Calendly. It pairs with the
asynchronous community spec
([`community-spaces.md`](./community-spaces.md)) and feeds the
replay/content library
([`replays-content-library.md`](./replays-content-library.md)),
which owns the **post-event** retention loop.

The 16-section template follows
[`docs/specs/README.md`](./README.md). Every section closes with
a short list of decisions that must be settled before the first
runtime PR.

---

## 1. Status banner and cross-references

- **Stage:** discovery → spec.
- **Depends on (drafts):** PR #117 (Supabase Storage prefix +
  mime allow-list reused for replays), PR #118 (Team Mode
  forward-compat hook), PR #120 (lanes #01 flags / #02 API
  versioning / #03 RBAC / #05 billing packaging / #06
  observability / #11 release QA), PR #121 (#23 weekly recap
  reads attendance signals), PR #122 (mastermind Phase 2 cohort
  surface — IRL events tier — reuses the lifecycle shape but
  layers in deposit-paid + travel-confirmed states), PR #123
  (#36 messaging+progress; the call surface is built on the
  same Realtime pattern).
- **Reuses (merged):** `User`, `CoachProfile`, `CoachSubscription`,
  `SubscriptionGuard`, the throttler (PR #93), `AuditLog`,
  `MessageDraft` semantics (idempotent intake), the
  notification preferences row, the deep-link / universal-link
  contract (`docs/invite-landing.md`).
- **Out of scope:** voice/video media plane (the platform calls
  a third-party WebRTC provider — LiveKit, Daily, 100ms — never
  proxies the media itself); native dial-in via PSTN (parking-
  lot row #08, PR #119); cross-coach calendar federation; one-
  on-one live-coaching sessions (the per-coach roster handles
  that today via messaging); IRL event production logistics
  (covered by PR #122 mastermind operating model — this spec
  carries the **virtual** + **hybrid** lifecycle only).

---

## 2. WHY — problem in user/business terms

**Coach problem.** A live call is the single most reliable
retention event a coach has — clients show up, the coach is
in the room, momentum is rebuilt. But hosting one today means
issuing a Zoom link, manually enrolling the roster, sending the
reminder, and re-uploading the recording to whatever surface
the coach calls home. The platform has the roster, the
messaging surface, and the entitlement gate; it does not have
the live event lifecycle.

**Client problem.** A client misses a call because the link
landed in a separate inbox, or attends and never sees the
recording because the coach forgot to post it. Engagement
collapses for predictable reasons: the live moment is one
surface, the recap is another, the reminder is a third.

**Business problem.** Live calls are the lever that turns
"this coach is in my app" into "this coach hosts my week." The
platform owning the live event lifecycle is the difference
between the coach renewing on the platform and the coach
quietly leaving when their Zoom subscription is up for renewal.

**Why now.** PR #120 lane #05 confirms that higher tiers can
include "live group coaching" as a billable component. PR #117
already adds the Storage prefix the replay piggybacks on. PR
#121 spec #23 needs an attendance signal for the weekly recap.
The community spec depends on a "where the coach actually
shows up" surface to be retention-positive — without live
events, the community is a feed, not a relationship.

---

## 3. WHEN — gating conditions for the first runtime PR

PR-1 (schema additions + read-only `GET /api/events/:id` for an
empty event) cannot start until **all** of the following are
true.

1. **Provider chosen.** WebRTC provider chosen between LiveKit,
   Daily, and 100ms. Selection is recorded in
   `docs/operations/live-calls.md` (a future doc, not in this
   PR). The provider interface is pluggable from day one
   (deterministic fallback returns a "join_url not available"
   envelope when the provider is unset, mirroring the AI
   pattern).
2. **Tier mapping confirmed.** PR #120 lane #05 has recorded
   which tier(s) include live calls and the per-event minute
   ceiling per tier (caps the cost variance). Spec defaults:
   L1 (fitness): no live calls; L2: 4 events/month; L3: 12
   events/month + concierge.
3. **Recording posture decided.** Recording is on or off by
   default per event; the coach toggles. Recordings are
   retained per the data-lifecycle matrix (PR #120 lane #04)
   and indexed by the content library.
4. **Calendar invite path.** Either we mint `.ics` server-side
   and serve it, or we link to a Google/Apple calendar
   integration. Spec defaults to `.ics` mint (zero
   third-party dep, works for all clients).
5. **Notification fan-out path.** Reminders fire at T-24h,
   T-1h, T-5min. Whether email + push or push-only depends on
   the messaging notification refactor (parking-lot row #07,
   PR #119). Spec defaults to push-only until that lands;
   email reminder is a flagged-on add later.
6. **Time zone posture.** Events are stored in UTC; rendered
   in the viewer's local time on the client (the user record
   does not yet carry a `timezone` column — added if needed).

---

## 4. WHERE — modules, tables, routes touched

### 4.1 New module

`src/events/` (peer to `src/community/`).

| File | Owns |
|---|---|
| `events.module.ts` | Wires controller + services. Imported by `app.module.ts` only behind `LIVE_CALLS_ENABLED`. |
| `events.controller.ts` | `GET /api/events/coach/:coach_id`, `GET /api/events/:id`, `POST /api/events`, `PATCH /api/events/:id`, `POST /api/events/:id/rsvp`, `POST /api/events/:id/join` (returns join URL + token), `POST /api/events/:id/cancel`, `POST /api/events/:id/recording` (provider webhook for "recording ready"), `POST /api/events/:id/finalize` (idempotent close-out). |
| `events.service.ts` | Prisma reads/writes; the `SubscriptionGuard` and entitlement bundle checks. |
| `events-provider.service.ts` | The provider abstraction. One method per call lifecycle: `createRoom`, `mintJoinToken(user_id)`, `endRoom`, `fetchRecordingUrl(room_id)`. Pluggable; deterministic fallback for tests. |
| `events-reminder.service.ts` | Reminder cron + the per-event reminder rows. Reuses `@nestjs/schedule`. |
| `events-attendance.service.ts` | Attendance ledger writer; reads the provider webhook and emits `EventAttendance`. |
| `dto/*.ts` | Request/response DTOs + Swagger models. |
| `README.md` | Module orientation. |

### 4.2 New tables (additive, sketched in §8)

`Event`, `EventRSVP`, `EventAttendance`, `EventRecording`,
`EventReminder`. Every row carries `coach_id`. Every write
carries the nullable `acted_by_member_user_id` PR #118 hook.

### 4.3 New env vars (described, not added)

- `LIVE_CALLS_ENABLED` — global kill-switch. Default off.
- `LIVE_CALLS_PROVIDER` — `livekit` | `daily` | `100ms` |
  `none`. Default `none` (deterministic fallback).
- `LIVE_CALLS_PROVIDER_API_KEY` (and friends per provider).
- `LIVE_CALLS_RECORDING_DEFAULT_ON` — boolean; default `false`.
- `LIVE_CALLS_PER_COACH_MONTHLY_MINUTES_CAP` — soft cap per
  tier (per PR #120 lane #05).
- `LIVE_CALLS_REMINDER_OFFSETS` — comma-separated minutes
  before start; default `1440,60,5`.

### 4.4 Mobile + console contract

Mobile:
`POST /api/events/:id/rsvp` and `POST /api/events/:id/join`. The
join endpoint returns a one-shot signed token + the provider
URL; the client opens the WebRTC SDK. The platform never
relays the media plane.

Coach console: full CRUD on events + the recordings list +
attendance roster. The console reuses the OWNER bypass posture.

### 4.5 Files explicitly NOT touched

- `prisma/schema.prisma` — no edit in this PR.
- `prisma/migrations/` — no migration in this PR.
- `src/common/env-validation.ts` — env vars are described, not
  registered.
- `app.module.ts` — no module wiring in this PR.
- `new-website` — out of scope; the public-facing event-listing
  page (if any) is rendered by **this** backend's public-pages
  module, not by the marketing site.

---

## 5. WHO — sign-off, on-the-hook, downstream, hard boundaries

| Role | Person / artefact | What they decide |
|---|---|---|
| Founder | Bradley | Tier mapping (which tier includes how many events/month); whether recordings are on by default; refund posture for "coach didn't show". |
| Backend lead | (TBD) | Provider choice; whether the provider abstraction is built one-deep (LiveKit only) or multi-deep (provider-pluggable from day one). Spec defaults to provider-pluggable. |
| Mobile | (TBD) | WebRTC SDK shape; screen-share permission; permission posture for mic/cam (always-required vs join-muted). Spec defaults to join-muted-mic, cam-off. |
| Coach console | (TBD) | Whether the console gets a "go live now" surface or whether all events must be scheduled. Spec defaults to scheduled-only in v1 (eliminates the no-warning notification problem). |
| Pager | OWNER | First 30 days. Provider outages must not corrupt RSVPs; the join endpoint returns a graceful "provider down, join unavailable" envelope. |
| Hard boundaries | — | (a) The platform never proxies media; the WebRTC provider is third-party and the join flow is a redirect-with-token. (b) No PSTN dial-in in v1. (c) No public-internet event listing — `GET /api/events/coach/:coach_id` is members-only. (d) `new-website` stays untouched. |

---

## 6. WHAT — already exists, net-new, non-goals

### Already exists (reused)

- `User`, `CoachProfile`, `CoachSubscription`, `SubscriptionGuard`,
  `AuditLog`, the throttler, the deep-link contract.
- `@nestjs/schedule` for the reminder cron.
- The notification preferences row (`NotificationPreferences`)
  for the per-user opt-out.

### Net-new

- Five tables (§8).
- Provider abstraction (`events-provider.service.ts`).
- Reminder cron + per-event reminder rows (idempotent).
- Attendance ledger.
- Recording-ready webhook handler + the link to the content
  library (`replays-content-library.md`).
- Server-side `.ics` mint (a small, dependency-free utility).

### Non-goals

- Recurring events as a first-class concept in v1. v1 ships
  one-shot events; recurrence is a "create N events from a
  template" client-side fan-out at first.
- Multi-coach events (two coaches co-host). Out of scope until
  PR #118 Team Mode roles land.
- Anonymous / public events. Out of scope for the platform —
  every event is members-only.
- One-on-one live-coaching sessions. Out of scope; the per-
  client coaching relationship lives in messaging.
- In-event polls / Q&A / hand-raise. The provider's native
  features are used; the platform does not duplicate them.
- Live captioning / transcription in v1. Lands later, after
  the content library spec ships transcript indexing.

---

## 7. HOW — rollout plan + smallest first PR + feature flag

### 7.1 Rollout phases

| Phase | What lands | Flag state |
|---|---|---|
| PR-1 | Schema (additive); `GET /api/events/coach/:id` returns `[]`; module wired but unreachable. | `LIVE_CALLS_ENABLED=false`. |
| PR-2 | Coach can create an `Event` row. No provider integration yet; the join surface returns "provider not configured". | Flag on for staging; off for prod. |
| PR-3 | Provider integration — one provider only (e.g. LiveKit). `POST /api/events/:id/join` returns a real signed token + room URL. | Flag on for one beta coach in prod. |
| PR-4 | Reminder cron writes `EventReminder` rows. Reminders fire push at the configured offsets. RSVP path is wired. | Flag on for ≤5 beta coaches. |
| PR-5 | Recording webhook + the recording-ready path that writes one `EventRecording` row + an entry in the content library (depends on `replays-content-library.md` PR-1). | Flag on for ≤5 beta coaches. |
| PR-6 | Attendance ledger; the post-event finalize cron; the weekly-recap signal (PR #121 spec #23 reads it). | Flag on for the entire L2/L3 tier. |
| PR-7 | Console moderation surface (cancel event, ban member from this event); audit-log every action. | GA. |
| PR-8 | Optional: `.ics` mint, calendar-link path, T-24h email reminder once messaging notification refactor lands. | GA. |

### 7.2 Smallest first PR

**PR-1** ships:

- Schema additions in §8 (additive only).
- `events.module.ts` registered behind the flag.
- `GET /api/events/coach/:coach_id` returns `[]` when the flag
  is off.
- One smoke assertion: route mounted, returns 200 + `[]`.
- OpenAPI export update.

PR-1 carries no provider code, no reminder cron, no attendance,
no recording.

### 7.3 Feature flags

- `LIVE_CALLS_ENABLED` is the only required flag for PR-1.
- `LIVE_CALLS_PROVIDER=none` is the deterministic fallback.
  PR-1 ships with the provider unset; the join surface is
  unreachable until PR-3.
- `LIVE_CALLS_RECORDING_DEFAULT_ON` is the per-coach default
  for new events; the coach can override per event.
- `LIVE_CALLS_PER_COACH_MONTHLY_MINUTES_CAP` is the soft cap
  per tier (an OWNER alert at 80%, a write-block at 100%).

---

## 8. Data model sketch (additive Prisma; **not** migrated here)

```prisma
model Event {
  id                       String   @id @default(uuid())
  coach_id                 String
  coach                    User     @relation("EventCoach", fields: [coach_id], references: [id])
  title                    String                 // ≤ 200 chars
  description              String?                // ≤ 4 KB
  starts_at                DateTime               // UTC
  ends_at                  DateTime               // UTC; >= starts_at
  scheduled_minutes        Int                    // ends_at - starts_at; for the per-tier cap
  visibility               String   @default("members_only")  // "members_only" only in v1
  recording_enabled        Boolean  @default(false)
  provider                 String?                // "livekit" | "daily" | "100ms" | null at create time
  provider_room_id         String?                // set by createRoom call
  status                   String   @default("scheduled") // "scheduled"|"live"|"ended"|"cancelled"
  created_by_user_id       String                 // = coach.id in v1; PR #118 widens
  acted_by_member_user_id  String?                // PR #118 forward-compat
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  rsvps                    EventRSVP[]
  attendance               EventAttendance[]
  recordings               EventRecording[]
  reminders                EventReminder[]

  @@index([coach_id, starts_at])
  @@index([starts_at, status])
}

model EventRSVP {
  id              String   @id @default(uuid())
  event_id        String
  event           Event    @relation(fields: [event_id], references: [id], onDelete: Cascade)
  coach_id        String                       // denormalised tenancy axis
  user_id         String
  user            User     @relation("EventRSVPUser", fields: [user_id], references: [id])
  state           String   @default("yes")    // "yes" | "no" | "maybe"
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@unique([event_id, user_id])
  @@index([coach_id, event_id])
}

model EventAttendance {
  id              String   @id @default(uuid())
  event_id        String
  event           Event    @relation(fields: [event_id], references: [id], onDelete: Cascade)
  coach_id        String
  user_id         String
  user            User     @relation("EventAttendanceUser", fields: [user_id], references: [id])
  joined_at       DateTime
  left_at         DateTime?
  duration_seconds Int?                        // computed at finalize
  created_at      DateTime @default(now())

  @@index([event_id, user_id])
  @@index([coach_id, joined_at])
}

model EventRecording {
  id                 String   @id @default(uuid())
  event_id           String
  event              Event    @relation(fields: [event_id], references: [id], onDelete: Cascade)
  coach_id           String
  storage_path       String                  // Supabase Storage path
  duration_seconds   Int
  bytes              BigInt
  ready_at           DateTime
  content_library_entry_id String?           // FK to ContentLibraryEntry (replays spec)
  created_at         DateTime @default(now())

  @@index([coach_id, created_at])
}

model EventReminder {
  id           String   @id @default(uuid())
  event_id     String
  event        Event    @relation(fields: [event_id], references: [id], onDelete: Cascade)
  coach_id     String
  fires_at     DateTime
  fired_at     DateTime?
  channel      String                        // "push" | "email"
  status       String   @default("scheduled") // "scheduled" | "fired" | "skipped"
  created_at   DateTime @default(now())

  @@unique([event_id, fires_at, channel])
  @@index([fires_at, status])
}
```

### 8.1 Schema notes

- `Event.provider_room_id` is set on first `createRoom` call,
  not at row insert. The provider call is idempotent: if the
  room already exists, the call returns the existing id.
- `EventRSVP` is keyed `(event_id, user_id)` unique — re-RSVP
  is an upsert, not a duplicate row.
- `EventAttendance` is the ledger; it is **not** unique on
  `(event_id, user_id)` because a member can leave and rejoin.
  Duration is summed at finalize.
- `EventRecording.content_library_entry_id` links to the
  content-library spec; absent until PR-5.
- `EventReminder` is the cron's idempotency key. The cron picks
  rows where `status='scheduled'` AND `fires_at <= now()`, sets
  `status='fired'` in the same transaction, then dispatches.
  Failed dispatch becomes `status='skipped'` with a reason
  column added in a later PR.

---

## 9. API sketch (routes + envelope + throttling)

All routes are under `/api/events/*`.

### 9.1 Read

```
GET /api/events/coach/:coach_id?from=ISO&to=ISO
  → 200 { events: EventEnvelope[] }
  → 423 { error: "feature_locked", reason: "tier_below_live_calls" }
```

```
GET /api/events/:id
  → 200 { event: EventEnvelope, rsvp: { state: "yes"|"no"|"maybe" } | null }
  → 403 / 404
```

### 9.2 Write (coach + OWNER)

```
POST /api/events
  body: { title, description?, starts_at, ends_at, recording_enabled? }
  → 201 { event }
  → 422 { error: "validation_failed", fields: { ... } }
  → 423 { error: "feature_locked" }
  → 429 { error: "rate_limited" }
```

Throttle: `5/hour/coach` for create. Per-tier monthly minutes
cap enforced at create-time: `scheduled_minutes + sum(month) >
LIVE_CALLS_PER_COACH_MONTHLY_MINUTES_CAP` returns
`{ error: "monthly_minutes_cap_exceeded", remaining: number }`.

```
PATCH /api/events/:id
  body: { title?, description?, starts_at?, ends_at?, recording_enabled? }
  → 200 { event }
  → 409 { error: "event_already_started" }
```

A `PATCH` on a `status='live'` or `status='ended'` event returns
409 — the lifecycle is mostly write-once after start.

```
POST /api/events/:id/cancel
  → 200 { event: { status: "cancelled" } }
```

Cancellation fires a notification to all RSVPs.

### 9.3 Member surface

```
POST /api/events/:id/rsvp
  body: { state: "yes" | "no" | "maybe" }
  → 200 { rsvp }
  → 423 { error: "feature_locked" }
```

```
POST /api/events/:id/join
  → 200 { join_url: string, join_token: string, expires_at: ISO }
  → 403 { error: "rsvp_required" } | { error: "not_member" }
  → 423 { error: "feature_locked" }
  → 503 { error: "provider_unavailable" }
```

`join_token` is a one-shot, ≤5-minute TTL token issued by the
provider (signed with provider's secret). It is **not** the
platform JWT. The client opens `join_url` in the WebRTC SDK.

### 9.4 Provider webhook

```
POST /api/events/:id/recording
  body: { provider_room_id, storage_path, duration_seconds, bytes }
  → 201 { recording: EventRecordingEnvelope }
```

The webhook is HMAC-signed; the controller verifies the signature
against the provider secret. Reuses the Stripe-webhook idempotency
table pattern (`StripeProcessedEvent`) — a new
`ProviderProcessedEvent` row is added in PR-5 to dedupe.

### 9.5 Finalize

```
POST /api/events/:id/finalize
  → 200 { event: { status: "ended" }, attendance: [...] }
```

Idempotent. Computes `duration_seconds` per attendance row and
emits the `event_finalized` PostHog event.

### 9.6 Envelope

```ts
type EventEnvelope = {
  id: string;
  coach_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  scheduled_minutes: number;
  status: "scheduled"|"live"|"ended"|"cancelled";
  recording_enabled: boolean;
  provider: "livekit"|"daily"|"100ms"|null;
  rsvp_counts: { yes: number; no: number; maybe: number };
  recording: { id: string; storage_path: string; duration_seconds: number } | null;
};
```

---

## 10. Media / replay storage

Recordings are written by the provider to Supabase Storage at
`coach/{coach_id}/event/{event_id}/recording.{ext}` (Storage
prefix from PR #117 §8). The recording-ready webhook writes one
`EventRecording` row, then writes one `ContentLibraryEntry` row
(see [`replays-content-library.md`](./replays-content-library.md))
linking back via `content_library_entry_id`. The content-library
surface owns the playback, transcript, captions, and chaptering;
the events surface only carries the *fact* of the recording.

Retention follows PR #120 lane #04: recordings are tier-specific
(spec defaults to 90 days at L2, 365 days at L3, then a coach-
visible "extend retention" upsell). Account-deletion scrub
hard-deletes both the row and the Storage object after the
30-day grace window.

---

## 11. Moderation, member-only access, abuse posture

Member-only access mirrors the community spec (§11 there). The
join surface returns 403 if the viewer is not a member of this
coach's roster, regardless of RSVP. RSVP without entitlement
returns `feature_locked`.

In-call moderation is **provider-native** (mute/remove
participants happens through the provider SDK). The platform
exposes one button that maps to the provider call. Audit-log
every removal.

A member reported during a live event flows into
`CommunityReport` with `target_kind='event'` once that union
type lands (PR #123 wave update); for v1, the coach removes the
participant in-room and the audit-log row is the record.

A "coach didn't show" outcome: the finalize cron picks up the
event, notices no `EventAttendance` rows for the coach, and
flags it for refund triage in the OWNER inbox (PR #122 mastermind
operating model has the same posture for IRL no-shows).

---

## 12. Member-only access + RBAC + privacy

| Concern | Posture |
|---|---|
| Authentication | `JwksAuthGuard`. The provider-webhook route is HMAC-signed only; auth is a separate guard. |
| Tenancy axis | `coach_id` on every row. Cross-coach reads return 403. |
| Entitlement gate | Per-coach via `SubscriptionGuard`. Per-member via the entitlement bundle (the member's tier must include live calls; otherwise `feature_locked`). |
| GDPR | `EventRSVP`, `EventAttendance`, `EventRecording`, `EventReminder` all in the per-table retention matrix. Account-deletion scrub: tombstones RSVP/attendance, hard-deletes recordings 30 days post-account-deletion. Export includes the user's RSVPs and attendance, not the surrounding roster. |
| PII | The envelope returns `rsvp_counts` as integers. Per-RSVP rosters (`GET /api/events/:id/rsvps`) are coach-only — members do not see the roster. |
| Audit-log | Every `POST /api/events`, `POST /api/events/:id/cancel`, `POST /api/events/:id/finalize`, and any in-call moderation action writes one row. |
| Provider data sharing | The provider receives `event_id` and a one-shot signed token containing `user_id` + `coach_id` + role; no PII (no email, no name). The display name shown in the call is the user's `display_name` only. |

---

## 13. AI governance (transcription, summarisation, suggestions)

The events surface itself does not call an LLM. Two adjacent
surfaces do:

1. **Transcript + chapter generation** lives in the content-
   library spec ([`replays-content-library.md`](./replays-content-library.md)),
   not here. The recording-ready webhook hands off; the content
   library does the AI work.
2. **AI Business Copilot** ([`ai-business-copilot.md`](./ai-business-copilot.md))
   suggests:
   - "Schedule a call this week — 3 of your members are at-risk"
     (reads the at-risk detector, PR #121 spec #22).
   - "Topic ideas for next week's call" (reads the community
     spec post counts + the at-risk detector).
   - "Send a reminder to the 4 RSVPs who didn't show last week"
     (reads `EventAttendance`).

Every copilot suggestion is human-in-the-loop; the events
surface only writes when the coach hits send. Per-coach monthly
budget cap on copilot calls (PR #120 lane #05). Eval baselines
for the copilot prompts live in the AI Business Copilot spec.

---

## 14. Feature flags + entitlements

| Flag | Default | What it gates |
|---|---|---|
| `LIVE_CALLS_ENABLED` | off | Whole module; PR-1 ships gated. |
| `LIVE_CALLS_PROVIDER` | `none` | Deterministic fallback; `none` returns `provider_unavailable`. |
| `LIVE_CALLS_RECORDING_DEFAULT_ON` | false | Per-coach default. |
| `LIVE_CALLS_PER_COACH_MONTHLY_MINUTES_CAP` | per-tier | OWNER alerts at 80%, hard-blocks at 100%. |
| Entitlement bundle | tier-gated | L2/L3 only in v1. L1 returns `feature_locked`. |

Kill-switch: set `LIVE_CALLS_ENABLED=false` in Fly secrets;
in-flight events keep their already-issued tokens until they
expire, but no new joins succeed.

---

## 15. Analytics + telemetry

PostHog events:

| Event | Properties |
|---|---|
| `event_created` | `coach_id`, `scheduled_minutes`, `recording_enabled` |
| `event_rsvp` | `coach_id`, `event_id`, `state` |
| `event_join_token_minted` | `coach_id`, `event_id`, `viewer_role` |
| `event_attended` | `coach_id`, `event_id`, `duration_seconds` |
| `event_finalized` | `coach_id`, `event_id`, `attendance_count`, `attendance_p50_minutes` |
| `event_recording_ready` | `coach_id`, `event_id`, `duration_seconds` |
| `event_cancelled` | `coach_id`, `event_id`, `lead_time_seconds` |

OWNER metrics counter gains:

- `events_scheduled_30d` (per coach + total).
- `events_attended_30d` (per coach + total).
- `events_attendance_rate_p50_p90` (across coaches).
- `events_recording_storage_bytes_per_coach`.

The weekly recap (PR #121 spec #23) reads `event_attended` to
surface "you joined 3 of 4 calls this month, your coach
hosted X." The at-risk detector (PR #121 spec #22) reads
"member RSVPed yes but did not attend ≥2 events" as a
risk signal.

---

## 16. Tests, risks, dependencies, acceptance, operator handoff

### 16.1 Tests

- **Unit**: provider-abstraction stub + deterministic fallback;
  reminder cron's idempotency (running it twice never double-
  fires); attendance summation.
- **Integration**: every route in §9 against a stubbed
  provider; the provider webhook with HMAC verification.
- **Smoke**: route mounted, returns 200 + `[]` when the flag
  is off.
- **Eval**: not applicable for events themselves; transcript
  evals live in the content-library spec.
- **Load**: PR-3 stress-tests the `POST /events/:id/join`
  surface — 200 simultaneous joins, p95 < 500 ms (the
  provider's signing call dominates).

### 16.2 Risks

- **Provider outage during a scheduled event.** The platform
  cannot host the call without the provider. Mitigation:
  graceful 503 + a coach-visible "provider down" banner; the
  recording webhook is durable and re-runs on the next
  successful provider call.
- **Cost runaway.** A coach schedules 200 hours of calls and
  recordings. Mitigation: per-tier monthly minutes cap (§4.3,
  §9); OWNER alerts at 80% via the existing monitoring setup.
- **Reminder spam.** The cron runs twice and double-fires.
  Mitigation: `EventReminder` unique on
  `(event_id, fires_at, channel)`; the cron updates `status`
  in the same transaction.
- **Privacy leak via roster.** A non-coach member discovers
  who else is attending. Mitigation: roster reads are
  coach-only; the member envelope returns counts only.
- **Recording leak via Storage URL.** A signed URL leaks.
  Mitigation: recordings are served through a short-TTL signed
  URL minted on read, never a public URL.
- **PSTN absence.** Members without app access cannot join.
  Acknowledged limitation; documented in operator runbook.

### 16.3 Dependencies

- Internal: PR #117 (Storage prefix), PR #120 (lanes #01, #02,
  #05, #06, #11), PR #121 (#22, #23), PR #123 (#36 messaging
  Realtime pattern), `replays-content-library.md` (recording
  fan-out), `ai-business-copilot.md` (suggestion reads).
- External: WebRTC provider (LiveKit / Daily / 100ms);
  provider's recording webhook; `@nestjs/schedule` (already
  installed); `node-ical` or hand-rolled `.ics` mint (PR-8 only).

### 16.4 Acceptance criteria

- A coach on the L2 tier can schedule a 60-min event, the
  roster receives the T-1h push reminder, three members RSVP
  yes, two attend, the recording is auto-archived to the
  content library, and the OWNER dashboard tile reflects the
  attendance rate within 5 minutes of finalize.
- A member whose tier does not include live calls sees
  `feature_locked` on the events list, never a 403.
- The `LIVE_CALLS_PROVIDER=none` path returns
  `provider_unavailable` deterministically and the events
  surface remains otherwise functional (RSVP works, reminders
  fire).
- A revert is a single Fly secret flip; no migration runs in
  the rollback path.

### 16.5 Operator handoff

- **Runbook entry:** `docs/operations/live-calls.md` (a future
  doc, not in this PR) covers provider rotation, recording
  retention, refund-on-no-show triage, the
  `provider_unavailable` failover.
- **Dashboard tiles:** PR #120 lane #06 dashboard receives
  attendance-rate, recording-storage, and minutes-cap
  utilization tiles.
- **Kill-switch:** `fly secrets set LIVE_CALLS_ENABLED=false
  -a tgp-backend-prod`.
- **First 30 days:** OWNER reads `events_attendance_rate_p50_p90`
  weekly; any coach < 30% attendance is the on-call signal for a
  retention check-in.

---

## Decisions that must close before PR-1

1. WebRTC provider (LiveKit / Daily / 100ms / Twilio Video).
   (Backend lead.)
2. Tier mapping (which tier includes how many events/month, and
   the per-event minutes cap). (Founder + PR #120 lane #05.)
3. Recording default (on per coach? per event?). (Founder.)
4. Refund posture for "coach didn't show" (auto-credit vs
   manual triage). (Founder.)
5. Reminder channels for v1 (push only, or push + email).
   (Mobile + backend lead.)
6. Whether to ship recurring events in v1 (spec defaults: no).
   (Founder.)
