import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';

describe('Scheduling provider stubs', () => {
  it('StubCalendarAdapter returns a deterministic event id from the idempotency key', async () => {
    const adapter = new StubCalendarAdapter();
    const result = await adapter.createEvent({
      idempotencyKey: 'fixed-key-1',
      coachExternalAccountId: null,
      title: 'Check-in',
      startAt: new Date('2026-06-01T15:00:00Z'),
      endAt: new Date('2026-06-01T15:30:00Z'),
      attendeeEmails: [],
    });
    expect(result.externalEventId).toBe('stub-cal-fixed-key-1');
    expect(result.resolvedProvider).toBe('stub');
  });

  it('StubVideoAdapter returns a tgp-stub:// URL', async () => {
    const adapter = new StubVideoAdapter();
    const result = await adapter.createMeeting({
      idempotencyKey: 'fixed-key-2',
      coachExternalAccountId: null,
      title: 'Check-in',
      startAt: new Date(),
      endAt: new Date(),
    });
    expect(result.joinUrl).toBe('tgp-stub://session/fixed-key-2');
    expect(result.resolvedProvider).toBe('stub');
  });
});

describe('SchedulingProviderRegistry', () => {
  function build() {
    return new SchedulingProviderRegistry(
      new StubCalendarAdapter(),
      new GoogleCalendarAdapter(),
      new StubVideoAdapter(),
      new GoogleMeetAdapter(),
      new ZoomVideoAdapter(),
    );
  }

  // The registry is the single chokepoint that prevents accidental
  // network calls when env flags are unset. The default state of the
  // process under test must be "all real adapters disabled" — verify
  // that explicitly so a future refactor can't silently enable Google.
  it('falls back to stub when GOOGLE_CALENDAR_ENABLED is not set', () => {
    delete process.env.GOOGLE_CALENDAR_ENABLED;
    const reg = build();
    expect(reg.resolveCalendar('google_calendar').name).toBe('stub');
  });

  it('returns the real Google Calendar adapter when GOOGLE_CALENDAR_ENABLED=true', () => {
    process.env.GOOGLE_CALENDAR_ENABLED = 'true';
    const reg = build();
    expect(reg.resolveCalendar('google_calendar').name).toBe('google_calendar');
    delete process.env.GOOGLE_CALENDAR_ENABLED;
  });

  it('falls back to stub video when ZOOM_ENABLED is not set', () => {
    delete process.env.ZOOM_ENABLED;
    const reg = build();
    expect(reg.resolveVideo('zoom').name).toBe('stub');
  });

  it('falls back to stub video when GOOGLE_MEET_ENABLED is not set', () => {
    delete process.env.GOOGLE_MEET_ENABLED;
    const reg = build();
    expect(reg.resolveVideo('google_meet').name).toBe('stub');
  });

  it('routes manual to stub (manual is handled at service layer)', () => {
    const reg = build();
    expect(reg.resolveVideo('manual').name).toBe('stub');
  });
});
