import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * ServiceTokenGuard — accepts requests carrying a pre-shared service token
 * in the Authorization: Bearer <token> header.
 *
 * Used exclusively for server-to-server calls from the owner console
 * Next.js app, where a Supabase JWT is not available (SSR context).
 *
 * The token must be set as ADMIN_SERVICE_TOKEN in the backend's environment.
 * If ADMIN_SERVICE_TOKEN is not set, this guard rejects all requests
 * (fail-secure).
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedToken = process.env.ADMIN_SERVICE_TOKEN;
    if (!expectedToken) {
      throw new UnauthorizedException('Service token not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== expectedToken) {
      throw new UnauthorizedException('Invalid service token');
    }

    return true;
  }
}
