import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

// Unauthenticated liveness probe for Fly.io and other uptime checks.
// Intentionally has no guards — health checks must work without credentials.
@Public()
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  check() {
    return {
      ok: true,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }
}
