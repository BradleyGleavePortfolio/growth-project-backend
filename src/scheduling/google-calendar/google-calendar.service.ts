import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, AuditService } from '../../audit/audit.service';
import { GoogleOAuthService } from '../google-oauth/google-oauth.service';

// GoogleCalendarService — minimal but complete REST client for the
// Google Calendar API. Concierge scheduling (PR #142 follow-up).
//
// Posture:
//   - `protected fetchImpl` test seam so tests subclass + stub without
//     monkey-patching globalThis.fetch. Matches GoogleOAuthService.
//   - Methods return discriminated outcome unions; the service never
//     throws on a Google-side failure. The caller routes on `kind`.
//   - One retry on 5xx and on network errors. NO retry on 4xx, with
//     one exception: 401 triggers a refresh + ONE retry.
//   - 30s timeout per call via AbortController.
//   - Audit rows on mutating calls only (create/update/delete/watch/
//     stop). Read endpoints (freeBusy, getValidAccessToken) do not
//     write audit rows — they are too chatty.
//
// What is intentionally deferred to a follow-up PR:
//   - KMS-wrapped refresh-token storage at rest (BloodworkPanel pointer
//     columns exist; the helper that fills them does not).
//   - Persisted access_token + expires_at columns on CalendarConnection
//     (today: in-process cache, same posture as the OAuth dev-stash).
//   - Real push-notification sync logic (this PR adds the watch+stop
//     calls and the webhook endpoint, but the receiver dispatches to a
//     no-op trigger).

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_TIMEOUT_MS = 30_000;
const ACCESS_TOKEN_SKEW_MS = 60_000; // refresh 60s early

// ─── Connection shape ───────────────────────────────────────────────
// We type only the fields the adapter needs. The full CalendarConnection
// Prisma row carries `provider`, `disconnected_at`, etc. that this
// service does not consume.
export interface CalendarConnectionRef {
  /** CalendarConnection.id */
  id: string;
  /** User.id that owns the connection. */
  user_id: string;
  /** Google account email (CalendarConnection.external_account_id). */
  external_account_id: string;
}

// ─── Inputs ─────────────────────────────────────────────────────────
export interface BusyBlockQuery {
  timeMin: string; // ISO 8601
  timeMax: string;
}

export interface BusyBlock {
  start: string;
  end: string;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  attendees?: { email: string }[];
  // Caller-supplied; the adapter forwards this to Calendar's
  // requestId so a transient retry does not double-create.
  idempotencyKey: string;
}

export interface UpdateEventInput {
  summary?: string;
  description?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
}

export interface WatchInput {
  channelId: string;
  webhookUrl: string;
}

// ─── Outcomes ───────────────────────────────────────────────────────
// Discriminated unions: callers always switch on `kind`, never throw.
//   ok               — Google returned 2xx with the expected body.
//   needs_reauth     — 401 after refresh; the user must re-link.
//   transient_error  — 5xx / network / timeout after the one retry.
//   permanent_error  — non-401 4xx; Google rejected the request.
//   not_configured   — env vars unset; OAuth disabled on this deploy.
export type CalendarOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'needs_reauth'; detail?: string }
  | { kind: 'transient_error'; status?: number; detail?: string }
  | { kind: 'permanent_error'; status: number; detail?: string }
  | { kind: 'not_configured' };

export interface CalendarEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  summary?: string;
  [key: string]: unknown;
}

export interface WatchResponse {
  id: string; // channel id
  resourceId: string;
  resourceUri?: string;
  expiration?: string;
}

