/**
 * ExerciseVideoProviderService — multi-source exercise video lookup with
 * Redis cache and graceful degradation.
 *
 * Priority order:
 *   1. YMove API   — HLS streaming via Bunny CDN (preferred)
 *   2. MuscleWiki  — MP4 video demonstrations
 *   3. null        — caller falls back to ExerciseDB GIF
 *
 * IMPORTANT — YMove URL expiry:
 *   YMove v2 returns **pre-signed URLs that expire after 48 hours**.
 *   Per their docs, these must NOT be stored long-term or cached beyond
 *   the signing window. We intentionally use a short Redis TTL (3 hours)
 *   so clients always get a fresh signed URL well within the expiry window.
 *   The ExerciseCatalogItem.video_url column stores ONLY MuscleWiki URLs
 *   (which are stable CDN URLs) or a sentinel indicating "has YMove coverage"
 *   — not the signed URL itself. The enrichment script records which
 *   exercises have video coverage (via `has_video_provider` boolean) rather
 *   than caching the transient signed URL.
 *
 * MuscleWiki URL stability:
 *   MuscleWiki MP4 URLs are stable CDN paths. These can be stored and
 *   cached with a 24-hour TTL.
 *
 * Name normalisation:
 *   Both providers are matched by normalised name: lowercase, strip all
 *   non-alphanumeric characters, collapse spaces. Providers return their
 *   full exercise list which is fetched once and cached in Redis for
 *   12 hours (provider catalog TTL). Per-exercise lookups then hit the
 *   cache directly.
 *
 * Env vars (all optional — features degrade gracefully when absent):
 *   YMOVE_API_KEY       — YMove v2 API key (prefix: ym_)
 *   MUSCLEWIKI_API_KEY  — MuscleWiki API key (RapidAPI header)
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── Normalisation ────────────────────────────────────────────────────────

/**
 * Normalise an exercise name for fuzzy matching across providers.
 * e.g. "Barbell Bench Press" → "barbell bench press"
 *      "Push-Up (Wide)" → "push up wide"
 */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Provider interface ───────────────────────────────────────────────────

export interface IExerciseVideoProvider {
  readonly name: string;
  /**
   * Return the video URL for the given exercise name, or null when the
   * provider has no match or is unconfigured.
   */
  getVideoUrl(exerciseName: string): Promise<string | null>;
}

// ─── YMove provider ───────────────────────────────────────────────────────

/**
 * YMoveVideoProvider — calls the YMove v2 API.
 *
 * API: https://exercise-api.ymove.app/api/v2
 * Auth: X-API-Key header
 *
 * Returns HLS URL (`videoHlsUrl`) when present, falls back to MP4
 * (`videoUrl`). URLs are pre-signed and expire after 48 hours — the
 * Redis TTL (3h) is set well within this window so callers always
 * get a valid URL.
 *
 * The provider fetches the full exercise catalog once and builds a
 * normalised-name → URL map. That map is kept in Redis (TTL: 3h) so
 * it survives process restarts and is shared across Fly machines.
 *
 * Monthly exercise cap: YMove caps unique exercises accessed per month.
 * When the cap is exceeded, `videoHlsUrl`/`videoUrl` are omitted from
 * new exercises. The provider handles missing video fields gracefully.
 */
@Injectable()
export class YMoveVideoProvider implements IExerciseVideoProvider {
  readonly name = 'ymove';
  private readonly logger = new Logger(YMoveVideoProvider.name);
  private readonly apiKey: string | null;
  private readonly baseUrl = 'https://exercise-api.ymove.app/api/v2';

  // In-process fallback map (used when Redis is absent).
  private localCache: Map<string, string> | null = null;
  private localCacheExpiresAt = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  private static readonly CATALOG_CACHE_KEY = 'exercise_video:ymove:catalog_v2';
  private static readonly CATALOG_TTL_SEC = 3 * 60 * 60; // 3 hours (well within 48h expiry)

