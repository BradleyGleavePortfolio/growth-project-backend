import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../../prisma.service';

type RequestWithUser = Request & {
  user?: { id?: string | null };
};

/**
 * RlsContextMiddleware
 *
 * Sets the PostgreSQL session variable consumed by RLS policies:
 *   app.current_user_id = req.user.id
 *
 * This is defense-in-depth for any future non-service-role database path. The
 * current Prisma connection uses Supabase service_role/BYPASSRLS, so app traffic
 * is not blocked by RLS; direct dashboard/Studio access and accidental anon-key
 * paths are still constrained by the SQL policies.
 *
 * IMPORTANT: Nest middleware normally runs before guards. Keep this middleware
 * registered after any authentication middleware/guard path that populates
 * req.user, or convert it to an interceptor/guard if the app remains on global
 * APP_GUARD auth. It is intentionally no-op for public routes with no req.user.
 */
@Injectable()
export class RlsContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RlsContextMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  async use(req: RequestWithUser, res: Response, next: NextFunction): Promise<void> {
    const userId = req.user?.id;

    if (!userId) {
      next();
      return;
    }

    try {
      await this.prisma.$executeRaw`
        SELECT set_config('app.current_user_id', ${userId}, false)
      `;
    } catch (error) {
      this.logger.error('Failed to set RLS context for request', error instanceof Error ? error.stack : String(error));
      next(error);
      return;
    }

    res.on('finish', () => {
      void this.clearContext(userId);
    });
    res.on('close', () => {
      void this.clearContext(userId);
    });

    next();
  }

  private async clearContext(userId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        SELECT set_config('app.current_user_id', '', false)
      `;
    } catch (error) {
      this.logger.warn(
        `Failed to clear RLS context after request for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
