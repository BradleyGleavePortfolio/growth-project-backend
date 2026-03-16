import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma.service';

/**
 * JwtAuthGuard — Supabase ES256 Token Validation
 *
 * Supabase user session tokens are signed with ES256 (ECDSA P-256).
 * Standard passport-jwt with a HMAC secret cannot verify these tokens.
 *
 * This guard validates tokens directly using supabase.auth.getUser(token),
 * which performs the ES256 signature check internally. No new packages needed.
 *
 * Usage: @UseGuards(JwtAuthGuard) on any controller method.
 * After validation, req.user is set to the Prisma User record.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    // Extract Bearer token from Authorization header
    const authHeader: string = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    // Validate token via Supabase (handles ES256 verification internally)
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    );

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Look up the user in our database using Supabase UUID
    const user = await this.prisma.user.findUnique({
      where: { supabase_id: data.user.id },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Attach user to request (available as req.user in controllers)
    req.user = user;
    return true;
  }
}
