// test/gcal-watch-startup.spec.ts
//
// Boot-time assertion for Google Calendar watch channels (RFC-142
// follow-up to PR #241). The assertion module has no DI surface — it
// reads env directly and accepts an injected fetch impl + logger.
//
// Cases:
//   1. Disabled flag → no-op, logs single info line.
//   2. Enabled + missing TOKEN → throws GCAL_WATCH_CHANNELS_MISCONFIGURED.
//   3. Enabled + missing BASE_URL → throws GCAL_WATCH_CHANNELS_MISCONFIGURED.
//   4. Enabled + bad base URL shape → throws structured error.
//   5. Enabled + parent feature flag off → throws.
//   6. Enabled + all config present (NODE_ENV=test) → resolves, no probe.
//   7. Enabled + reachability probe fails (network error) → throws with reason.

import { assertGcalWatchChannelStartup } from '../src/scheduling/google-calendar/gcal-watch-startup';

function silentLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('assertGcalWatchChannelStartup', () => {
  it('no-ops and logs info when watch channels are disabled', async () => {
    const logger = silentLogger();
    await expect(
      assertGcalWatchChannelStartup(
        { GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'false', NODE_ENV: 'test' },
        { logger },
      ),
    ).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toMatch(/watch channels are OFF/i);
  });

  it('no-ops when the flag is entirely unset (default posture)', async () => {
    const logger = silentLogger();
    await expect(
      assertGcalWatchChannelStartup({ NODE_ENV: 'test' }, { logger }),
    ).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/OFF/));
  });

  it('throws when enabled without GOOGLE_CALENDAR_WEBHOOK_TOKEN', async () => {
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'https://example.com/webhooks/google-calendar',
          NODE_ENV: 'test',
        },
        { logger: silentLogger() },
      ),
    ).rejects.toThrow(/GCAL_WATCH_CHANNELS_MISCONFIGURED.*GOOGLE_CALENDAR_WEBHOOK_TOKEN/);
  });

  it('throws when enabled without GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL', async () => {
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          NODE_ENV: 'test',
        },
        { logger: silentLogger() },
      ),
    ).rejects.toThrow(
      /GCAL_WATCH_CHANNELS_MISCONFIGURED.*GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL/,
    );
  });

  it('throws when the base URL is not an absolute http(s) URL', async () => {
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'not-a-url',
          NODE_ENV: 'test',
        },
        { logger: silentLogger() },
      ),
    ).rejects.toThrow(/must be an absolute http\(s\) URL/);
  });

  it('throws when watch channels are enabled but FEATURE_GOOGLE_CALENDAR_SYNC is off', async () => {
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'false',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'https://example.com',
          NODE_ENV: 'test',
        },
        { logger: silentLogger() },
      ),
    ).rejects.toThrow(/FEATURE_GOOGLE_CALENDAR_SYNC/);
  });

  it('resolves when all config is present (test mode skips reachability probe)', async () => {
    const logger = silentLogger();
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'https://example.com/webhooks/google-calendar',
          NODE_ENV: 'test',
        },
        { logger },
      ),
    ).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/test mode/i));
  });

  it('uses the injected fetch impl when probing under non-test NODE_ENV', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 404 }) as Response);
    const logger = silentLogger();
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'https://example.com',
          NODE_ENV: 'production',
        },
        { logger, fetchImpl: fetchImpl as unknown as typeof fetch, probeTimeoutMs: 250 },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/reachable.*HTTP 404/i));
  });

  it('throws a structured error when the reachability probe fails', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND example.invalid');
    });
    await expect(
      assertGcalWatchChannelStartup(
        {
          GOOGLE_CALENDAR_WATCH_CHANNELS_ENABLED: 'true',
          FEATURE_GOOGLE_CALENDAR_SYNC: 'true',
          GOOGLE_CALENDAR_WEBHOOK_TOKEN: 'shared-secret',
          GOOGLE_CALENDAR_WEBHOOK_PUBLIC_BASE_URL: 'https://example.invalid',
          NODE_ENV: 'production',
        },
        {
          logger: silentLogger(),
          fetchImpl: fetchImpl as unknown as typeof fetch,
          probeTimeoutMs: 250,
        },
      ),
    ).rejects.toThrow(/reachability probe.*failed.*ENOTFOUND/);
  });
});
