import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import { JwksVerifierService } from './jwks.service';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

/**
 * JwtAuthGuard — Supabase ES256 token validation via JWKS.
 *
 * Previous implementation called `supabase.auth.getUser(token)` on every
 * authenticated request, which round-tripped to Supabase Auth (~100–200ms)
 * for every API call. Under load that turned every endpoint into a fan-out
 * to a single shared dependency.
 *
 * Now: tokens are verified locally against Supabase's published JWK set
 * (see JwksVerifierService). Verification cost is microseconds, the JWKS
 * endpoint is hit at most a handful of times per process per hour, and
 * key rotation is handled automatically by `jose.createRemoteJWKSet`.
 *
 * Registered globally as APP_GUARD: every route is authenticated by
 * default; routes that must be reachable without a JWT opt out with
 * `@Public()`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private jwks: JwksVerifierService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();

    const authHeader: string = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('No authentication token provided');
    }

    let payload;
    try {
      payload = await this.jwks.verify(token);
    } catch {
      // The verifier already logged the specific reason; we don't echo it
      // back to the client to avoid leaking auth-system internals.
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Supabase access tokens carry the user's auth UUID in `sub`.
    const supabaseId = typeof payload.sub === 'string' ? payload.sub : null;
    if (!supabaseId) {
      throw new UnauthorizedException('Token missing subject claim');
    }

    const user = await this.prisma.user.findUnique({
      where: { supabase_id: supabaseId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    req.user = user;
    return true;
  }
}
