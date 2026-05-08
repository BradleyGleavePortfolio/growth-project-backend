import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';

/**
 * HealthDeepController — adds GET /health/deep.
 *
 * Fly.io's load balancer hits /health (shallow, already in HealthController)
 * to decide whether to restart a machine.  /health/deep is for engineers and
 * external uptime monitors that need to know whether the downstream
 * dependencies (DB, Redis if configured) are healthy.
 *
 * Both endpoints are @Public() and must never be auth-gated — the Fly load
 * balancer does not carry a JWT.
 *
 * Response shape:
 *   200: { ok: true,  db: "up",   redis: "up"|"unconfigured",  timestamp }
 *   503: { ok: false, db: "down", redis: "...",                timestamp, errors: [] }
 */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthDeepController {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  @Get('deep')
  async deep(@Res({ passthrough: true }) res: Response) {
    const errors: string[] = [];
    let dbStatus: 'up' | 'down' = 'up';
    let redisStatus: 'up' | 'down' | 'unconfigured' = 'unconfigured';

    // -- DB check --
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbStatus = 'down';
      errors.push(`db: ${err instanceof Error ? err.message : String(err)}`);
    }

    // -- Redis check (optional — only when REDIS_URL is set) --
    if (process.env.REDIS_URL) {
      try {
        // Dynamic import so we don't hard-require ioredis when Redis is off.
        // ioredis is already in package.json (used by the throttler).
        // We create a throwaway client for a single PING to avoid cross-
        // contaminating the throttler's connection pool.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { default: Redis } = require('ioredis') as { default: new (url: string, opts: object) => { ping: () => Promise<string>; disconnect: () => void } };
        const client = new Redis(process.env.REDIS_URL, {
          connectTimeout: 2000,
          commandTimeout: 2000,
          maxRetriesPerRequest: 0,
          enableOfflineQueue: false,
          lazyConnect: true,
        });
        const pong = await client.ping();
        client.disconnect();
        redisStatus = pong === 'PONG' ? 'up' : 'down';
        if (redisStatus === 'down') errors.push('redis: unexpected PING response');
      } catch (err) {
        redisStatus = 'down';
        errors.push(`redis: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ok = errors.length === 0;
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      ok,
      db: dbStatus,
      redis: redisStatus,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      ...(errors.length ? { errors } : {}),
    };
  }
}
