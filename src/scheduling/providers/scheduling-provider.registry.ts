import { Injectable, Logger } from '@nestjs/common';
import { CalendarProvider as CalendarProviderEnum, VideoProvider as VideoProviderEnum } from '@prisma/client';
import { GoogleCalendarAdapter } from './google-calendar.adapter';
import { GoogleMeetAdapter } from './google-meet.adapter';
import { StubCalendarAdapter } from './stub-calendar.adapter';
import { StubVideoAdapter } from './stub-video.adapter';
import {
  CalendarProvider,
  VideoProvider,
} from './scheduling-provider.types';
import { ZoomVideoAdapter } from './zoom-video.adapter';

// SchedulingProviderRegistry resolves a Prisma enum value
// (CalendarProvider / VideoProvider) to the live adapter instance the
// service layer should call. The mapping is deliberately defensive:
//
//   - If a real adapter is requested but the corresponding _ENABLED
//     env var is not "true", the registry returns the stub instead and
//     logs a one-line warning. This means a mis-set provider on a row
//     never causes a 500 — the worst case is "session got a stub link".
//   - The `manual` video provider has no adapter; the service layer
//     short-circuits before reaching the registry for it.
//
// Provider-feature-flag env reads happen once at construction. To pick
// up a flag flip you must redeploy.
@Injectable()
export class SchedulingProviderRegistry {
  private readonly logger = new Logger(SchedulingProviderRegistry.name);
  private readonly googleCalendarEnabled: boolean;
  private readonly googleMeetEnabled: boolean;
  private readonly zoomEnabled: boolean;

  constructor(
    private readonly stubCalendar: StubCalendarAdapter,
    private readonly googleCalendar: GoogleCalendarAdapter,
    private readonly stubVideo: StubVideoAdapter,
    private readonly googleMeet: GoogleMeetAdapter,
    private readonly zoom: ZoomVideoAdapter,
  ) {
    this.googleCalendarEnabled = process.env.GOOGLE_CALENDAR_ENABLED === 'true';
    this.googleMeetEnabled = process.env.GOOGLE_MEET_ENABLED === 'true';
    this.zoomEnabled = process.env.ZOOM_ENABLED === 'true';
  }

  resolveCalendar(provider: CalendarProviderEnum): CalendarProvider {
    if (provider === 'google_calendar') {
      if (!this.googleCalendarEnabled) {
        this.logger.warn(
          'google_calendar requested but GOOGLE_CALENDAR_ENABLED is not "true" — falling back to stub adapter',
        );
        return this.stubCalendar;
      }
      return this.googleCalendar;
    }
    return this.stubCalendar;
  }

  resolveVideo(provider: VideoProviderEnum): VideoProvider {
    if (provider === 'google_meet') {
      if (!this.googleMeetEnabled) {
        this.logger.warn(
          'google_meet requested but GOOGLE_MEET_ENABLED is not "true" — falling back to stub adapter',
        );
        return this.stubVideo;
      }
      return this.googleMeet;
    }
    if (provider === 'zoom') {
      if (!this.zoomEnabled) {
        this.logger.warn(
          'zoom requested but ZOOM_ENABLED is not "true" — falling back to stub adapter',
        );
        return this.stubVideo;
      }
      return this.zoom;
    }
    // 'manual' is handled by the service before reaching the registry,
    // but if it leaks through we still fall through to the stub rather
    // than throwing — keeps the call site simple.
    return this.stubVideo;
  }
}
