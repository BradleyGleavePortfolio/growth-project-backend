import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';

// Unauthenticated health probes for Fly.io and other uptime checks.
// Intentionally have no guards — health checks must work without credentials.
//
// Three endpoints, three different semantics (audit M-3):
//
//   GET /health   — legacy alias kept for backwards compatibility with the
//                   existing Fly check. Equivalent to /healthz.
//   GET /healthz  — liveness. Returns 200 unconditionally as long as the
//                   process is up and the event loop is responsive. Used by
//                   the platform to decide whether to restart the machine.
//   GET /readyz   — readiness. Returns 200 only when the DB is reachable
//                   (a quick `SELECT 1`). Returns 503 otherwise so that load
//                   balancers can stop sending traffic to a machine whose
//                   DB connection is down without restarting it.
@Public()
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  check() {
    return this.liveness();
  }

  @Get('healthz')
  liveness() {
    return {
      ok: true,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readyz')
  async readiness(@Res({ passthrough: true }) res: Response) {
    try {
      // Minimal round-trip; `$queryRaw` opens a real connection and exercises
      // the pool, unlike a no-op getter on the client.
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        db: 'up',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        ok: false,
        db: 'down',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };
    }
  }
}
