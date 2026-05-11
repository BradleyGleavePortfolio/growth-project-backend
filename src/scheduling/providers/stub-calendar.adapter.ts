import { Injectable } from '@nestjs/common';
import {
  CalendarEventResult,
  CalendarProvider,
  CreateCalendarEventInput,
} from './scheduling-provider.types';

// Default calendar adapter — never makes a network call, never reads a
// credential. Returns a deterministic event id derived from the
// idempotency key so retries with the same key produce the same id and
// downstream tests can assert on the value.
//
// When GOOGLE_CALENDAR_ENABLED=true and OAuth creds are wired up, the
// provider registry returns the real adapter instead. Until then, every
// session is "scheduled" with the stub and the coach attaches a manual
// link via the dedicated endpoint.
@Injectable()
export class StubCalendarAdapter implements CalendarProvider {
  readonly name = 'stub' as const;

  async createEvent(
    input: CreateCalendarEventInput,
  ): Promise<CalendarEventResult> {
    return {
      externalEventId: `stub-cal-${input.idempotencyKey}`,
      resolvedProvider: 'stub',
    };
  }

  async cancelEvent(_externalEventId: string): Promise<void> {
    // No-op. The stub does not track state; cancellation is recorded on
    // the CoachingSession row by the service layer.
  }
}
