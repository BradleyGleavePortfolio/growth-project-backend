/**
 * ExerciseLibraryService — bridges the Growth Project backend to the
 * ExerciseDB RapidAPI catalog.
 *
 * Caching strategy:
 *   • When REDIS_URL is set the service caches via ioredis with a 5-minute TTL.
 *   • When REDIS_URL is absent it falls back to an in-process LRU map (max 500
 *     entries, 5-minute TTL) so development environments and preview deploys
 *     work without Redis.
 *
 * Cache key format: `exercisedb:<sha256 of sorted query-param string>`
 *
 * All network traffic to ExerciseDB goes through this service.  The mobile
 * client never holds an ExerciseDB API key.
 */

import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Exercise,
  ExerciseSearchParams,
  ExerciseSearchResult,
} from './exercise.entity';
import { findSeedById, searchSeed } from './seed-catalog';
import * as crypto from 'crypto';

/** In-memory LRU cache entry. */
interface CacheEntry {
  value: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LRU_MAX_SIZE = 500;

@Injectable()
export class ExerciseLibraryService implements OnModuleInit {
  private readonly logger = new Logger(ExerciseLibraryService.name);
  private readonly apiKey: string;
  private readonly apiHost: string;
  private readonly baseUrl: string;

  /** In-memory LRU (insertion-order Map). Used when Redis is unavailable. */
  private readonly lru = new Map<string, CacheEntry>();

  /** ioredis client — populated in onModuleInit() if REDIS_URL is set. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;

  constructor(private readonly config: ConfigService) {
    // Use config.get() so the OpenAPI test (which boots AppModule without all
    // env vars set) does not throw during DI construction. A missing key is
    // caught at the first actual API call in fetchApi().
    this.apiKey = this.config.get<string>('EXERCISEDB_API_KEY') ?? '';
    this.apiHost =
      this.config.get<string>('EXERCISEDB_API_HOST') ?? 'exercisedb.p.rapidapi.com';
    this.baseUrl = `https://${this.apiHost}`;
  }

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) {
      try {
        // Dynamic import so the module compiles even if ioredis is absent.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { default: Redis } = await import('ioredis');
        this.redis = new Redis(redisUrl, { lazyConnect: true });
        await this.redis.connect();
        this.logger.log('ExerciseLibraryService: Redis cache connected');
      } catch (err) {
        this.logger.warn(
          'ExerciseLibraryService: Redis unavailable, falling back to in-memory LRU',
          err,
        );
        this.redis = null;
      }
    } else {
      this.logger.log('ExerciseLibraryService: No REDIS_URL — using in-memory LRU cache');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Search the ExerciseDB catalog.  Returns a paginated result set.
   * Cursor is an opaque base64-encoded offset integer.
   */
  async searchExercises(params: ExerciseSearchParams): Promise<ExerciseSearchResult> {
    const limit = Math.min(params.limit ?? 20, 100);
    const offset = params.cursor ? this.decodeCursor(params.cursor) : 0;

    // Seed-catalog fallback. Used when no EXERCISEDB_API_KEY is set so
    // the workout builder is functional on day one without an external
    // dependency. Once a key is configured the proxy below takes over.
    if (!this.apiKey) {
      const seedKey = this.buildCacheKey('seed-search', { ...params, limit, offset });
      const seedCached = await this.getCache<ExerciseSearchResult>(seedKey);
      if (seedCached) return seedCached;
      const { items, total } = searchSeed({
        q: params.q,
        muscleGroup: params.muscleGroup,
        equipment: params.equipment,
        limit,
        offset,
      });
      const nextCursor =
        offset + items.length < total ? this.encodeCursor(offset + limit) : null;
      const result: ExerciseSearchResult = { items, nextCursor, total };
      await this.setCache(seedKey, result);
      return result;
    }

    const cacheKey = this.buildCacheKey('search', { ...params, limit, offset });
    const cached = await this.getCache<ExerciseSearchResult>(cacheKey);
    if (cached) return cached;

    let exercises: Exercise[] = [];

    if (params.q) {
      // ExerciseDB search by name
      const raw = await this.fetchApi<Exercise[]>(
        `/exercises/name/${encodeURIComponent(params.q.toLowerCase())}`,
        { limit: String(100), offset: String(0) },
      );
      exercises = raw;
    } else if (params.muscleGroup) {
      const raw = await this.fetchApi<Exercise[]>(
        `/exercises/bodyPart/${encodeURIComponent(params.muscleGroup.toLowerCase())}`,
        { limit: String(100), offset: String(0) },
      );
      exercises = raw;
    } else if (params.equipment) {
      const raw = await this.fetchApi<Exercise[]>(
        `/exercises/equipment/${encodeURIComponent(params.equipment.toLowerCase())}`,
        { limit: String(100), offset: String(0) },
      );
      exercises = raw;
    } else {
      // Unfiltered browse — use offset pagination directly
      const raw = await this.fetchApi<Exercise[]>('/exercises', {
        limit: String(limit),
        offset: String(offset),
      });
      const nextCursor =
        raw.length === limit ? this.encodeCursor(offset + limit) : null;
      const result: ExerciseSearchResult = {
        items: raw,
        nextCursor,
        total: raw.length, // ExerciseDB doesn't return total count on unfiltered
      };
      await this.setCache(cacheKey, result);
      return result;
    }

    // Apply equipment filter on top of name/muscleGroup results
    if (params.equipment && params.q) {
      const eq = params.equipment.toLowerCase();
      exercises = exercises.filter((e) => e.equipment.toLowerCase() === eq);
    }
    if (params.muscleGroup && params.q) {
      const mg = params.muscleGroup.toLowerCase();
      exercises = exercises.filter(
        (e) =>
          e.bodyPart.toLowerCase() === mg ||
          e.target.toLowerCase() === mg,
      );
    }

    const total = exercises.length;
    const page = exercises.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < total ? this.encodeCursor(offset + limit) : null;

    const result: ExerciseSearchResult = { items: page, nextCursor, total };
    await this.setCache(cacheKey, result);
    return result;
  }

