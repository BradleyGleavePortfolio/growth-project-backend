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
      redisStatus = await this.checkRedis(process.env.REDIS_URL, errors);
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

  /**
   * Fire a single PING to Redis using a throwaway ioredis client.
   * ioredis is already in package.json (used by the throttler).
   * We create a dedicated client so we don't contaminate the throttler pool.
   */
  private async checkRedis(
    url: string,
    errors: string[],
  ): Promise<'up' | 'down'> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis') as typeof import('ioredis').default;
      const client = new Redis(url, {
        connectTimeout: 2000,
        commandTimeout: 2000,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      const pong = await client.ping();
      client.disconnect();
      if (pong !== 'PONG') {
        errors.push('redis: unexpected PING response');
        return 'down';
      }
      return 'up';
    } catch (err) {
      errors.push(`redis: ${err instanceof Error ? err.message : String(err)}`);
      return 'down';
    }
  }
}