  constructor(
    private readonly config: ConfigService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisClient: any | null,
  ) {
    this.apiKey = this.config.get<string>('YMOVE_API_KEY') ?? null;
    this.redis = redisClient;
  }

  async getVideoUrl(exerciseName: string): Promise<string | null> {
    if (!this.apiKey) return null;
    const key = normaliseName(exerciseName);
    const catalog = await this.getCatalog();
    return catalog.get(key) ?? null;
  }

  /**
   * Fetch (or return from cache) a map of normalised-name → video URL.
   * Fetches ALL exercises from YMove in a single call — their API
   * returns up to 1000 results per request; 698 exercises fit in one page.
   */
  private async getCatalog(): Promise<Map<string, string>> {
    // 1. Try Redis
    if (this.redis) {
      try {
        const raw = await this.redis.get(YMoveVideoProvider.CATALOG_CACHE_KEY);
        if (raw) {
          const obj = JSON.parse(raw) as Record<string, string>;
          return new Map(Object.entries(obj));
        }
      } catch (err) {
        this.logger.warn('YMove: Redis read failed, falling back to API fetch', err);
      }
    }

    // 2. In-process fallback
    if (this.localCache && Date.now() < this.localCacheExpiresAt) {
      return this.localCache;
    }

    // 3. Fetch from YMove API
    return this.fetchAndCache();
  }

  private async fetchAndCache(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/exercises?includeVideos=true&limit=1000`;
      const res = await fetch(url, {
        headers: {
          'X-API-Key': this.apiKey!,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        this.logger.warn(`YMove catalog fetch failed: ${res.status} ${res.statusText}`);
        return map;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      const exercises = Array.isArray(data) ? data : (data.exercises ?? data.data ?? []);

      for (const ex of exercises) {
        const name = ex.title ?? ex.name ?? '';
        if (!name) continue;
        // Prefer HLS, fall back to MP4.
        const videoUrl: string | undefined =
          ex.videoHlsUrl ?? ex.videoUrl ?? undefined;
        if (!videoUrl) continue;
        map.set(normaliseName(name), videoUrl);
      }

      this.logger.log(`YMove: cached ${map.size} exercises with video URLs`);

      // Persist to Redis and local
      const obj = Object.fromEntries(map);
      if (this.redis) {
        try {
          await this.redis.setex(
            YMoveVideoProvider.CATALOG_CACHE_KEY,
            YMoveVideoProvider.CATALOG_TTL_SEC,
            JSON.stringify(obj),
          );
        } catch (err) {
          this.logger.warn('YMove: Redis write failed', err);
        }
      }

      this.localCache = map;
      this.localCacheExpiresAt = Date.now() + YMoveVideoProvider.CATALOG_TTL_SEC * 1000;
    } catch (err) {
      this.logger.warn('YMove: Failed to fetch exercise catalog', err);
    }
    return map;
  }
}

// ─── MuscleWiki provider ──────────────────────────────────────────────────

/**
 * MuscleWikiVideoProvider — calls the MuscleWiki API (RapidAPI-hosted).
 *
 * Endpoint: GET /exercises  (returns all exercises)
 * Auth: X-RapidAPI-Key header + X-RapidAPI-Host header
 * Base URL: https://musclewiki.p.rapidapi.com
 *
 * Response fields per exercise:
 *   name       — exercise name
 *   category   — muscle group category
 *   target     — target muscles array
 *   instructions — string[]
 *   video      — { male: string; female: string } (MP4 CDN URLs, stable)
 *
 * MuscleWiki URLs are stable CDN paths, safe to cache for 24 hours
 * and to persist in the database.
 *
 * Falls back gracefully when MUSCLEWIKI_API_KEY is not set.
 */
@Injectable()
export class MuscleWikiVideoProvider implements IExerciseVideoProvider {
  readonly name = 'musclewiki';
  private readonly logger = new Logger(MuscleWikiVideoProvider.name);
  private readonly apiKey: string | null;
  private readonly rapidApiHost = 'musclewiki.p.rapidapi.com';
  private readonly baseUrl: string;

  private localCache: Map<string, string> | null = null;
  private localCacheExpiresAt = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  private static readonly CATALOG_CACHE_KEY = 'exercise_video:musclewiki:catalog_v1';
  private static readonly CATALOG_TTL_SEC = 24 * 60 * 60; // 24 hours (URLs are stable)

  constructor(
    private readonly config: ConfigService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisClient: any | null,
  ) {
    this.apiKey = this.config.get<string>('MUSCLEWIKI_API_KEY') ?? null;
    this.baseUrl = `https://${this.rapidApiHost}`;
    this.redis = redisClient;
  }