// ─── In-process access-token cache ──────────────────────────────────
// Keyed by CalendarConnection.id so multiple users do not collide.
// Cleared on process restart by design — the follow-up that adds
// persisted access_token + expires_at columns replaces this.
interface CachedToken {
  access_token: string;
  expires_at_ms: number;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly tokenCache = new Map<string, CachedToken>();

  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly audit: AuditService,
  ) {}

  // ─── Public API ───────────────────────────────────────────────────

  async listBusyBlocks(
    connection: CalendarConnectionRef,
    query: BusyBlockQuery,
  ): Promise<CalendarOutcome<BusyBlock[]>> {
    return this.request<BusyBlock[]>({
      connection,
      method: 'POST',
      path: '/freeBusy',
      body: {
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        items: [{ id: 'primary' }],
      },
      parse: (raw) => {
        const obj = raw as {
          calendars?: { primary?: { busy?: BusyBlock[] } };
        };
        return obj.calendars?.primary?.busy ?? [];
      },
    });
  }

  async createEvent(
    connection: CalendarConnectionRef,
    params: CreateEventInput,
  ): Promise<CalendarOutcome<CalendarEvent>> {
    const outcome = await this.request<CalendarEvent>({
      connection,
      method: 'POST',
      path: `/calendars/primary/events?conferenceDataVersion=0&requestId=${encodeURIComponent(params.idempotencyKey)}`,
      body: {
        summary: params.summary,
        description: params.description,
        start: params.start,
        end: params.end,
        attendees: params.attendees,
      },
      parse: (raw) => raw as CalendarEvent,
    });
    if (outcome.kind === 'ok') {
      await this.auditWrite(
        connection,
        AuditAction.CALENDAR_EVENT_CREATED,
        { event_id: outcome.data.id, idempotency_key: params.idempotencyKey },
      );
    }
    return outcome;
  }

  async updateEvent(
    connection: CalendarConnectionRef,
    eventId: string,
    params: UpdateEventInput,
  ): Promise<CalendarOutcome<CalendarEvent>> {
    const outcome = await this.request<CalendarEvent>({
      connection,
      method: 'PATCH',
      path: `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      body: params,
      parse: (raw) => raw as CalendarEvent,
    });
    if (outcome.kind === 'ok') {
      await this.auditWrite(
        connection,
        AuditAction.CALENDAR_EVENT_UPDATED,
        { event_id: eventId },
      );
    }
    return outcome;
  }

  async deleteEvent(
    connection: CalendarConnectionRef,
    eventId: string,
  ): Promise<CalendarOutcome<null>> {
    const outcome = await this.request<null>({
      connection,
      method: 'DELETE',
      path: `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      parse: () => null,
      expectEmptyBody: true,
    });
    if (outcome.kind === 'ok') {
      await this.auditWrite(
        connection,
        AuditAction.CALENDAR_EVENT_DELETED,
        { event_id: eventId },
      );
    }
    return outcome;
  }

  async watchCalendar(
    connection: CalendarConnectionRef,
    input: WatchInput,
  ): Promise<CalendarOutcome<WatchResponse>> {
    const outcome = await this.request<WatchResponse>({
      connection,
      method: 'POST',
      path: '/calendars/primary/events/watch',
      body: {
        id: input.channelId,
        type: 'web_hook',
        address: input.webhookUrl,
      },
      parse: (raw) => raw as WatchResponse,
    });
    if (outcome.kind === 'ok') {
      await this.auditWrite(
        connection,
        AuditAction.CALENDAR_WATCH_STARTED,
        {
          channel_id: outcome.data.id,
          resource_id: outcome.data.resourceId,
        },
      );
    }
    return outcome;
  }

  async stopWatch(
    connection: CalendarConnectionRef,
    channelId: string,
    resourceId: string,
  ): Promise<CalendarOutcome<null>> {
    const outcome = await this.request<null>({
      connection,
      method: 'POST',
      // /channels/stop lives at the root, not /calendar/v3 — but the
      // base URL is fine because we let `path` start with /channels/...
      // and the request helper concatenates without modification.
      path: '/channels/stop',
      body: { id: channelId, resourceId },
      parse: () => null,
      expectEmptyBody: true,
    });
    if (outcome.kind === 'ok') {
      await this.auditWrite(
        connection,
        AuditAction.CALENDAR_WATCH_STOPPED,
        { channel_id: channelId, resource_id: resourceId },
      );
    }
    return outcome;
  }

  // ─── Token management ────────────────────────────────────────────

  // Returns the cached access token if it has at least ACCESS_TOKEN_SKEW_MS
  // of life remaining; otherwise calls refreshAccessToken.
  async getValidAccessToken(
    connection: CalendarConnectionRef,
  ): Promise<CalendarOutcome<string>> {
    const cached = this.tokenCache.get(connection.id);
    if (cached && cached.expires_at_ms - ACCESS_TOKEN_SKEW_MS > Date.now()) {
      return { kind: 'ok', data: cached.access_token };
    }
    return this.refreshAccessToken(connection);
  }

  // Refreshes via GoogleOAuthService.refreshAccessToken and caches the
  // new access token in process. Returns the new token on success or
  // `needs_reauth` if Google rejected the refresh (the user must
  // re-link).
  async refreshAccessToken(
    connection: CalendarConnectionRef,
  ): Promise<CalendarOutcome<string>> {
    if (!this.oauth.isConfigured()) {
      return { kind: 'not_configured' };
    }
    try {
      const tokens = await this.oauth.refreshAccessToken({
        userId: connection.user_id,
      });
      const expiresAtMs = Date.now() + tokens.expires_in * 1000;
      this.tokenCache.set(connection.id, {
        access_token: tokens.access_token,
        expires_at_ms: expiresAtMs,
      });
      return { kind: 'ok', data: tokens.access_token };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Google refresh failed for connection=${connection.id}: ${message}`,
      );
      return { kind: 'needs_reauth', detail: message };
    }
  }

  // Visible for tests. Clears the in-process token cache.
  clearTokenCache(): void {
    this.tokenCache.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async request<T>(args: {
    connection: CalendarConnectionRef;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    parse: (raw: unknown) => T;
    expectEmptyBody?: boolean;
  }): Promise<CalendarOutcome<T>> {
    if (!this.oauth.isConfigured()) {
      return { kind: 'not_configured' };
    }
    const tokenOutcome = await this.getValidAccessToken(args.connection);
    if (tokenOutcome.kind !== 'ok') {
      return tokenOutcome;
    }

    // First attempt
    const first = await this.attempt<T>({
      ...args,
      accessToken: tokenOutcome.data,
    });

    // 401: force refresh + one retry
    if (first.kind === 'permanent_error' && first.status === 401) {
      const refreshed = await this.refreshAccessToken(args.connection);
      if (refreshed.kind !== 'ok') return refreshed;
      return this.attempt<T>({ ...args, accessToken: refreshed.data });
    }

    // 5xx or network: ONE retry, no backoff (the caller controls cadence).
    if (first.kind === 'transient_error') {
      return this.attempt<T>({ ...args, accessToken: tokenOutcome.data });
    }

    return first;
  }

  private async attempt<T>(args: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    parse: (raw: unknown) => T;
    accessToken: string;
    expectEmptyBody?: boolean;
  }): Promise<CalendarOutcome<T>> {
    const url = `${CALENDAR_API_BASE}${args.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${args.accessToken}`,
        Accept: 'application/json',
      };
      const init: RequestInit = {
        method: args.method,
        headers,
        signal: controller.signal,
      };
      if (args.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(args.body);
      }
      const res = await this.fetchImpl(url, init);
      const status = res.status;
      const rawText = args.expectEmptyBody ? '' : await res.text();

      if (status === 204 || args.expectEmptyBody) {
        if (status >= 200 && status < 300) {
          return { kind: 'ok', data: args.parse(null) };
        }
      }

      if (status >= 200 && status < 300) {
        let parsed: unknown = null;
        if (rawText.length > 0) {
          try {
            parsed = JSON.parse(rawText);
          } catch {
            return {
              kind: 'transient_error',
              status,
              detail: 'malformed JSON',
            };
          }
        }
        return { kind: 'ok', data: args.parse(parsed) };
      }

      const detail = rawText.slice(0, 256);
      if (status === 401) {
        return { kind: 'permanent_error', status, detail };
      }
      if (status >= 500) {
        return { kind: 'transient_error', status, detail };
      }
      // 4xx other than 401
      return { kind: 'permanent_error', status, detail };
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name ?? '';
      const message = err instanceof Error ? err.message : String(err);
      if (name === 'AbortError') {
        return { kind: 'transient_error', detail: `timeout (${DEFAULT_TIMEOUT_MS}ms)` };
      }
      return { kind: 'transient_error', detail: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private async auditWrite(
    connection: CalendarConnectionRef,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.write({
        action,
        actorId: connection.user_id,
        targetId: connection.id,
        targetType: 'CalendarConnection',
        metadata,
      });
    } catch (err) {
      // Audit failure must never break the user-visible call.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Audit write failed action=${action} connection=${connection.id}: ${message}`,
      );
    }
  }
}
