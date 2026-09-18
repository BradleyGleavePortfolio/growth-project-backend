import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma.service';

// Public probes must work without credentials; @Public bypasses authentication.
// /health is the legacy alias of /healthz. Both report process liveness without
// touching the database, so a database outage is not a reason to restart.
// /readyz reports success only after SELECT 1, or 503 after query rejection.
// fly.toml wires /readyz as a service-level routing check. A failed Fly check
// withdraws traffic but does not itself restart or stop the machine.
// The platform probe timeout does not cancel an unresolved Prisma query.
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @ApiOperation({
    summary: 'Liveness probe (legacy alias)',
    description: 'Unauthenticated. Equivalent to GET /healthz. Returns process uptime + timestamp.',
  })
  @ApiResponse({
    status: 200,
    description: '`{ ok: true, uptime: number, timestamp: ISO8601 }`',
  })
  @Get('health')
  check() {
    return this.liveness();
  }

  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Unauthenticated. Returns process uptime + timestamp.',
  })
  @ApiResponse({
    status: 200,
    description: '`{ ok: true, uptime: number, timestamp: ISO8601 }`',
  })
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
    } catch {
      // Driver errors may contain credentials or query text. Readiness needs
      // only a stable signal, including when a rejection is not an Error.
      this.logger.error({
        event: 'readiness_database_unavailable',
        operation: 'health.readiness',
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        ok: false,
        db: 'down',
        error: 'database_unavailable',
        timestamp: new Date().toISOString(),
      };
    }
  }
}
