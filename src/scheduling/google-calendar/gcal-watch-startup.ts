import { Logger } from '@nestjs/common';

// Boot-time assertion for Google Calendar push-notification watch channels.
//
// Context (RFC-142 follow-up to PR #241): the webhook controller now
// returns structured errors and 404s the surface when the feature flag is
// off. That's the right contract for the request path, but it leaves a
// gap at boot: if an operator flips on watch channels in production
// without setting the required env vars (token, public base URL), the
// app would happily start and only fail per-request when Google posts
// the first push — minutes later, in the audit log, with no clear boot
// signal. RFC-142 Rule 9 calls that out as "silent runtime surprise".
//
// This module closes that gap. It is invoked from SchedulingModule's
// onModuleInit and:
//
//   * When GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED is unset/false:
//     emits a single info-level boot line so operators know on every
//     boot that watch channels are NOT live. No assertions run.
//
//   * When GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED is true:
//     asserts the required env vars are present (channel token + the
//     public base URL Google will POST back to) and runs a short
//     reachability probe against the webhook URL. Any failure throws
//     a structured Error whose message names exactly what's missing.
//     The thrown Error halts boot — same posture as assertEnv() for
//     hard-tier vars.
//
// The reachability probe is intentionally narrow: we only require that
// the public base URL responds to a HEAD/GET (any 2xx/3xx/4xx is fine —
// even 404 means the host is up). We don't require the webhook path
// itself to be reachable from the booting process, because that path is
// fronted by the same load balancer that's about to route Google's
// POSTs. The probe defends against a typo'd hostname or a DNS record
// that hasn't propagated; it does NOT try to authenticate.

export interface GcalWatchStartupEnv {
  GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED?: string;
  GOOGLE_CALENDAR_WEBHOOK_TOKEN?: string;
  GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL?: string;
  FEATURE_GOOGLE_CALENDAR_SYNC?: string;
  NODE_ENV?: string;
}

export interface GcalWatchStartupOptions {
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  // Injected fetch for tests. Defaults to globalThis.fetch.
  fetchImpl?: typeof fetch;
  // Reachability probe timeout. Defaults to 3000ms; kept short so a
  // misconfigured base URL doesn't block boot for long.
  probeTimeoutMs?: number;
}

function isFlagTrue(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value.trim());
}

export async function assertGcalWatchChannelStartup(
  env: GcalWatchStartupEnv = process.env as GcalWatchStartupEnv,
  opts: GcalWatchStartupOptions = {},
): Promise<void> {
  const logger = opts.logger ?? new Logger('GoogleCalendarWatchStartup');
  const enabled = isFlagTrue(env.GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED);

  if (!enabled) {
    logger.log(
      'Google Calendar watch channels are OFF (GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED unset/false). ' +
        'Webhook controller is mounted but no push notifications are expected.',
    );
    return;
  }

  // When watch channels are on the parent feature flag MUST also be on —
  // otherwise the webhook controller would return 404 FEATURE_DISABLED
  // for every Google POST while we believe channels are live.
  if (!isFlagTrue(env.FEATURE_GOOGLE_CALENDAR_SYNC)) {
    throw new Error(
      'GCAL_WATCH_CHANNELS_MISCONFIGURED: GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED=true but ' +
        'FEATURE_GOOGLE_CALENDAR_SYNC is not "true". The webhook controller will 404 every push. ' +
        'Either enable the parent flag or disable watch channels.',
    );
  }

  const missing: string[] = [];
  const token = env.GOOGLE_CALENDAR_WEBHOOK_TOKEN?.trim();
  if (!token) missing.push('GOOGLE_CALENDAR_WEBHOOK_TOKEN');
  const baseUrl = env.GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) missing.push('GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL');

  if (missing.length) {
    throw new Error(
      `GCAL_WATCH_CHANNELS_MISCONFIGURED: required env vars are missing: ${missing.join(', ')}. ` +
        'Set them before enabling GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED=true, or disable watch channels.',
    );
  }

  if (!isHttpUrl(baseUrl!)) {
    throw new Error(
      'GCAL_WATCH_CHANNELS_MISCONFIGURED: GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL must be an absolute http(s) URL.',
    );
  }

  // Skip the live reachability probe under NODE_ENV=test — tests set
  // env vars in-process and don't run a real server.
  if ((env.NODE_ENV ?? '').toLowerCase() === 'test') {
    logger.log(
      'Google Calendar watch channels are ON (test mode — reachability probe skipped).',
    );
    return;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'GCAL_WATCH_CHANNELS_MISCONFIGURED: no fetch implementation available for the reachability probe.',
    );
  }

  const timeoutMs = opts.probeTimeoutMs ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseUrl!, {
      method: 'GET',
      signal: controller.signal,
    });
    // Any HTTP response — even 404/405 — proves the host is up and the
    // public URL resolves. A network/DNS failure throws below.
    logger.log(
      `Google Calendar watch channels are ON. Public base URL reachable (HTTP ${res.status}).`,
    );
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    throw new Error(
      `GCAL_WATCH_CHANNELS_MISCONFIGURED: reachability probe of ` +
        `GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL failed within ${timeoutMs}ms: ${reason}. ` +
        'Verify DNS, TLS, and that the public URL routes to this deploy before enabling watch channels.',
    );
  } finally {
    clearTimeout(timer);
  }
}
