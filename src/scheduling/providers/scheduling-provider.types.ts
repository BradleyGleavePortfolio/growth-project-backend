// Provider-abstraction contracts for the scheduling module.
//
// The doctrine: every external integration (Google Calendar, Google Meet,
// Zoom, etc.) sits behind one of these interfaces, and the rest of the
// module never imports a vendor SDK directly. The default adapters are
// pure-stub implementations — no network, no credentials. Real adapters
// are wired in by setting GOOGLE_CALENDAR_ENABLED / ZOOM_ENABLED env
// vars and providing the corresponding OAuth secrets.

export interface CreateCalendarEventInput {
  // Surrogate key the caller (CoachingSessionService) generates exactly
  // once per provider attempt and reuses on retries. The provider must
  // treat duplicate calls with the same key as no-ops returning the
  // existing event id.
  idempotencyKey: string;
  coachExternalAccountId: string | null;
  title: string;
  description?: string;
  startAt: Date;
  endAt: Date;
  // Email addresses of every attendee the provider should notify.
  // Empty array is valid — the provider simply does not invite anyone.
  attendeeEmails: string[];
}

export interface CalendarEventResult {
  // Provider-side event id. Stub returns a deterministic stub id so
  // tests can match without external state.
  externalEventId: string;
  // The provider that actually handled the call. Used by the service
  // layer to persist the resolved provider on the session row, since a
  // stub adapter may stand in for a misconfigured real adapter.
  resolvedProvider: 'stub' | 'google_calendar';
}

export interface CalendarProvider {
  readonly name: 'stub' | 'google_calendar';
  createEvent(input: CreateCalendarEventInput): Promise<CalendarEventResult>;
  cancelEvent(externalEventId: string): Promise<void>;
}

export interface CreateVideoLinkInput {
  idempotencyKey: string;
  coachExternalAccountId: string | null;
  title: string;
  startAt: Date;
  endAt: Date;
}

export interface VideoLinkResult {
  // The URL the client opens in their browser / app to join.
  joinUrl: string | null;
  // Provider-side meeting id (stub returns a deterministic stub).
  externalMeetingId: string;
  resolvedProvider: 'stub' | 'google_meet' | 'zoom' | 'manual';
}

export interface VideoProvider {
  readonly name: 'stub' | 'google_meet' | 'zoom' | 'manual';
  createMeeting(input: CreateVideoLinkInput): Promise<VideoLinkResult>;
  cancelMeeting(externalMeetingId: string): Promise<void>;
}
