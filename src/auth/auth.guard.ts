import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader: string = req.headers?.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No authentication token provided');
    }
    const token = authHeader.slice(7).trim();
    const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) { throw new UnauthorizedException('Invalid or expired token'); }
    const user = await this.prisma.user.findUnique({ where: { supabase_id: data.user.id } });
    if (!user) { throw new UnauthorizedException('User not found'); }
    req.user = user;
    return true;
  }
}
