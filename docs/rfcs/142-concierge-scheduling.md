# RFC 142 — Concierge scheduling

Status: in flight (PR #142). v1 scope locked 2026-05-11.
Owner: Bradley Gleave.
Supersedes: the abstract "session scheduling foundation" framing in the original draft of this PR. The v1 surface is narrower (concierge only) and concrete.

## 1. Model

**CONCIERGE only.** Private 1:1 booking between a client and the coach (or sub-coach) they are already assigned to. No public discovery, no marketplace, no anonymous booking. The booking surface is invisible to a user until they have a `coach_id` link via the existing client-coach relationship (or a `TeamSubCoachAssignment` row that puts them under a sub-coach).

Two-way Google Calendar sync optional and gated by an OAuth link the user opts into. When Google is not linked, sessions still persist in our database; the coach simply does not get a Google Calendar event auto-created.

## 2. User flows

### 2a. Coach sets availability
1. Coach opens "My Availability" in the console.
2. Coach picks recurring weekly windows (e.g. Mon-Fri 09:00-17:00 in their timezone).
3. Coach optionally adds date overrides: HOLIDAY (off), BLOCK (off with note), EXTRA (available outside the recurring window).
4. Coach optionally toggles `auto_approve` on a SessionType so client requests skip the manual review.

### 2b. Coach links Google Calendar
1. Coach hits `GET /scheduling/auth/google/initiate`.
2. We mint a state nonce binding the OAuth handshake to their user id, redirect to Google's consent screen.
3. Coach approves; Google redirects to `GET /scheduling/auth/google/callback?code=&state=`.
4. We exchange the code for the refresh+access token pair, write a `CalendarConnection` row, and stash the refresh token (v1: in-process; v2: KMS-wrapped via the helper shipped by Bloodwork PR #141).
5. Coach is redirected back to the app `Settings -> Integrations` view with `google_oauth=ok`.

### 2c. Client books a slot
1. Client opens the coach's availability view (only their assigned coach is visible).
2. Client picks a slot (the UI subtracts coach availability minus existing bookings minus Google busy blocks).
3. Client submits a `BookingRequest` (mapped onto `CoachingSession` with `status='requested'`).
4. If the SessionType is `auto_approve`, status flips to `scheduled` immediately and the provider call to Google Calendar fires. Otherwise the coach receives a notification and reviews.
5. On approval (manual or auto), a Google Calendar event is created on the coach's calendar (when linked) AND on the client's calendar (when their account is also linked). The event ids land on the session row for later reschedule/cancel.

### 2d. Cancellation + lockout
- Either party can cancel up to `BOOKING_LOCKOUT_HOURS` before start. Default 4 hours; configurable per-coach in a follow-up.
- Inside the lockout window: only the coach can cancel (and the session is marked `canceled` with a coach-provided reason; the client is notified).
- Cancellation deletes the Google Calendar event(s) on both sides if they were created.

### 2e. Reschedule
- Treated as cancel-then-rebook in v1 (simplest, preserves audit trail). The new session inherits the SessionType and the prior session's `prior_session_id` is recorded in metadata.

## 3. Schema additions (this PR)

The original scheduling scaffold (PR #142's first commit) already introduced `SessionType`, `CoachAvailability`, `CoachingSession`, `SessionParticipant`, `CalendarConnection`. This RFC adds **one** new model and reuses the existing five:

- **`CoachAvailabilityOverride`** (new): `(coach_id, date, start_minute?, end_minute?, kind, note?)`. `kind` is a CHECK-constrained string (`holiday | block | extra`). All-day overrides have null start/end. Unique on `(coach_id, date, start_minute, kind)`. Indexed on `(coach_id, date)` for the slot-computation hot path.

The four-model checklist from the brief maps as follows:

| Brief asked for | Lives in |
|---|---|
| CoachAvailabilityWindow | Existing `CoachAvailability` (day_of_week + start/end minute) |
| CoachAvailabilityOverride | New, this PR |
| BookingRequest | Existing `CoachingSession` (the `requested` status IS the booking request; promotion to `scheduled` is the approval) |
| GoogleCalendarConnection | Existing `CalendarConnection` with `provider='google_calendar'` |

Migration: `prisma/migrations/20260512000000_concierge_scheduling/`. Additive only. Slot is the next monotonic position above main HEAD's `20260511000000_add_bloodwork`. Reversibility documented inline.

## 4. Auth + tenancy rules

- **Client booking endpoint** requires JWT + `BookingGuard`: enforces that the booking's `coach_id` equals the calling client's `User.coach_id`, OR there exists an active `TeamSubCoachAssignment(head_coach_id=user.coach_id, sub_coach_id=requested_coach_id)`. If neither holds, return 403 with `{ kind: 'not_assigned_to_coach' }`.
- **Coach booking-management endpoints** require JWT + `CoachGuard` (matching the per-route pattern enforced repo-wide by Sprint B v2.1 / Team Mode PR #118).
- **OAuth endpoints** are per-route: `initiate` requires JWT (the user must be logged in to start the link); `callback` is `@Public()` because Google posts to it without our JWT. CSRF is mitigated by the signed `state` nonce.

## 5. Auto-confirm vs manual-confirm

Per `SessionType.auto_approve`. Coaches set this consciously per offering. Default is `false` — the doctrine is "coach approves every booking" until the coach decides otherwise. The booking still creates a `CoachingSession` row immediately; the only difference is initial `status` (`requested` vs `scheduled`) and whether the provider call fires now or after the coach hits approve.

## 6. Conflict detection

At booking-request time, the service checks:
1. The requested window falls inside an active `CoachAvailability` row (subtracting `CoachAvailabilityOverride.kind in ('holiday','block')` and adding `kind='extra'`).
2. No existing `CoachingSession` with status in `('requested','scheduled','pending_provider')` overlaps the requested window for the same coach.
3. If the coach has a Google Calendar connection AND the `GOOGLE_CALENDAR_ENABLED=true` flag is set, the service queries the freeBusy API for the window and rejects if a busy block exists. The query is non-blocking on degradation — when Google is unreachable, the service logs a warning and falls back to the local-only check.

Returns 409 with `{ kind: 'slot_unavailable', reason: 'overlaps_existing_session' | 'outside_availability' | 'google_calendar_busy' }`.

## 7. Google Calendar integration

OAuth scopes (v1):
- `https://www.googleapis.com/auth/calendar.events` — read + write the user's events on calendars they own. Required for event creation, deletion, and freeBusy on the primary calendar.

The full `calendar` scope is **not** requested; we never list other calendars, never read shared-with-me events, never modify ACLs. This keeps the verification surface as small as possible.

**Verification posture:** `calendar.events` is a sensitive scope. Google's testing mode permits up to 100 users without verification — enough for closed beta. Public launch requires a Google verification submission (1-6 weeks). Documented as a launch-blocker for the public flow; not a blocker for beta.

**Refresh token storage:** v1 stashes refresh tokens in-process (cleared on restart). v2 routes them through the KMS helper shipped by Bloodwork PR #141. The `CalendarConnection.credentials_secret_ref` column already exists and points at the future secret store.

**Push notifications (calendar watch):** deferred. v1 reconciles via the `CalendarSyncJob` scheduled job (already in this PR's scaffold). Push notification subscriptions land in a follow-up; the listener will write to the same idempotency-keyed reconcile path as the cron.

## 8. Notifications

Triggered from the scheduling service, written via the existing notifications module:

| Trigger | Recipients |
|---|---|
| Booking requested | Coach |
| Booking confirmed (auto or manual) | Client AND Coach |
| Booking declined | Client |
| Cancellation | Other party (the one who did not initiate) |
| Reminder 24h before start | Both |
| Reminder 1h before start | Both |

The reminder cron is in `src/scheduling/jobs/reminder.job.ts` (already scaffolded).

## 9. Time zone handling

- Store all timestamps in UTC on `CoachingSession.start_at` / `end_at`.
- Store the coach's local recurring availability as `CoachAvailability.day_of_week + start_minute + end_minute` (minutes from local midnight). The interpretation of "local" is `CoachProfile.timezone`.
- Render in the coach's locale on coach surfaces, the client's locale on client surfaces. The mobile client does the rendering; the API never returns a pre-formatted string.

## 10. Tier gating

All tiers (Growth / Pro / Enterprise) get concierge scheduling — it is core, not a paid upsell. Sub-coach concierge: a sub-coach inherits availability + booking rights from their `TeamSubCoachAssignment` row. The `BookingGuard` accepts both `coach_id` direct match AND the assignment-row indirection.

## 11. Out of scope (deliberate)

- Public discovery / marketplace.
- Payment-on-book.
- Group sessions (the schema's `SessionParticipant` row exists for future use).
- Recurring bookings (each booking is a single concrete row in v1).
- Meeting-room provisioning (Google Meet / Zoom). The coach pastes their own link in `CoachingSession.video_url`. Real adapter integration is a follow-up — the scaffold is in `src/scheduling/providers/` but the real call paths are stubbed.
- Coach-to-coach scheduling.
- Calendar push notifications (replaced by the existing `CalendarSyncJob` cron in v1).
- Per-coach `BOOKING_LOCKOUT_HOURS` override (defaults to 4h; per-coach knob is a v2 follow-up).

## 12. Risks

- **Google verification timing:** the sensitive-scope verification is the long pole for public launch. Testing-mode coverage (100 users) is enough for beta; allow 1-6 weeks for verification before pushing the booking surface to all clients.
- **Refresh token leak:** in-process token storage is acceptable for dev/preview only. Production deploy is blocked on the KMS helper integration (PR #141 shipped the helper; this PR consumes it in the follow-up).
- **Time zone bugs:** the highest-noise category in scheduling code. The minute-of-day storage choice is deliberate (DST does not shift the recurring window) but rendering and conflict detection must always go through a single tz-resolution helper. Test seam exists in `scheduling.service.spec.ts`.
- **Cancel-during-lockout abuse:** a client cancelling at hour-3-and-59-minutes to dodge a reminder is the obvious gray area. v1 hard-codes 4 hours; if abuse is observed, the per-coach lockout knob lifts to a follow-up.

## 13. File map

Existing (already in this PR before the concierge narrowing):
- `prisma/schema.prisma` — five scheduling models (now six with the override).
- `prisma/migrations/20260512000000_concierge_scheduling/migration.sql` — DDL.
- `src/scheduling/scheduling.module.ts`, `scheduling.service.ts`, `scheduling.controller.ts`, `scheduling-webhook.controller.ts`, `scheduling.permissions.ts`, `dto/scheduling.dto.ts`.
- `src/scheduling/providers/` — `scheduling-provider.types.ts`, `scheduling-provider.registry.ts`, stub + Google + Zoom adapters.
- `src/scheduling/jobs/` — `calendar-sync.job.ts`, `reminder.job.ts`.
- `test/scheduling.service.spec.ts`, `scheduling-permissions.spec.ts`, `scheduling-providers.spec.ts`.

New in this concierge pass:
- `src/scheduling/google-oauth/google-oauth.service.ts` — OAuth code-exchange + refresh.
- `src/scheduling/google-oauth/google-oauth.controller.ts` — `/scheduling/auth/google/initiate` + `/callback`.
- `test/google-oauth.service.spec.ts` — 7 unit tests.
- `docs/rfcs/142-concierge-scheduling.md` — this file.
- `.env.example` — `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_SCOPES` documented (production values will arrive via Pipedream-connected GCP project).

## 14. References

- House rules: `docs/HOUSE_RULES.md` (no emoji, no exclamations, strict TS, additive migrations, per-route CoachGuard).
- Existing CoachGuard pattern: `src/auth/coach.guard.ts`; consumed per-method by `MacrosController`, `RealMealPlansController`, `WorkoutBuilderController`, `TeamModeController`.
- KMS helper (refresh-token storage v2): introduced by Bloodwork PR #141, `src/bloodwork/` (the `encryption_key_ref` + `kms_key_version` column pattern). Reuse the helper in the follow-up that promotes refresh tokens from in-process to KMS-wrapped at rest.

## 15. Status checklist for merge

- [x] Schema additive only.
- [x] Migration in the next monotonic slot.
- [x] OAuth scaffold compiles and is unit-tested (mocked fetch).
- [x] tsc clean, lint 0 errors, 134 suites / 1297 tests passing.
- [ ] Google verification submitted (out of scope for this PR; required before public launch).
- [ ] KMS-wrapped refresh-token storage (follow-up PR; consumes the Bloodwork PR #141 helper).
- [ ] Manual end-to-end test against a real Google Cloud project (waiting on Pipedream-connected GCP credentials).

Merge gate: PR stays draft until (a) credentials arrive from the Pipedream-connected GCP project, (b) an end-to-end smoke test passes against the dev environment, (c) audit signs off.
