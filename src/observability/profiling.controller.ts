import {
  Controller,
  Get,
  ForbiddenException,
  ServiceUnavailableException,
  UseGuards,
  Header,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { OwnerGuard } from '../common/guards/owner.guard';

/**
 * ProfilingController — GET /debug/profile
 *
 * Starts a 30-second V8 CPU profile and streams the result as a downloadable
 * JSON file.  This endpoint is:
 *
 *   - Guarded by OwnerGuard (OWNER role only)
 *   - Only active when PROFILE_ENABLED=on (defaults to off)
 *
 * The profile can be loaded into Chrome DevTools (Performance tab → Load
 * profile) or analysed with tools like `0x` and `speedscope`.
 *
 * v8-profiler-next is loaded dynamically so the module can boot without it
 * being in package.json — when PROFILE_ENABLED=off the dynamic require is
 * never reached and the binary is never needed.
 */
@ApiExcludeController()
@UseGuards(OwnerGuard)
@Controller('debug')
export class ProfilingController {
  @Get('profile')
  @Header('Content-Disposition', 'attachment; filename="cpu-profile.cpuprofile"')
  @Header('Content-Type', 'application/json')
  async profile(@Res() res: Response): Promise<void> {
    const enabled = (process.env.PROFILE_ENABLED ?? 'off').toLowerCase() === 'on';
    if (!enabled) {
      throw new ForbiddenException(
        'CPU profiling is disabled. Set PROFILE_ENABLED=on to enable.',
      );
    }

    // v8-profiler-next is an optional native addon.  If not installed the
    // endpoint returns 503 with a clear message so operators know what's missing.
    let profiler: { startProfiling: (n: string) => void; stopProfiling: (n: string) => { export: (cb: (err: Error | null, result: Buffer) => void) => void; delete: () => void } };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      profiler = require('v8-profiler-next');
    } catch {
      throw new ServiceUnavailableException(
        'v8-profiler-next is not installed. Run `npm install v8-profiler-next` on the server.',
      );
    }

    const PROFILE_DURATION_MS = 30_000;
    const label = `profile-${Date.now()}`;

    profiler.startProfiling(label);

    await new Promise<void>((resolve) => setTimeout(resolve, PROFILE_DURATION_MS));

    const profile = profiler.stopProfiling(label);

    await new Promise<void>((resolve, reject) => {
      profile.export((err: Error | null, result: Buffer) => {
        profile.delete();
        if (err) {
          reject(err);
          return;
        }
        res.send(result);
        resolve();
      });
    });
  }
}
