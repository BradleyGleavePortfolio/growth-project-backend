import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CalendarEventResult,
  CalendarProvider,
  CreateCalendarEventInput,
} from './scheduling-provider.types';

// Placeholder Google Calendar adapter. Currently a thin wrapper that
// logs the inputs and returns a stub-shaped result so the wiring is
// exercised end-to-end. The real implementation will:
//
//   1. Look up the coach's CalendarConnection row for provider=google_calendar.
//   2. Resolve the OAuth credentials from the secret store referenced
//      by `credentials_secret_ref` (NOT stored on the row itself).
//   3. Call calendar.events.insert with the resolved access token,
//      using `idempotencyKey` as the request-id header so a retry
//      replays the same call.
//
// Until those pieces land, this adapter is opt-in: the registry only
// returns it when GOOGLE_CALENDAR_ENABLED=true, otherwise the stub.
@Injectable()
export class GoogleCalendarAdapter implements CalendarProvider {
  readonly name = 'google_calendar' as const;
  private readonly logger = new Logger(GoogleCalendarAdapter.name);

  async createEvent(
    input: CreateCalendarEventInput,
  ): Promise<CalendarEventResult> {
    // QA P0-S1. Mirror GoogleMeetAdapter / ZoomVideoAdapter — fail loud
    // rather than silently persist a `gcal-pending-<key>` external id that
    // every downstream surface (audit, sync job, cancellation path) would
    // then treat as a real Google event id.
    this.logger.error(
      `GoogleCalendarAdapter.createEvent called but real implementation is not wired up; idempotencyKey=${input.idempotencyKey}`,
    );
    throw new ServiceUnavailableException({
      error: 'CALENDAR_PROVIDER_NOT_IMPLEMENTED',
      provider: 'google_calendar',
      message:
        'Google Calendar integration is enabled but the real adapter has not shipped. Set GOOGLE_CALENDAR_ENABLED=false to route through the stub provider, or wait for the real adapter.',
    });
  }

  async cancelEvent(externalEventId: string): Promise<void> {
    this.logger.warn(
      `GoogleCalendarAdapter.cancelEvent called but real implementation is not wired up yet — no-op for ${externalEventId}`,
    );
  }
}