  /** Fetch a single exercise by id. seed: ids are resolved locally;
   * everything else proxies to ExerciseDB. When no API key is set,
   * non-seed ids return 404 rather than the env-var error. */
  async getExerciseById(id: string): Promise<Exercise> {
    if (id.startsWith('seed:')) {
      const seed = findSeedById(id);
      if (!seed) throw new NotFoundException(`Exercise with id "${id}" not found`);
      return seed;
    }
    if (!this.apiKey) {
      throw new NotFoundException(`Exercise with id "${id}" not found`);
    }
    const cacheKey = this.buildCacheKey('byId', { id });
    const cached = await this.getCache<Exercise>(cacheKey);
    if (cached) return cached;

    const exercise = await this.fetchApi<Exercise>(`/exercises/exercise/${encodeURIComponent(id)}`);
    if (!exercise || !exercise.id) {
      throw new NotFoundException(`Exercise with id "${id}" not found`);
    }
    await this.setCache(cacheKey, exercise);
    return exercise;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchApi<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!this.apiKey) {
      throw new Error(
        'EXERCISEDB_API_KEY is not configured. Set the env var to enable exercise catalog features.',
      );
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-rapidapi-key': this.apiKey,
        'x-rapidapi-host': this.apiHost,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `ExerciseDB API error ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return response.json() as Promise<T>;
  }

  private buildCacheKey(prefix: string, params: Record<string, unknown>): string {
    const sorted = JSON.stringify(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    const hash = crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
    return `exercisedb:${prefix}:${hash}`;
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString('base64url');
  }

  private decodeCursor(cursor: string): number {
    try {
      return parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10) || 0;
    } catch {
      return 0;
    }
  }

  private async getCache<T>(key: string): Promise<T | null> {
    try {
      if (this.redis) {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      }
      const entry = this.lru.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        this.lru.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  private async setCache(key: string, value: unknown): Promise<void> {
    const serialised = JSON.stringify(value);
    try {
      if (this.redis) {
        await this.redis.set(key, serialised, 'PX', CACHE_TTL_MS);
        return;
      }
      // LRU eviction — remove oldest entry when at capacity
      if (this.lru.size >= LRU_MAX_SIZE) {
        const oldest = this.lru.keys().next().value;
        if (oldest !== undefined) this.lru.delete(oldest);
      }
      this.lru.set(key, { value: serialised, expiresAt: Date.now() + CACHE_TTL_MS });
    } catch {
      // Cache write failure is non-fatal.
    }
  }
}
