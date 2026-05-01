import { Injectable, Logger } from '@nestjs/common';
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
    this.logger.warn(
      `GoogleCalendarAdapter.createEvent called but real implementation is not wired up yet — returning stub-shaped event for idempotencyKey=${input.idempotencyKey}`,
    );
    return {
      externalEventId: `gcal-pending-${input.idempotencyKey}`,
      resolvedProvider: 'google_calendar',
    };
  }

  async cancelEvent(externalEventId: string): Promise<void> {
    this.logger.warn(
      `GoogleCalendarAdapter.cancelEvent called but real implementation is not wired up yet — no-op for ${externalEventId}`,
    );
  }
}
