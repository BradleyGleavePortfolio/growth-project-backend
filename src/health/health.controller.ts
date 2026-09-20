import { Controller, Get, Header, HttpStatus, Logger, Res } from '@nestjs/common';
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
// The platform probe timeout does not cancel an unresolved Prisma query, so the
// handler bounds its own wait below that timeout and answers 503 explicitly
// instead of leaving one pending request per probe interval.
export const READINESS_TIMEOUT_MS = 3000;

/** Private marker so an ORM rejection is never misreported as a timeout. */
class ReadinessTimeout extends Error {
  constructor() {
    super('readiness_timeout');
    this.name = 'ReadinessTimeout';
  }
}

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
  @Header('Cache-Control', 'no-store')
  async readiness(@Res({ passthrough: true }) res: Response) {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Minimal round-trip; `$queryRaw` opens a real connection and exercises
      // the pool, unlike a no-op getter on the client.
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReadinessTimeout()), READINESS_TIMEOUT_MS);
        }),
      ]);
      return {
        ok: true,
        db: 'up',
        timestamp: new Date().toISOString(),
      };
    } catch (failure) {
      // Driver errors may contain credentials or query text. Readiness needs
      // only a stable signal, including when a rejection is not an Error.
      this.logger.error(
        failure instanceof ReadinessTimeout
          ? {
              event: 'readiness_database_timeout',
              operation: 'health.readiness',
              timeout_ms: READINESS_TIMEOUT_MS,
            }
          : {
              event: 'readiness_database_unavailable',
              operation: 'health.readiness',
            },
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        ok: false,
        db: 'down',
        error: 'database_unavailable',
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