  async getVideoUrl(exerciseName: string): Promise<string | null> {
    if (!this.apiKey) return null;
    const key = normaliseName(exerciseName);
    const catalog = await this.getCatalog();
    return catalog.get(key) ?? null;
  }

  private async getCatalog(): Promise<Map<string, string>> {
    // 1. Try Redis
    if (this.redis) {
      try {
        const raw = await this.redis.get(MuscleWikiVideoProvider.CATALOG_CACHE_KEY);
        if (raw) {
          const obj = JSON.parse(raw) as Record<string, string>;
          return new Map(Object.entries(obj));
        }
      } catch (err) {
        this.logger.warn('MuscleWiki: Redis read failed, falling back to API fetch', err);
      }
    }

    // 2. In-process fallback
    if (this.localCache && Date.now() < this.localCacheExpiresAt) {
      return this.localCache;
    }

    // 3. Fetch from MuscleWiki API
    return this.fetchAndCache();
  }

  private async fetchAndCache(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/exercises`;
      const res = await fetch(url, {
        headers: {
          'X-RapidAPI-Key': this.apiKey!,
          'X-RapidAPI-Host': this.rapidApiHost,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        this.logger.warn(
          `MuscleWiki catalog fetch failed: ${res.status} ${res.statusText}`,
        );
        return map;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exercises = (await res.json()) as any[];

      for (const ex of exercises) {
        const name: string = ex.name ?? '';
        if (!name) continue;
        // Prefer male video, fall back to female. Both are stable MP4 URLs.
        const videoUrl: string | undefined =
          ex.video?.male ?? ex.video?.female ?? ex.video_url ?? undefined;
        if (!videoUrl) continue;
        map.set(normaliseName(name), videoUrl);
      }

      this.logger.log(`MuscleWiki: cached ${map.size} exercises with video URLs`);

      const obj = Object.fromEntries(map);
      if (this.redis) {
        try {
          await this.redis.setex(
            MuscleWikiVideoProvider.CATALOG_CACHE_KEY,
            MuscleWikiVideoProvider.CATALOG_TTL_SEC,
            JSON.stringify(obj),
          );
        } catch (err) {
          this.logger.warn('MuscleWiki: Redis write failed', err);
        }
      }

      this.localCache = map;
      this.localCacheExpiresAt =
        Date.now() + MuscleWikiVideoProvider.CATALOG_TTL_SEC * 1000;
    } catch (err) {
      this.logger.warn('MuscleWiki: Failed to fetch exercise catalog', err);
    }
    return map;
  }
}

// ─── Fallback orchestrator ─────────────────────────────────────────────────

/**
 * ExerciseVideoFallbackService — tries providers in priority order and
 * caches the winning URL in Redis.
 *
 * Cache key: `exercise_video:url:<normalised-name>`
 * TTL:
 *   - YMove result  → 3 hours  (signed URLs expire in 48h)
 *   - MuscleWiki    → 24 hours (stable CDN URLs)
 *   - null sentinel → 6 hours  (re-try providers after 6h in case new
 *                               exercises are added)
 *
 * The null sentinel (`"__none__"`) prevents hammering both provider APIs
 * for every exercise that has no video match.
 */
@Injectable()
export class ExerciseVideoFallbackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExerciseVideoFallbackService.name);

  private readonly providers: IExerciseVideoProvider[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;

  private static readonly URL_CACHE_KEY_PREFIX = 'exercise_video:url:';
  private static readonly NULL_SENTINEL = '__none__';
  private static readonly TTL_YMOVE_SEC = 3 * 60 * 60;       // 3h
  private static readonly TTL_MUSCLEWIKI_SEC = 24 * 60 * 60;  // 24h
  private static readonly TTL_NONE_SEC = 6 * 60 * 60;         // 6h

  constructor(
    private readonly ymove: YMoveVideoProvider,
    private readonly muscleWiki: MuscleWikiVideoProvider,
    private readonly config: ConfigService,
  ) {
    this.providers = [this.ymove, this.muscleWiki];
  }

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { default: Redis } = await import('ioredis');
        this.redis = new Redis(redisUrl, { lazyConnect: true });
        await this.redis.connect();
        this.logger.log('ExerciseVideoFallbackService: Redis connected');

        // Pass the connected Redis client to providers so catalog fetches
        // also use shared cache.
        (this.ymove as unknown as { redis: unknown }).redis = this.redis;
        (this.muscleWiki as unknown as { redis: unknown }).redis = this.redis;
      } catch (err) {
        this.logger.warn(
          'ExerciseVideoFallbackService: Redis unavailable — video URL cache disabled',
          err,
        );
        this.redis = null;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }

  /**
   * Return a video URL for `exerciseName`, trying providers in order.
   * Results are cached in Redis using provider-appropriate TTLs.
   *
   * Returns null when no provider has a match (caller falls back to GIF).
   */
  async getVideoUrl(exerciseName: string): Promise<{ url: string | null; provider: string | null }> {
    const cacheKey =
      ExerciseVideoFallbackService.URL_CACHE_KEY_PREFIX + normaliseName(exerciseName);

    // 1. Check Redis cache first
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached !== null) {
          const url =
            cached === ExerciseVideoFallbackService.NULL_SENTINEL ? null : cached;
          const provider = url ? this.detectProvider(url) : null;
          return { url, provider };
        }
      } catch (err) {
        this.logger.warn('ExerciseVideoFallbackService: Redis read error', err);
      }
    }

    // 2. Try each provider in order
    for (const provider of this.providers) {
      try {
        const url = await provider.getVideoUrl(exerciseName);
        if (url) {
          const ttl = provider.name === 'ymove'
            ? ExerciseVideoFallbackService.TTL_YMOVE_SEC
            : ExerciseVideoFallbackService.TTL_MUSCLEWIKI_SEC;

          await this.cacheUrl(cacheKey, url, ttl);
          return { url, provider: provider.name };
        }
      } catch (err) {
        this.logger.warn(
          `ExerciseVideoFallbackService: provider "${provider.name}" threw for "${exerciseName}"`,
          err,
        );
      }
    }

    // 3. No match — cache the null sentinel
    await this.cacheUrl(
      cacheKey,
      ExerciseVideoFallbackService.NULL_SENTINEL,
      ExerciseVideoFallbackService.TTL_NONE_SEC,
    );
    return { url: null, provider: null };
  }

  private async cacheUrl(key: string, value: string, ttlSec: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.setex(key, ttlSec, value);
    } catch (err) {
      this.logger.warn('ExerciseVideoFallbackService: Redis write error', err);
    }
  }

  private detectProvider(url: string): string {
    if (url.includes('ymove') || url.includes('b-cdn.net')) return 'ymove';
    if (url.includes('musclewiki')) return 'musclewiki';
    return 'unknown';
  }

  /**
   * Invalidate the cached URL for a specific exercise.
   * Used by the enrichment script to force a re-fetch after a manual
   * correction or after a provider catalog update.
   */
  async invalidate(exerciseName: string): Promise<void> {
    if (!this.redis) return;
    const cacheKey =
      ExerciseVideoFallbackService.URL_CACHE_KEY_PREFIX + normaliseName(exerciseName);
    try {
      await this.redis.del(cacheKey);
    } catch (err) {
      this.logger.warn('ExerciseVideoFallbackService: Redis del error', err);
    }
  }
}
