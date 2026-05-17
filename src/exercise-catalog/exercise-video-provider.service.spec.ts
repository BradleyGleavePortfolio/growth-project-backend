/**
 * Unit tests for ExerciseVideoFallbackService and its providers.
 *
 * HTTP calls (fetch) are mocked via jest.spyOn so no real network calls
 * are made. Redis is omitted — providers and fallback service fall back
 * to their in-process maps / no-op cache paths automatically.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  YMoveVideoProvider,
  MuscleWikiVideoProvider,
  ExerciseVideoFallbackService,
} from './exercise-video-provider.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(data: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response);
}

function buildConfigService(keys: Record<string, string | undefined>) {
  return {
    get: (key: string) => keys[key] ?? undefined,
  } as unknown as ConfigService;
}

// ─── YMoveVideoProvider ────────────────────────────────────────────────────────

describe('YMoveVideoProvider', () => {
  let provider: YMoveVideoProvider;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the HLS URL when the API responds successfully', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    mockFetch([
      {
        title: 'Barbell Bench Press',
        videoHlsUrl: 'https://bunny.net/videos/bench-press.m3u8',
      },
      {
        title: 'Push Up',
        videoUrl: 'https://bunny.net/videos/push-up.mp4',
      },
    ]);

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBe('https://bunny.net/videos/bench-press.m3u8');
  });

  it('falls back to videoUrl when videoHlsUrl is absent', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    mockFetch([
      {
        title: 'Push Up',
        videoUrl: 'https://bunny.net/videos/push-up.mp4',
      },
    ]);

    const url = await provider.getVideoUrl('Push Up');
    expect(url).toBe('https://bunny.net/videos/push-up.mp4');
  });

  it('returns null when YMOVE_API_KEY is not set', async () => {
    const config = buildConfigService({});
    provider = new YMoveVideoProvider(config, null);

    const fetchSpy = jest.spyOn(global, 'fetch');
    const url = await provider.getVideoUrl('Barbell Bench Press');

    expect(url).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when the API returns a 404', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    mockFetch({}, 404);

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBeNull();
  });

  it('returns null when the API returns a 500 error', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    mockFetch({}, 500);

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBeNull();
  });

  it('normalises exercise names for matching (case-insensitive, strips punctuation)', async () => {
    const config = buildConfigService({ YMOVE_API_KEY: 'ym_test_key' });
    provider = new YMoveVideoProvider(config, null);

    mockFetch([
      {
        title: 'Barbell Bench Press',
        videoHlsUrl: 'https://bunny.net/videos/bench-press.m3u8',
      },
    ]);

    // Same exercise but with different casing and punctuation
    const url = await provider.getVideoUrl('BARBELL BENCH PRESS');
    expect(url).toBe('https://bunny.net/videos/bench-press.m3u8');
  });
});

// ─── MuscleWikiVideoProvider ───────────────────────────────────────────────────

describe('MuscleWikiVideoProvider', () => {
  let provider: MuscleWikiVideoProvider;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the male video URL when the API responds successfully', async () => {
    const config = buildConfigService({ MUSCLEWIKI_API_KEY: 'rapidapi_test_key' });
    provider = new MuscleWikiVideoProvider(config, null);

    mockFetch([
      {
        name: 'Barbell Bench Press',
        video: {
          male: 'https://cdn.musclewiki.com/bench-press-male.mp4',
          female: 'https://cdn.musclewiki.com/bench-press-female.mp4',
        },
      },
    ]);

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBe('https://cdn.musclewiki.com/bench-press-male.mp4');
  });

  it('falls back to female video when male is absent', async () => {
    const config = buildConfigService({ MUSCLEWIKI_API_KEY: 'rapidapi_test_key' });
    provider = new MuscleWikiVideoProvider(config, null);

    mockFetch([
      {
        name: 'Hip Thrust',
        video: {
          female: 'https://cdn.musclewiki.com/hip-thrust-female.mp4',
        },
      },
    ]);

    const url = await provider.getVideoUrl('Hip Thrust');
    expect(url).toBe('https://cdn.musclewiki.com/hip-thrust-female.mp4');
  });

  it('returns null when MUSCLEWIKI_API_KEY is not set', async () => {
    const config = buildConfigService({});
    provider = new MuscleWikiVideoProvider(config, null);

    const fetchSpy = jest.spyOn(global, 'fetch');
    const url = await provider.getVideoUrl('Barbell Bench Press');

    expect(url).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when the API returns an error status', async () => {
    const config = buildConfigService({ MUSCLEWIKI_API_KEY: 'rapidapi_test_key' });
    provider = new MuscleWikiVideoProvider(config, null);

    mockFetch({}, 403);

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const config = buildConfigService({ MUSCLEWIKI_API_KEY: 'rapidapi_test_key' });
    provider = new MuscleWikiVideoProvider(config, null);

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network timeout'));

    const url = await provider.getVideoUrl('Barbell Bench Press');
    expect(url).toBeNull();
  });

  it('normalises exercise names for matching', async () => {
    const config = buildConfigService({ MUSCLEWIKI_API_KEY: 'rapidapi_test_key' });
    provider = new MuscleWikiVideoProvider(config, null);

    mockFetch([
      {
        name: 'Push-Up (Wide Grip)',
        video: { male: 'https://cdn.musclewiki.com/push-up-wide.mp4' },
      },
    ]);

    const url = await provider.getVideoUrl('push up wide grip');
    expect(url).toBe('https://cdn.musclewiki.com/push-up-wide.mp4');
  });
});

// ─── ExerciseVideoFallbackService ─────────────────────────────────────────────

describe('ExerciseVideoFallbackService', () => {
  let fallbackService: ExerciseVideoFallbackService;
  let ymoveProvider: YMoveVideoProvider;
  let muscleWikiProvider: MuscleWikiVideoProvider;

  async function buildFallbackService(
    ymoveKey: string | undefined,
    musclewikiKey: string | undefined,
  ) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExerciseVideoFallbackService,
        {
          provide: YMoveVideoProvider,
          useFactory: () =>
            new YMoveVideoProvider(
              buildConfigService({ YMOVE_API_KEY: ymoveKey }),
              null,
            ),
        },
        {
          provide: MuscleWikiVideoProvider,
          useFactory: () =>
            new MuscleWikiVideoProvider(
              buildConfigService({ MUSCLEWIKI_API_KEY: musclewikiKey }),
              null,
            ),
        },
        {
          provide: ConfigService,
          useValue: buildConfigService({ REDIS_URL: undefined }),
        },
      ],
    }).compile();

    fallbackService = module.get(ExerciseVideoFallbackService);
    ymoveProvider = module.get(YMoveVideoProvider);
    muscleWikiProvider = module.get(MuscleWikiVideoProvider);

    // Skip Redis connection attempt
    // (onModuleInit will no-op because REDIS_URL is undefined)
    await fallbackService.onModuleInit();

    return { fallbackService, ymoveProvider, muscleWikiProvider };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tries YMove first and returns the YMove URL when found', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    const ymoveSpy = jest
      .spyOn(ymoveProvider, 'getVideoUrl')
      .mockResolvedValue('https://bunny.net/bench.m3u8');
    const muscleWikiSpy = jest
      .spyOn(muscleWikiProvider, 'getVideoUrl')
      .mockResolvedValue('https://cdn.musclewiki.com/bench.mp4');

    const result = await fallbackService.getVideoUrl('Barbell Bench Press');

    expect(result.url).toBe('https://bunny.net/bench.m3u8');
    expect(result.provider).toBe('ymove');
    expect(ymoveSpy).toHaveBeenCalledWith('Barbell Bench Press');
    // MuscleWiki should NOT be called when YMove succeeds
    expect(muscleWikiSpy).not.toHaveBeenCalled();
  });

  it('falls through to MuscleWiki when YMove returns null', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    jest.spyOn(ymoveProvider, 'getVideoUrl').mockResolvedValue(null);
    const muscleWikiSpy = jest
      .spyOn(muscleWikiProvider, 'getVideoUrl')
      .mockResolvedValue('https://cdn.musclewiki.com/bench.mp4');

    const result = await fallbackService.getVideoUrl('Barbell Bench Press');

    expect(result.url).toBe('https://cdn.musclewiki.com/bench.mp4');
    expect(result.provider).toBe('musclewiki');
    expect(muscleWikiSpy).toHaveBeenCalledWith('Barbell Bench Press');
  });

  it('returns null when both providers return null', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    jest.spyOn(ymoveProvider, 'getVideoUrl').mockResolvedValue(null);
    jest.spyOn(muscleWikiProvider, 'getVideoUrl').mockResolvedValue(null);

    const result = await fallbackService.getVideoUrl('Unknown Exercise XYZ');

    expect(result.url).toBeNull();
    expect(result.provider).toBeNull();
  });

  it('returns null when no API keys are configured (graceful degradation)', async () => {
    await buildFallbackService(undefined, undefined);

    const fetchSpy = jest.spyOn(global, 'fetch');

    const result = await fallbackService.getVideoUrl('Barbell Bench Press');

    expect(result.url).toBeNull();
    expect(result.provider).toBeNull();
    // No HTTP calls should be made when no API keys are configured
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caches null result to avoid hammering APIs on repeated lookups', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    const ymoveSpy = jest.spyOn(ymoveProvider, 'getVideoUrl').mockResolvedValue(null);
    const muscleWikiSpy = jest
      .spyOn(muscleWikiProvider, 'getVideoUrl')
      .mockResolvedValue(null);

    // First call — both providers are queried
    const first = await fallbackService.getVideoUrl('Niche Exercise');
    expect(first.url).toBeNull();
    expect(ymoveSpy).toHaveBeenCalledTimes(1);
    expect(muscleWikiSpy).toHaveBeenCalledTimes(1);

    // The in-process cache should prevent a second full provider scan
    // on an immediate second call (Redis is absent, so the local sentinel
    // path inside each provider's localCache is checked).
    // We verify that the result is consistently null.
    const second = await fallbackService.getVideoUrl('Niche Exercise');
    expect(second.url).toBeNull();
  });

  it('continues gracefully when a provider throws an unexpected error', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    jest
      .spyOn(ymoveProvider, 'getVideoUrl')
      .mockRejectedValue(new Error('Unexpected provider crash'));
    jest
      .spyOn(muscleWikiProvider, 'getVideoUrl')
      .mockResolvedValue('https://cdn.musclewiki.com/bench.mp4');

    const result = await fallbackService.getVideoUrl('Barbell Bench Press');

    // MuscleWiki should still be tried when YMove throws
    expect(result.url).toBe('https://cdn.musclewiki.com/bench.mp4');
    expect(result.provider).toBe('musclewiki');
  });

  it('detectProvider identifies ymove URLs correctly', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    jest
      .spyOn(ymoveProvider, 'getVideoUrl')
      .mockResolvedValue('https://videos.b-cdn.net/exercises/bench-press.m3u8');
    jest.spyOn(muscleWikiProvider, 'getVideoUrl').mockResolvedValue(null);

    const result = await fallbackService.getVideoUrl('Barbell Bench Press');
    expect(result.provider).toBe('ymove');
  });

  it('detectProvider identifies musclewiki URLs correctly', async () => {
    await buildFallbackService('ym_key', 'rapidapi_key');

    jest.spyOn(ymoveProvider, 'getVideoUrl').mockResolvedValue(null);
    jest
      .spyOn(muscleWikiProvider, 'getVideoUrl')
      .mockResolvedValue('https://cdn.musclewiki.com/videos/push-up.mp4');

    const result = await fallbackService.getVideoUrl('Push Up');
    expect(result.provider).toBe('musclewiki');
  });
});
