# Session scheduling / calendar foundation

This doc covers the foundation for client ↔ coach 1:1 session
scheduling: data model, provider abstraction, permission rules, audit
events, and the follow-up work needed to ship a real Google Calendar /
Google Meet / Zoom integration.

The doctrine: TGP is a private coaching concierge. The only people who
can request a session with a coach are clients already linked to that
coach via `User.coach_id`. Coaches approve every booking unless they
have explicitly marked a SessionType as `auto_approve`. There is no
public booking page and no marketplace flow in this PR.

## What's in this PR

- New tables — `SessionType`, `CoachAvailability`, `CoachingSession`,
  `SessionParticipant`, `CalendarConnection`.
- New enums — `SessionStatus`, `VideoProvider`, `CalendarProvider`,
  `SessionParticipantRole`.
- A `SchedulingProviderRegistry` that resolves a provider enum value to
  the live adapter. Real adapters are scaffolded; the registry returns
  the stub unless the corresponding `*_ENABLED` env flag is `"true"`.
- A `SchedulingService` that owns every state transition, audit-log
  write, and provider call.
- A `SchedulingController` mounted at `/scheduling/*`.
- A `SchedulingWebhookController` mounted at `/scheduling/webhooks/*`.
  The Google / Zoom handlers are signature-unverified stubs that 200
  any payload. **Wire signature verification before adding any state
  mutation.**
- Two job seams (`SessionReminderJob`, `CalendarSyncJob`) — type-only
  scaffolds that callers can wire into `@nestjs/schedule` later.

## What's NOT in this PR

- Real Google Calendar / Meet / Zoom calls. The adapters log and return
  stub-shaped values.
- OAuth token storage. `CalendarConnection.credentials_secret_ref` is a
  pointer to a secret-store entry; this PR never reads from it.
- Reminder dispatch. The seam exists; the wire-up to `NotificationsModule`
  lands separately.
- One-off availability exceptions. Today, a coach blocks a single day
  by declining individual conflicting requests.
- AI brief generation. The AI gateway lands in #140; once merged, the
  pre-session brief endpoint will request a draft via the gateway with
  human approval before any client-facing surface.

## State machine

```
requested ──approve──▶ scheduled ──complete──▶ completed
   │   │                  │     ─no_show──▶ no_show
   │   │                  └──cancel───────▶ canceled
   │   └─cancel──▶ canceled
   └─decline──▶ declined
```

`SchedulingService.assertTransition` enforces the table; anything
outside it returns 400. `pending_provider` is a transient state used
when a real adapter call is in flight.

## Permission rules

Implemented in `src/scheduling/scheduling.permissions.ts`:

| Action                   | Client (own coach) | Lead coach | Other coach | Owner |
| ------------------------ | :----------------: | :--------: | :---------: | :---: |
| Request a session        |         ✓          |     ✗      |      ✗      |   ✓   |
| View a session           |         ✓          |     ✓      |      ✗      |   ✓   |
| Approve / decline        |         ✗          |     ✓      |      ✗      |   ✓   |
| Reschedule               |         ✓          |     ✓      |      ✗      |   ✓   |
| Cancel                   |         ✓          |     ✓      |      ✗      |   ✓   |
| Complete / no-show       |         ✗          |     ✓      |      ✗      |   ✓   |
| Edit availability        |         ✗          |   self     |      ✗      |   ✓   |
| Attach manual video link |         ✗          |     ✓      |      ✗      |   ✓   |

Sub-coaches are modelled today as a coach whose `User.coach_id` points
at the lead coach. They get the standard "coach" rules above for
sessions where they are the lead — full hierarchy (a sub-coach acting
on the lead coach's behalf) is a follow-up.

## Audit events

Every state transition writes an `AuditLog` row through `AuditService`.
The action constants live on `AuditAction` and group under `session.*`:

- `session.requested`, `session.approved`, `session.declined`
- `session.rescheduled`, `session.canceled`
- `session.completed`, `session.no_show`
- `session.video_link_attached`
- `session.provider.calendar_created`, `session.provider.video_created`,
  `session.provider.canceled`
- `coach.availability_updated`
- `coach.session_type_created`, `coach.session_type_updated`

Writes are best-effort (`AuditService.write` swallows errors); audit
infrastructure failures must not 500 a user-facing endpoint.

## Provider feature flags

| Env var                    | Default | Effect                                                     |
| -------------------------- | :-----: | ---------------------------------------------------------- |
| `GOOGLE_CALENDAR_ENABLED`  | unset   | `google_calendar` provider falls back to stub adapter      |
| `GOOGLE_MEET_ENABLED`      | unset   | `google_meet` video provider falls back to stub            |
| `ZOOM_ENABLED`             | unset   | `zoom` video provider falls back to stub                   |

Read once at registry construction. Flip → redeploy. Setting any flag
without also providing the corresponding OAuth credentials is safe —
the placeholder adapters log and return stub-shaped IDs; they never
make a network call. Real callouts only land in a follow-up PR.

## Follow-up checklist (handoff)

Before this scaffolding can serve real bookings:

1. **Google Calendar adapter** — implement `events.insert` /
   `events.delete` against `googleapis`, signing requests with the
   coach's OAuth credentials resolved from
   `CalendarConnection.credentials_secret_ref`. Use `idempotencyKey`
   as the request-id header so retries are safe.
2. **Google Meet** — populate `conferenceData` on the calendar event
   instead of a separate API; the Meet adapter delegates to the
   calendar provisioning result.
3. **Zoom adapter** — implement `POST /users/{coachAccount}/meetings`
   against the Server-to-Server OAuth flow. Persist `id` and
   `join_url` on the session.
4. **OAuth flows** — connect/disconnect endpoints for the coach to
   authorise their Google or Zoom account. The `CalendarConnection`
   row stores only metadata; the actual token goes to Fly secrets /
   AWS SM under the `credentials_secret_ref` pointer.
5. **Webhook signature verification** — `SchedulingWebhookController`
   currently 200s any payload. Verify Google's `X-Goog-Channel-Token`
   and Zoom's request signature before mutating any row.
6. **Reminder dispatcher** — wire `SessionReminderJob.findDueReminders`
   into `NotificationsModule` and register a `@Cron` handler.
7. **Calendar-sync job** — implement two-way sync so a coach editing
   the underlying Google event reflects back into the
   `CoachingSession` row (`CalendarSyncJob.listSyncCandidates` is the
   starting point).
8. **Pre-session brief** — once #140 lands, expose a draft endpoint
   that asks the AI gateway for a brief; require human approval before
   surfacing to the client.
9. **Availability exceptions** — model one-off blackouts /
   single-day overrides on top of `CoachAvailability`.
